class WorkerFileSource {
  constructor(file) { this.file = file; this.size = file.size; }
  async read(byteStart, byteEnd, signal) {
    const start = Math.max(0, Math.min(this.size, byteStart));
    const end = Math.max(start, Math.min(this.size, byteEnd));
    if (end <= start) return new Uint8Array(0);
    if (typeof this.file.slice === 'function') return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
    if (!this.file.url) throw new Error('TXT source has no readable byte range.');
    const response = await fetch(this.file.url, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: 'no-store', signal });
    if (response.status !== 206) {
      try { await response.body?.cancel(); } catch {}
      throw new Error('TXT source does not support ranged reads.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start) throw new Error('TXT source returned an incomplete byte range.');
    return bytes;
  }
}

const PAGE_BYTES = 512 * 1024;
const utf8Encoder = new TextEncoder();
let activeSession = null;

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'init') {
    if (activeSession) {
      activeSession.cancelled = true;
      activeSession.initController.abort();
      for (const controller of activeSession.rangeControllers.values()) controller.abort();
    }
    const session = {
      sessionId: message.sessionId,
      requestId: message.requestId,
      source: new WorkerFileSource(message.file),
      encoding: '',
      bomOffset: 0,
      cancelled: false,
      cancelledRanges: new Set(),
      activeRanges: new Set(),
      rangeControllers: new Map(),
      initController: new AbortController(),
      performanceEnabled: !!message.performanceEnabled,
      chunkBytes: Math.max(65536, Number(message.chunkBytes) || PAGE_BYTES),
      maxChars: Math.max(4096, Number(message.maxChars) || 64 * 1024)
    };
    activeSession = session;
    void initialize(session);
    return;
  }

  const session = activeSession;
  if (!session || message.sessionId !== session.sessionId || message.requestId !== session.requestId) return;
  if (message.type === 'cancel') {
    session.cancelled = true;
    session.cancelledRanges.clear();
    session.initController.abort();
    for (const controller of session.rangeControllers.values()) controller.abort();
    return;
  }
  if (message.type === 'cancel-page') {
    if (session.activeRanges.has(message.rangeId)) {
      session.cancelledRanges.add(message.rangeId);
      session.rangeControllers.get(message.rangeId)?.abort();
    }
    return;
  }
  if (message.type === 'performance') {
    session.performanceEnabled = !!message.enabled;
    return;
  }
  if (message.type === 'read-page') void readPage(session, message.page, message.rangeId);
};

function isActive(session) {
  return activeSession === session && !session.cancelled;
}
function isRangeActive(session, rangeId) {
  return isActive(session) && !session.cancelledRanges.has(rangeId);
}

async function detectEncoding(session) {
  const head = await session.source.read(0, Math.min(3, session.source.size), session.initController.signal);
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bomOffset: 2, replacementRatio: 0 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bomOffset: 2, replacementRatio: 0 };
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', bomOffset: 3, replacementRatio: 0 };

  const sample = await session.source.read(0, Math.min(64 * 1024, session.source.size), session.initController.signal);
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(sample, { stream: true });
    return { encoding: 'utf-8', bomOffset: 0, replacementRatio: 0 };
  } catch {
    for (const encoding of ['gb18030', 'gbk']) {
      try {
        const decoded = new TextDecoder(encoding, { fatal: false }).decode(sample);
        const replacementRatio = (decoded.match(/\uFFFD/g) || []).length / Math.max(1, decoded.length);
        if (replacementRatio <= 0.02) return { encoding, bomOffset: 0, replacementRatio };
      } catch {}
    }
    return { fallback: true, encoding: 'gb18030', bomOffset: 0, replacementRatio: 1 };
  }
}

