import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../assets/js/txt-reader-worker.js', import.meta.url), 'utf8');
const readerSource = await readFile(new URL('../assets/js/txt-reader.js', import.meta.url), 'utf8');
const { TextBlockLRU } = await import(`data:text/javascript;base64,${Buffer.from(readerSource).toString('base64')}`);

async function waitFor(messages, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate(messages);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for TXT Worker message.');
}

function createWorker(file, { maxChars = 4096, chunkBytes = 64 * 1024, fetcher = fetch } = {}) {
  const messages = [];
  const self = { postMessage: message => messages.push(message), onmessage: null };
  const context = { self, Blob, TextDecoder, TextEncoder, Uint8Array, Set, Math, Number, String, Error, Promise, performance, AbortController, fetch: fetcher };
  vm.runInNewContext(workerSource, context, { filename: 'txt-reader-worker.js' });
  self.onmessage({ data: { type: 'init', sessionId: 10, requestId: 1, file, chunkBytes, maxChars } });
  return { self, messages };
}

async function readInitial(file, options) {
  const worker = createWorker(file, options);
  const terminal = await waitFor(worker.messages, list => list.find(message => ['page-done', 'fallback', 'error'].includes(message.type)));
  return { ...worker, terminal };
}

test('streams UTF-8 and CRLF/LF correctly across byte reads', async () => {
  const text = `${'a'.repeat(65_535)}中文🙂\r\n第二行\n第三行`;
  const result = await readInitial(new Blob([text]));
  assert.equal(result.terminal.type, 'page-done');
  const actual = result.messages.filter(message => message.type === 'page-block').map(message => message.text).join('');
  assert.equal(actual.length, text.length, `length mismatch; context=${JSON.stringify(actual.slice(65_530, 65_560))}`);
  assert.equal(actual, text);
});

test('keeps a multibyte UTF-8 character intact at a forced page boundary', async () => {
  const text = `${'a'.repeat(512 * 1024 - 1)}🙂${'z'.repeat(300_000)}`;
  const result = await readInitial(new Blob([text]));
  result.self.onmessage({ data: { type: 'read-page', sessionId: 10, requestId: 1, page: 1, rangeId: 1 } });
  await waitFor(result.messages, messages => messages.find(message => message.type === 'page-done' && message.page === 1));
  assert.equal(result.messages.filter(message => message.type === 'page-block').map(message => message.text).join(''), text);
});

test('reads server files through bounded HTTP byte ranges in the Worker', async () => {
  const text = '中文行内容\r\n'.repeat(40_000);
  const bytes = new TextEncoder().encode(text), ranges = [];
  const fetcher = async (_url, options) => {
    const [start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    ranges.push([start, end]);
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  };
  const result = await readInitial({ url: '/api/library/file/large', size: bytes.byteLength }, { fetcher });
  result.self.onmessage({ data: { type: 'read-page', sessionId: 10, requestId: 1, page: 1, rangeId: 1 } });
  await waitFor(result.messages, messages => messages.find(message => message.type === 'page-done' && message.page === 1));
  assert.equal(result.messages.filter(message => message.type === 'page-block').map(message => message.text).join(''), text);
  assert.ok(ranges.length > 4);
  assert.ok(ranges.every(([start, end]) => end - start + 1 < bytes.byteLength));
});

test('preserves Markdown fences, lists and tables as raw TXT boundaries', async () => {
  const text = `${'x'.repeat(4090)}\n| A | B |\n|---|---|\n- item\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n`;
  const result = await readInitial(new Blob([text]));
  assert.equal(result.messages.filter(message => message.type === 'page-block').map(message => message.text).join(''), text);
});

test('detects BOM and decodes GBK in the Worker', async () => {
  const body = new TextEncoder().encode('正文\n');
  const utf8 = new Uint8Array(3 + body.length);
  utf8.set([0xef, 0xbb, 0xbf]); utf8.set(body, 3);
  const bom = await readInitial(new Blob([utf8]));
  assert.equal(bom.messages.find(message => message.type === 'page-block').record.byteStart, 3);
  assert.equal(bom.messages.filter(message => message.type === 'page-block').map(message => message.text).join(''), '正文\n');

  const gbk = await readInitial(new Blob([new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])]));
  assert.equal(gbk.terminal.type, 'page-done');
  assert.equal(gbk.messages.filter(message => message.type === 'page-block').map(message => message.text).join(''), '中文');
});

