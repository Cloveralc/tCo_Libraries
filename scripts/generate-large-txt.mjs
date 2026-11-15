import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const targetBytes = 100 * 1024 * 1024;
const outputPath = resolve(process.argv[2] || 'test-data/large-100mb.txt');
const chunkBytes = 64 * 1024;
const line = Buffer.from('tCo Libraries 大文本性能测试：分块读取、Worker 解码与虚拟滚动。\r\n', 'utf8');
const chunk = Buffer.alloc(chunkBytes);
let offset = 0;
while (offset + line.length <= chunkBytes) {
  line.copy(chunk, offset);
  offset += line.length;
}
chunk.fill(0x20, offset);
chunk[chunkBytes - 1] = 0x0a;

await mkdir(dirname(outputPath), { recursive: true });
const handle = await open(outputPath, 'w');
try {
  for (let written = 0; written < targetBytes; written += chunkBytes) {
    await handle.write(chunk, 0, Math.min(chunkBytes, targetBytes - written));
  }
} finally {
  await handle.close();
}
console.log(`Wrote ${targetBytes} bytes to ${outputPath}`);