async function initialize(session) {
  try {
    const detected = await detectEncoding(session);
    if (!isActive(session)) return;
    if (detected.fallback) {
      self.postMessage({
        type: 'fallback', sessionId: session.sessionId, requestId: session.requestId,
        encoding: detected.encoding, replacementRatio: detected.replacementRatio
      });
      return;
    }
    session.encoding = detected.encoding;
    session.bomOffset = detected.bomOffset;
    try { new TextDecoder(session.encoding); }
    catch {
      self.postMessage({ type: 'fallback', sessionId: session.sessionId, requestId: session.requestId, encoding: session.encoding });
      return;
    }
    self.postMessage({
      type: 'initialized', sessionId: session.sessionId, requestId: session.requestId,
      encoding: session.encoding, byteLength: session.source.size,
      bomOffset: session.bomOffset, pageBytes: PAGE_BYTES,
      pageCount: Math.max(1, Math.ceil(session.source.size / PAGE_BYTES)),
      sampleBytes: Math.min(64 * 1024, session.source.size),
      replacementRatio: detected.replacementRatio
    });
    void readPage(session, 0, 0);
  } catch (error) {
    if (isActive(session)) self.postMessage({
      type: 'error', sessionId: session.sessionId, requestId: session.requestId,
      message: String(error?.message || error)
    });
  }
}

function findLineEnd(bytes, encoding, absoluteStart, nominalOffset) {
  const base = encoding === 'utf-16le' || encoding === 'utf-16be' ? absoluteStart + ((nominalOffset - absoluteStart) & ~1) : nominalOffset;
  const relative = Math.max(0, base - absoluteStart);
  const unit = encoding === 'utf-16le' || encoding === 'utf-16be' ? 2 : 1;
  const isUtf16Le = encoding === 'utf-16le';
  for (let index = relative; index + unit <= bytes.length; index += unit) {
    const isLf = unit === 1 ? bytes[index] === 0x0a : isUtf16Le ? bytes[index] === 0x0a && bytes[index + 1] === 0 : bytes[index] === 0 && bytes[index + 1] === 0x0a;
    const isCr = unit === 1 ? bytes[index] === 0x0d : isUtf16Le ? bytes[index] === 0x0d && bytes[index + 1] === 0 : bytes[index] === 0 && bytes[index + 1] === 0x0d;
    if (isCr || isLf) {
      let end = index + unit;
      if (isCr && end + unit <= bytes.length) {
        const nextLf = unit === 1 ? bytes[end] === 0x0a : isUtf16Le ? bytes[end] === 0x0a && bytes[end + 1] === 0 : bytes[end] === 0 && bytes[end + 1] === 0x0a;
        if (nextLf) end += unit;
      }
      return absoluteStart + end;
    }
  }
  return base;
}

function safePageBoundary(bytes, encoding, absoluteStart, nominalOffset) {
  const relative = nominalOffset - absoluteStart;
  if (encoding === 'utf-8') {
    let offset = Math.max(0, relative);
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80 && offset - relative < 4) offset++;
    return absoluteStart + offset;
  }
  if (encoding === 'gbk' || encoding === 'gb18030') {
    const start = Math.max(0, relative - 4);
    for (let index = start; index < relative; index++) {
      const width = gbCharacterBytes(bytes, index);
      if (width > 1 && index + width > relative) return absoluteStart + index + width;
    }
    return nominalOffset;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const aligned = Math.max(0, relative - (relative & 1));
    const isLe = encoding === 'utf-16le';
    const previous = isLe ? bytes[aligned - 2] | bytes[aligned - 1] << 8 : bytes[aligned - 2] << 8 | bytes[aligned - 1];
    const next = isLe ? bytes[aligned] | bytes[aligned + 1] << 8 : bytes[aligned] << 8 | bytes[aligned + 1];
    return absoluteStart + aligned + (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 0);
  }
  return nominalOffset;
}

async function pageByteRange(session, page, signal) {
  const pageStart = page * PAGE_BYTES;
  const pageEnd = Math.min(session.source.size, (page + 1) * PAGE_BYTES);
  const findBoundary = async nominal => {
    if (nominal <= session.bomOffset) return session.bomOffset;
    const scanLimit = Math.min(session.source.size, nominal + Math.max(64 * 1024, session.maxChars * 4));
    const readStart = session.encoding === 'utf-16le' || session.encoding === 'utf-16be'
      ? session.bomOffset + Math.max(0, Math.floor((nominal - session.bomOffset) / 2) * 2 - 2)
      : session.encoding === 'utf-8' ? Math.max(session.bomOffset, nominal - 3)
        : Math.max(session.bomOffset, nominal - 4);
    const bytes = await session.source.read(readStart, scanLimit, signal);
    const lineEnd = findLineEnd(bytes, session.encoding, readStart, nominal);
    return lineEnd === nominal ? safePageBoundary(bytes, session.encoding, readStart, nominal) : lineEnd;
  };
  const start = page === 0 ? session.bomOffset : await findBoundary(pageStart);
  const end = pageEnd >= session.source.size ? session.source.size : await findBoundary(pageEnd);
  return { start: Math.min(start, session.source.size), end: Math.max(Math.min(end, session.source.size), Math.min(start, session.source.size)) };
}

