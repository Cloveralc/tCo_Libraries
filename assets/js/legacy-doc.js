async function legacyDocText(file) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const specialSectorStart = 0xfffffffa;
	const fail = message => { throw new Error(message); };
	const u16 = (source, offset) => {
		if (offset < 0 || offset + 2 > source.length) fail('文件结构不完整。');
		return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint16(offset, true);
	};
	const u32 = (source, offset) => {
		if (offset < 0 || offset + 4 > source.length) fail('文件结构不完整。');
		return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, true);
	};
	const concat = (chunks, limit = null) => {
		let length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		if (limit !== null) length = Math.min(length, limit);
		const result = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			if (offset >= length) break;
			const part = chunk.subarray(0, Math.min(chunk.length, length - offset));
			result.set(part, offset);
			offset += part.length;
		}
		return result;
	};

	if (bytes.length < 512 || ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value)) {
		fail('这不是可识别的旧版 Word 文档。');
	}
	const sectorSize = 1 << u16(bytes, 30);
	const miniSectorSize = 1 << u16(bytes, 32);
	if (![512, 4096].includes(sectorSize) || miniSectorSize !== 64) fail('不支持此 Word 文档的存储格式。');
	const sectorCount = Math.floor(bytes.length / sectorSize) - 1;
	const sectorOffset = sector => {
		if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) fail('Word 文档的扇区索引无效。');
		return (sector + 1) * sectorSize;
	};
	const fatSectorCount = u32(bytes, 44);
	const firstDirectorySector = u32(bytes, 48);
	const miniStreamCutoff = u32(bytes, 56);
	const firstMiniFatSector = u32(bytes, 60);
	const miniFatSectorCount = u32(bytes, 64);
	const firstDifatSector = u32(bytes, 68);
	const difatSectorCount = u32(bytes, 72);
	const fatSectors = [];
	for (let offset = 76; offset < 512; offset += 4) {
		const sector = view.getUint32(offset, true);
		if (sector < specialSectorStart) fatSectors.push(sector);
	}
	let difatSector = firstDifatSector;
	const seenDifat = new Set();
	for (let index = 0; index < difatSectorCount && difatSector < specialSectorStart; index++) {
		if (seenDifat.has(difatSector)) fail('Word 文档的扇区目录出现循环。');
		seenDifat.add(difatSector);
		const start = sectorOffset(difatSector);
		const entriesPerDifat = sectorSize / 4 - 1;
		for (let entry = 0; entry < entriesPerDifat; entry++) {
			const sector = view.getUint32(start + entry * 4, true);
			if (sector < specialSectorStart) fatSectors.push(sector);
		}
		difatSector = view.getUint32(start + entriesPerDifat * 4, true);
	}
	if (!fatSectorCount || fatSectors.length < fatSectorCount) fail('Word 文档缺少必要的数据目录。');
	fatSectors.length = fatSectorCount;
	const fat = new Uint32Array(fatSectorCount * sectorSize / 4);
	let fatIndex = 0;
	for (const sector of fatSectors) {
		const start = sectorOffset(sector);
		for (let offset = 0; offset < sectorSize; offset += 4) fat[fatIndex++] = view.getUint32(start + offset, true);
	}
	function readFatChain(firstSector, byteLimit = null) {
		if (byteLimit === 0) return new Uint8Array();
		if (firstSector >= specialSectorStart) fail('Word 文档的数据流索引无效。');
		const chunks = [];
		const seen = new Set();
		let sector = firstSector;
		let total = 0;
		while (sector < specialSectorStart) {
			if (sector >= fat.length || seen.has(sector)) fail('Word 文档的数据流链无效。');
			seen.add(sector);
			const start = sectorOffset(sector);
			const chunk = bytes.subarray(start, start + sectorSize);
			chunks.push(chunk);
			total += chunk.length;
			if (byteLimit !== null && total >= byteLimit) break;
			sector = fat[sector];
		}
		if (byteLimit !== null && total < byteLimit) fail('Word 文档的数据流被截断。');
		return concat(chunks, byteLimit);
	}
	const directory = readFatChain(firstDirectorySector);
	const streams = Object.create(null);
	let rootEntry = null;
	for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
		const type = directory[offset + 66];
		if (type !== 1 && type !== 2 && type !== 5) continue;
		const nameLength = u16(directory, offset + 64);
		let name = '';
		for (let position = 0; position + 1 < nameLength - 2 && position < 64; position += 2) name += String.fromCharCode(u16(directory, offset + position));
		const start = u32(directory, offset + 116);
		const size = u32(directory, offset + 120) + u32(directory, offset + 124) * 0x100000000;
		const entry = { name, type, start, size };
		if (type === 5) rootEntry = entry;
		else if (type === 2 && name) streams[name] = entry;
	}
	if (!rootEntry) fail('Word 文档的数据目录无法读取。');
	const miniStream = rootEntry.size ? readFatChain(rootEntry.start, rootEntry.size) : new Uint8Array();
	const miniFatBytes = miniFatSectorCount ? readFatChain(firstMiniFatSector, miniFatSectorCount * sectorSize) : new Uint8Array();
	const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
	for (let index = 0; index < miniFat.length; index++) miniFat[index] = u32(miniFatBytes, index * 4);
	function getStream(entry) {
		if (!entry.size) return new Uint8Array();
		if (entry.size >= miniStreamCutoff) return readFatChain(entry.start, entry.size);
		const chunks = [];
		const seen = new Set();
		let sector = entry.start;
		let total = 0;
		while (sector < specialSectorStart && total < entry.size) {
			if (sector >= miniFat.length || seen.has(sector)) fail('Word 文档的微型数据流无效。');
			seen.add(sector);
			const start = sector * miniSectorSize;
			if (start >= miniStream.length) fail('Word 文档的微型数据流被截断。');
			const chunk = miniStream.subarray(start, Math.min(start + miniSectorSize, miniStream.length));
			chunks.push(chunk);
			total += chunk.length;
			sector = miniFat[sector];
		}
		if (total < entry.size) fail('Word 文档的微型数据流被截断。');
		return concat(chunks, entry.size);
	}
	const wordEntry = streams.WordDocument;
	if (!wordEntry) fail('Word 文档正文数据不存在。');
	const word = getStream(wordEntry);
	if (word.length < 32 || u16(word, 0) !== 0xa5ec) fail('无法识别此 Word 文档版本。');
	const nFib = u16(word, 2);
	if (nFib < 0x00c1) fail('此文件属于 Word 6/95 或更早格式，暂不支持。');
	const flags = u16(word, 10);
	if (flags & 0x8100) fail('加密或受保护的 Word 文档暂不支持预览。');
	let position = 0x20;
	const csw = u16(word, position);
	position += 2 + csw * 2;
	const cslw = u16(word, position);
	position += 2;
	const fibRgLwStart = position;
	position += cslw * 4;
	if (fibRgLwStart + 16 > word.length) fail('Word 文档正文索引不完整。');
	const mainTextLength = u32(word, fibRgLwStart + 12);
	const fibPairCount = u16(word, position);
	const fibRgFcLcbStart = position + 2;
	const clxPair = fibRgFcLcbStart + 33 * 8;
	if (fibPairCount <= 33 || clxPair + 8 > word.length) fail('Word 文档正文索引不完整。');
	const clxOffset = u32(word, clxPair);
	const clxLength = u32(word, clxPair + 4);
	if (!clxLength) fail('Word 文档不包含可读取的正文。');
	const tableEntry = streams[flags & 0x0200 ? '1Table' : '0Table'] || streams[flags & 0x0200 ? '0Table' : '1Table'];
	if (!tableEntry) fail('Word 文档的正文目录不存在。');
	const table = getStream(tableEntry);
	if (clxOffset >= table.length || clxLength > table.length - clxOffset) fail('Word 文档的正文目录不完整。');
	let cursor = clxOffset;
	const clxEnd = clxOffset + clxLength;
	let pieceTableOffset = -1;
	let pieceTableLength = 0;
	while (cursor < clxEnd) {
		const type = table[cursor++];
		if (type === 0x01) {
			if (cursor + 2 > clxEnd) fail('Word 文档的字符格式目录不完整。');
			const length = u16(table, cursor);
			cursor += 2 + length;
		} else if (type === 0x02) {
			if (cursor + 4 > clxEnd) fail('Word 文档的正文目录不完整。');
			pieceTableLength = u32(table, cursor);
			pieceTableOffset = cursor + 4;
			break;
		} else fail('Word 文档的正文目录格式无效。');
	}
	if (pieceTableOffset < 0 || pieceTableLength < 16 || pieceTableLength > table.length - pieceTableOffset) fail('Word 文档的正文目录格式无效。');
	const pieceCount = (pieceTableLength - 4) / 12;
	if (!Number.isInteger(pieceCount) || pieceCount < 1) fail('Word 文档没有可读取的正文段落。');
	const pieceStart = pieceTableOffset + (pieceCount + 1) * 4;
	const compressedMap = [0x0080, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x008e, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x009e, 0x0178];
	const pieces = [];
	for (let index = 0; index < pieceCount; index++) {
		const cpStart = u32(table, pieceTableOffset + index * 4);
		const cpEnd = u32(table, pieceTableOffset + (index + 1) * 4);
		const rawOffset = u32(table, pieceStart + index * 8 + 2);
		if (cpEnd < cpStart) fail('Word 文档的段落顺序无效。');
		const compressed = !!(rawOffset & 0x40000000);
		const raw = rawOffset & 0x3fffffff;
		pieces.push({ cpStart, cpEnd, offset: compressed ? Math.floor(raw / 2) : raw, compressed });
	}
	const output = [];
	const fieldStack = [];
	function appendCharacter(code) {
		if (code === 0x09 || code === 0x07) { output.push('\t'); return; }
		if (code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d) { output.push('\n'); return; }
		if (code === 0x1e) { output.push('-'); return; }
		if (code === 0x1f || code === 0x01 || code === 0x02 || code === 0x03 || code === 0x04 || code === 0x05 || code === 0x08 || code < 0x20) return;
		output.push(String.fromCharCode(code === 0xa0 ? 0x00a0 : code));
	}
	for (const piece of pieces) {
		const startCp = Math.max(0, piece.cpStart);
		const endCp = Math.min(mainTextLength, piece.cpEnd);
		if (endCp <= startCp) continue;
		const count = endCp - startCp;
		const byteStart = piece.offset + (piece.compressed ? startCp - piece.cpStart : (startCp - piece.cpStart) * 2);
		const byteLength = count * (piece.compressed ? 1 : 2);
		if (byteStart < 0 || byteStart + byteLength > word.length) fail('Word 文档的正文内容被截断。');
		for (let index = 0; index < count; index++) {
			let code;
			if (piece.compressed) {
				const byte = word[byteStart + index];
				code = byte < 0x80 ? byte : byte <= 0x9f ? compressedMap[byte - 0x80] : byte;
			} else code = u16(word, byteStart + index * 2);
			if (code === 0x13) { fieldStack.push(true); continue; }
			if (code === 0x14) { if (fieldStack.length) fieldStack[fieldStack.length - 1] = false; continue; }
			if (code === 0x15) { if (fieldStack.length) fieldStack.pop(); continue; }
			if (fieldStack.includes(true)) continue;
			appendCharacter(code);
		}
	}
	return output.join('').replace(/[\t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}