test('force-splits an overlong line into bounded blocks', async () => {
  const text = 'x'.repeat(12_000);
  const result = await readInitial(new Blob([text]), { maxChars: 4096 });
  const blocks = result.messages.filter(message => message.type === 'page-block');
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every(message => message.record.charCount <= 4097));
  assert.equal(blocks.map(message => message.text).join(''), text);
});

test('evicts least recently used text blocks within entry and byte limits', () => {
  const cache = new TextBlockLRU({ maxEntries: 2, maxBytes: 8 });
  cache.set('0:2:utf-8', 'aa'); cache.set('2:4:utf-8', 'bb');
  assert.equal(cache.get('0:2:utf-8'), 'aa');
  cache.set('4:6:utf-8', 'cc');
  assert.equal(cache.get('2:4:utf-8'), undefined);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.set('6:11:utf-8', '12345'), false);
});

test('cancels an expired page request before it emits blocks', async () => {
  const blob = new Blob(['x'.repeat(700_000)]);
  const delayedFile = {
    size: blob.size,
    slice(start, end) {
      const slice = blob.slice(start, end);
      return { arrayBuffer: () => new Promise(resolve => setTimeout(() => slice.arrayBuffer().then(resolve), 30)) };
    }
  };
  const worker = createWorker(delayedFile);
  await waitFor(worker.messages, messages => messages.find(message => message.type === 'initialized'));
  worker.self.onmessage({ data: { type: 'cancel-page', sessionId: 10, requestId: 1, page: 0, rangeId: 0 } });
  await waitFor(worker.messages, messages => messages.find(message => message.type === 'page-cancelled' && message.rangeId === 0));
  assert.equal(worker.messages.some(message => message.type === 'page-block' && message.rangeId === 0), false);
});