function encodedByteLength(text, encoding) {
  return encoding === 'utf-16le' || encoding === 'utf-16be' ? text.length * 2 : utf8Encoder.encode(text).byteLength;
}

function safeTextCut(text, limit) {
  const newline = Math.max(text.lastIndexOf('\n', limit - 1), text.lastIndexOf('\r', limit - 1));
  let cut = newline >= 0 ? newline + 1 : limit;
  if (cut < text.length && cut > 0) {
    const previous = text.charCodeAt(cut - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) cut--;
    if (text[cut - 1] === '\r' && text[cut] === '\n') cut++;
  }
  return Math.max(1, cut);
}

function gbCharacterBytes(bytes, index) {
  const first = bytes[index];
  if (first === undefined) return 0;
  if (first < 0x81 || first > 0xfe) return 1;
  const second = bytes[index + 1];
  if (second === undefined) return 0;
  if (second >= 0x30 && second <= 0x39) {
    if (index + 3 >= bytes.length) return 0;
    const third = bytes[index + 2], fourth = bytes[index + 3];
    return third >= 0x81 && third <= 0xfe && fourth >= 0x30 && fourth <= 0x39 ? 4 : 1;
  }
  return second >= 0x40 && second <= 0xfe && second !== 0x7f ? 2 : 1;
}

function safeGbCut(bytes, maxBytes) {
  const limit = Math.min(bytes.length, maxBytes);
  let index = 0, safe = 0, newline = 0;
  while (index < limit) {
    const width = gbCharacterBytes(bytes, index);
    if (!width || index + width > limit) break;
    if (bytes[index] === 0x0a) newline = index + 1;
    else if (bytes[index] === 0x0d) newline = index + (bytes[index + 1] === 0x0a ? 2 : 1);
    index += width;
    safe = index;
  }
  return newline || safe;
}

function lineMetadata(text) {
  let newlines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r') {
      newlines++;
      if (text[index + 1] === '\n') index++;
    } else if (text[index] === '\n') newlines++;
  }
  return {
    charCount: text.length,
    estimatedLineCount: Math.max(1, newlines + (/(?:\r\n|\r|\n)$/.test(text) ? 0 : 1)),
    endsWithNewline: /(?:\r\n|\r|\n)$/.test(text),
    sampleText: text.slice(0, 180)
  };
}

function emitBlock(session, page, rangeId, byteStart, text, byteLength) {
  if (!isRangeActive(session, rangeId) || !text) return byteStart + byteLength;
  const info = lineMetadata(text);
  const byteEnd = byteStart + byteLength;
  self.postMessage({
    type: 'page-block', sessionId: session.sessionId, requestId: session.requestId, rangeId,
    page, record: { byteStart, byteEnd, encoding: session.encoding, ...info }, text
  });
  return byteEnd;
}

async function readPage(session, page, rangeId) {
  if (!Number.isInteger(page) || page < 0 || page >= Math.max(1, Math.ceil(session.source.size / PAGE_BYTES))) return;
  if (!isActive(session) || session.activeRanges.has(rangeId)) return;
  session.activeRanges.add(rangeId);
  const controller = new AbortController();
  session.rangeControllers.set(rangeId, controller);
  try {
    const range = await pageByteRange(session, page, controller.signal);
    if (!isRangeActive(session, rangeId)) return;
    self.postMessage({
      type: 'page-start', sessionId: session.sessionId, requestId: session.requestId, rangeId,
      page, byteStart: range.start, byteEnd: range.end
    });
    const decodeStartedAt = performance.now();
    const decodeStartMark = `tco-txt-worker-start-${session.sessionId}-${rangeId}`;
    const measureDecode = session.performanceEnabled;
    if (measureDecode) try { performance.mark(decodeStartMark); } catch {}
    if (session.encoding === 'gb18030' || session.encoding === 'gbk') await readGbPage(session, page, rangeId, range, controller.signal);
    else await readUnicodePage(session, page, rangeId, range, controller.signal);
    if (!isRangeActive(session, rangeId)) return;
    const decodeMs = performance.now() - decodeStartedAt;
    if (measureDecode) {
      const decodeEndMark = `${decodeStartMark}-end`;
      try {
        if (session.performanceEnabled) {
          performance.mark(decodeEndMark);
          performance.measure(`tco-txt-worker-page-${session.sessionId}`, decodeStartMark, decodeEndMark);
          const measures = performance.getEntriesByType?.('measure') || [];
          if (measures.length > 240) for (const entry of measures.slice(0, 120)) performance.clearMeasures(entry.name);
        }
      } catch {} finally { try { performance.clearMarks(decodeStartMark); performance.clearMarks(decodeEndMark); } catch {} }
    }
    self.postMessage({
      type: 'page-done', sessionId: session.sessionId, requestId: session.requestId, rangeId,
      page, byteStart: range.start, byteEnd: range.end, decodeMs
    });
  } catch (error) {
    if (isRangeActive(session, rangeId)) self.postMessage({
      type: 'page-error', sessionId: session.sessionId, requestId: session.requestId, rangeId,
      page, message: String(error?.message || error)
    });
  } finally {
    session.activeRanges.delete(rangeId);
    session.rangeControllers.delete(rangeId);
    if (session.cancelledRanges.delete(rangeId) && isActive(session)) self.postMessage({
      type: 'page-cancelled', sessionId: session.sessionId, requestId: session.requestId, page, rangeId
    });
  }
}

async function readUnicodePage(session, page, rangeId, range, signal) {
  const decoder = new TextDecoder(session.encoding, { fatal: session.encoding === 'utf-8', ignoreBOM: true });
  let pending = '';
  let byteOffset = range.start;
  const consume = (text, final = false) => {
    pending += text;
    while (pending.length > session.maxChars) {
      const cut = safeTextCut(pending, session.maxChars);
      const block = pending.slice(0, cut);
      byteOffset = emitBlock(session, page, rangeId, byteOffset, block, encodedByteLength(block, session.encoding));
      pending = pending.slice(cut);
    }
    if (final && pending) {
      byteOffset = emitBlock(session, page, rangeId, byteOffset, pending, encodedByteLength(pending, session.encoding));
      pending = '';
    }
  };
  for (let start = range.start; start < range.end; start += session.chunkBytes) {
    if (!isRangeActive(session, rangeId)) return;
    const end = Math.min(range.end, start + session.chunkBytes);
    consume(decoder.decode(await session.source.read(start, end, signal), { stream: true }));
  }
  if (!isRangeActive(session, rangeId)) return;
  consume(decoder.decode(), true);
}

async function readGbPage(session, page, rangeId, range, signal) {
  const decoder = new TextDecoder(session.encoding, { fatal: false, ignoreBOM: true });
  const maxBytes = session.maxChars * 4;
  let pending = new Uint8Array(0);
  let byteOffset = range.start;
  const append = bytes => {
    const next = new Uint8Array(pending.length + bytes.length);
    next.set(pending);
    next.set(bytes, pending.length);
    pending = next;
  };
  const emitBytes = length => {
    const bytes = pending.subarray(0, length);
    const text = decoder.decode(bytes, { stream: true });
    byteOffset = emitBlock(session, page, rangeId, byteOffset, text, length);
    pending = pending.slice(length);
  };
  for (let start = range.start; start < range.end; start += session.chunkBytes) {
      if (!isRangeActive(session, rangeId)) return;
    const end = Math.min(range.end, start + session.chunkBytes);
    append(await session.source.read(start, end, signal));
    while (pending.length > maxBytes) {
      const cut = safeGbCut(pending, maxBytes);
      if (!cut) throw new Error('Unable to split a GBK/GB18030 block safely.');
      emitBytes(cut);
    }
  }
  if (!isRangeActive(session, rangeId)) return;
  if (pending.length) {
    const finalLength = pending.length;
    const text = decoder.decode(pending, { stream: true }) + decoder.decode();
    byteOffset = emitBlock(session, page, rangeId, byteOffset, text, finalLength);
  } else {
    const tail = decoder.decode();
    if (tail) emitBlock(session, page, rangeId, byteOffset, tail, 0);
  }
}