test('aborts an in-flight server range when its page leaves the viewport', async () => {
  const bytes = new Uint8Array(700_000).fill(0x61);
  let aborted = false;
  let firstPageChunkSeen = false;
  const fetcher = (_url, options) => {
    const [start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    if (start === 0 && end - start === 65_535) {
      if (firstPageChunkSeen) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
      firstPageChunkSeen = true;
    }
    return Promise.resolve(new Response(bytes.slice(start, end + 1), { status: 206 }));
  };
  const worker = createWorker({ url: '/api/library/file/slow', size: bytes.length }, { fetcher });
  await waitFor(worker.messages, messages => messages.find(message => message.type === 'page-start' && message.rangeId === 0));
  worker.self.onmessage({ data: { type: 'cancel-page', sessionId: 10, requestId: 1, page: 0, rangeId: 0 } });
  await waitFor(worker.messages, messages => messages.find(message => message.type === 'page-cancelled' && message.rangeId === 0));
  assert.equal(aborted, true);
  assert.equal(worker.messages.some(message => message.type === 'page-block' && message.rangeId === 0), false);
});

test('guards open-close races and releases resources over 50 sessions', async () => {
  const moduleSource = readerSource.replace("new URL('./txt-reader-worker.js?v=20261031-3', import.meta.url)", "'worker-mock'");
  const reader = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  const workers = new Set(), observers = new Set(), frames = new Set();
  class FakeElement {
    constructor() {
      this.style = {}; this.dataset = {}; this.children = []; this.listeners = new Map(); this.scrollTop = 0;
      const names = new Set();
      this.classList = { add: (...items) => items.forEach(item => names.add(item)), remove: (...items) => items.forEach(item => names.delete(item)), contains: item => names.has(item) };
      this.clientWidth = 640; this.clientHeight = 480;
    }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    remove() { this.removed = true; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    getContext() { return { measureText: value => ({ width: value.length * 10 }), font: '' }; }
  }
  const emitPage = worker => {
    if (worker.terminated) return;
    const { sessionId, requestId } = worker;
    worker.emit({ type: 'page-start', sessionId, requestId, page: 0, rangeId: 0, byteStart: 0, byteEnd: 3 });
    worker.emit({ type: 'page-block', sessionId, requestId, page: 0, rangeId: 0, record: { byteStart: 0, byteEnd: 3, encoding: 'utf-8', charCount: 3, estimatedLineCount: 1, sampleText: 'abc' }, text: 'abc' });
    worker.emit({ type: 'page-done', sessionId, requestId, page: 0, rangeId: 0, byteStart: 0, byteEnd: 3 });
  };
  class FakeWorker {
    constructor() { workers.add(this); this.terminated = false; }
    emit(data) { if (!this.terminated) this.onmessage?.({ data }); }
    postMessage(message) {
      if (message.type === 'init') {
        this.sessionId = message.sessionId; this.requestId = message.requestId;
        setTimeout(() => this.emit({ type: 'initialized', sessionId: this.sessionId, requestId: this.requestId, byteLength: 3, pageBytes: 524288, pageCount: 1 }), 1);
        setTimeout(() => emitPage(this), 4);
      } else if (message.type === 'read-page') setTimeout(() => emitPage(this), 2);
      else if (message.type === 'cancel-page') setTimeout(() => this.emit({ type: 'page-cancelled', sessionId: this.sessionId, requestId: this.requestId, page: message.page, rangeId: message.rangeId }), 0);
    }
    terminate() { this.terminated = true; this.onmessage = this.onerror = this.onmessageerror = null; workers.delete(this); }
  }
  class FakeResizeObserver {
    constructor() { observers.add(this); this.disconnected = false; }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true; observers.delete(this); }
  }
  globalThis.Worker = FakeWorker;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.document = { createElement: () => new FakeElement() };
  globalThis.getComputedStyle = () => ({ fontSize: '20px', lineHeight: '30px', letterSpacing: '0px', paddingTop: '0px', paddingLeft: '0px', paddingRight: '0px', fontFamily: 'sans-serif', fontWeight: '400' });
  globalThis.requestAnimationFrame = callback => { const id = setTimeout(() => { frames.delete(id); callback(); }, 0); frames.add(id); return id; };
  globalThis.cancelAnimationFrame = id => { clearTimeout(id); frames.delete(id); };

  const body = new FakeElement();
  const first = reader.createTxtVirtualReader(body, new Blob(['abc']), { requestId: 1 });
  assert.equal(first.state, 'opening');
  const openingWorker = [...workers][0];
  first.dispose();
  const second = reader.createTxtVirtualReader(body, new Blob(['abc']), { requestId: 2 });
  openingWorker.emit({ type: 'page-block', sessionId: 1, requestId: 1, page: 0, rangeId: 0, record: {}, text: 'stale' });
  await second.ready;
  assert.equal(second.state, 'reading');
  body.listeners.get('scroll')?.();
  second.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reader.getTxtReaderLifecycle().state, 'idle');
  assert.equal(body.listeners.has('scroll'), false);
  assert.equal(workers.size, 0);
  assert.equal(observers.size, 0);
  assert.equal(frames.size, 0);

  let lateErrors = 0;
  const lateFailure = reader.createTxtVirtualReader(body, new Blob(['abc']), { requestId: 3, onError: () => { lateErrors++; } });
  await lateFailure.ready;
  [...workers][0].onerror({ message: 'late worker failure' });
  await Promise.resolve();
  assert.equal(lateErrors, 1);
  assert.equal(reader.getTxtReaderLifecycle().state, 'idle');

  for (let index = 0; index < 50; index++) {
    const session = reader.createTxtVirtualReader(body, new Blob(['abc']), { requestId: index + 4 });
    await session.ready;
    session.dispose();
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(workers.size, 0);
  assert.equal(observers.size, 0);
  assert.equal(frames.size, 0);
});
