export class FileSource {
  constructor(file) {
    if (!(file instanceof Blob) && !(file?.url && Number.isFinite(Number(file.size)))) throw new TypeError('TXT source must be a File, Blob, or range URL.');
    this.file = file;
    this.size = Number(file.size);
  }

  async read(byteStart, byteEnd) {
    if (!this.file) throw new DOMException('TXT source was released.', 'AbortError');
    if (typeof this.file.slice !== 'function') throw new TypeError('Range URL sources are read by the TXT Worker.');
    const start = Math.max(0, Math.min(this.size, Math.floor(byteStart)));
    const end = Math.max(start, Math.min(this.size, Math.floor(byteEnd)));
    return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
  }
}

export class TextBlockLRU {
  constructor({ maxEntries = 96, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  set(key, text) {
    const value = String(text);
    const bytes = value.length * 2;
    if (bytes > this.maxBytes) return false;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { text: value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

const PAGE_BYTES = 512 * 1024;
const MAX_RETAINED_PAGES = 8;
let nextSessionId = 0;
let activeSessionId = 0;
let lifecycleState = 'idle';
let activeDisposer = null;
let activeWorker = null;
let activeRequestId = null;
let performanceEnabled = (() => { try { return localStorage.getItem('tcolib-txt-performance') === 'on'; } catch { return false; } })();
let closedSessions = 0;
let heapSamples = [];

function markMeasure(name, startMark, endMark, keepStart = false) {
  if (!globalThis.performance?.mark) return;
  try {
    if (performanceEnabled) {
      performance.mark(endMark);
      performance.measure(name, startMark, endMark);
      const measures = performance.getEntriesByType?.('measure') || [];
      if (measures.length > 240) for (const entry of measures.slice(0, 120)) performance.clearMeasures(entry.name);
    }
    if (!keepStart || !performanceEnabled) performance.clearMarks(startMark);
    performance.clearMarks(endMark);
  } catch { try { performance.clearMarks(startMark); performance.clearMarks(endMark); } catch {} }
}

function publishPerformance(metrics = {}) {
  const output = document.querySelector?.('#txtPerfStatus');
  if (!output) return;
  output.hidden = !performanceEnabled;
  if (!performanceEnabled) return;
  const first = Number.isFinite(metrics.firstPaintMs) ? `${metrics.firstPaintMs.toFixed(0)}ms` : '…';
  const total = Number.isFinite(metrics.totalOpenMs) ? `${metrics.totalOpenMs.toFixed(0)}ms` : '…';
  const close = Number.isFinite(metrics.closeMs) ? `${metrics.closeMs.toFixed(1)}ms` : '…';
  const memory = performance.memory?.usedJSHeapSize;
  const heap = Number.isFinite(memory) ? `${(memory / 1048576).toFixed(0)}MB` : 'n/a';
  const decode = Number.isFinite(metrics.workerDecodeMs) ? `${metrics.workerDecodeMs.toFixed(0)}ms` : '…';
  const frame = Number.isFinite(metrics.lastScrollFrameMs) ? `${metrics.lastScrollFrameMs.toFixed(1)}ms` : '…';
  const range = heapSamples.length > 1 ? `（近${heapSamples.length}次 ${(Math.min(...heapSamples) / 1048576).toFixed(0)}–${(Math.max(...heapSamples) / 1048576).toFixed(0)}MB）` : '';
  output.textContent = `TXT 首屏 ${first} · 打开 ${total} · 解码 ${decode} · 滚动帧 ${frame} · 退出 ${close} · 关闭 ${closedSessions} 次 · 堆 ${heap}${range}`;
}

export function setTxtPerformanceEnabled(enabled) {
  performanceEnabled = !!enabled;
  try { localStorage.setItem('tcolib-txt-performance', performanceEnabled ? 'on' : 'off'); } catch {}
  try { activeWorker?.postMessage({ type: 'performance', sessionId: activeSessionId, requestId: activeRequestId, enabled: performanceEnabled }); } catch {}
  publishPerformance();
}

export function getTxtReaderLifecycle() {
  return { state: lifecycleState, sessionId: activeSessionId };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject, settled: false };
}

function abortError() {
  return new DOMException('TXT reader session was replaced.', 'AbortError');
}

export function createTxtVirtualReader(body, file, options = {}) {
  activeDisposer?.();
  const source = new FileSource(file);
  let worker;
  try {
    worker = new Worker(new URL('./txt-reader-worker.js?v=20261031-3', import.meta.url));
  } catch (error) {
    source.file = null;
    throw error;
  }

  const sessionId = ++nextSessionId;
  const openStartedAt = performance.now();
  const openStartMark = `tco-txt-open-${sessionId}`;
  try { performance.mark(openStartMark); } catch {}
  const requestId = options.requestId;
  activeSessionId = sessionId;
  activeWorker = worker;
  activeRequestId = requestId;
  lifecycleState = 'opening';
  const ready = deferred();
  const stage = document.createElement('div');
  stage.className = 'txt-virtual-content';
  const pages = new Map();
  const pageHeights = new Map();
  const inFlightPages = new Map();
  const blockCache = new TextBlockLRU({ maxEntries: 96, maxBytes: 4 * 1024 * 1024 });
  let pageCount = Math.max(1, Math.ceil(file.size / PAGE_BYTES));
  let fileSize = file.size;
  let avgPageHeight = 760;
  let nextBlockId = 0;
  let nextRangeId = 0;
  let nextFrame = 0;
  let initialized = false;
  let mounted = false;
  let firstPaint = false;
  let disposed = false;
  let perfMetrics = {};
  let scrollFrameCount = 0;

  body.classList.add('reader-txt-virtual');
  if (options.large) body.classList.add('reader-large-document');

  const isCurrent = () => !disposed && activeSessionId === sessionId &&
    (typeof options.isCurrent !== 'function' || options.isCurrent());
  const settle = (promise, method, value) => {
    if (promise.settled) return;
    promise.settled = true;
    promise[method](value);
  };
  const pageBytes = page => Math.max(0, Math.min(PAGE_BYTES, fileSize - page * PAGE_BYTES));
  const basePageHeight = page => avgPageHeight * pageBytes(page) / PAGE_BYTES;
  const pageTop = page => {
    let top = page * avgPageHeight;
    for (const [previousPage, height] of pageHeights) {
      if (previousPage < page) top += height - basePageHeight(previousPage);
    }
    return top;
  };
  const totalHeight = () => {
    if (!pageCount) return 1;
    let height = (pageCount - 1) * avgPageHeight + basePageHeight(pageCount - 1);
    for (const [page, pageHeight] of pageHeights) height += pageHeight - basePageHeight(page);
    return Math.max(1, height);
  };
  const pageAtY = offset => {
    let low = 0, high = pageCount;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pageTop(mid) + (pageHeights.get(mid) ?? basePageHeight(mid)) <= offset) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, Math.min(pageCount - 1, low));
  };
  const getPage = number => {
    let page = pages.get(number);
    if (!page) {
      page = { number, records: [], loading: false, loaded: false, byteStart: number * PAGE_BYTES, byteEnd: Math.min(fileSize, (number + 1) * PAGE_BYTES) };
      pages.set(number, page);
    }
    return page;
  };
  const typography = () => {
    const style = getComputedStyle(body);
    const fontSize = Number.parseFloat(style.fontSize) || 21;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
    const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
    const width = Math.max(160, body.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) context.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
    return { fontSize, lineHeight, letterSpacing, width, style, context };
  };
  const estimateHeight = (record, metrics) => {
    const sample = String(record.sampleText || '').replace(/[\r\n]/g, '').slice(0, 180);
    const measured = sample && metrics.context ? metrics.context.measureText(sample).width / sample.length : metrics.fontSize * 0.78;
    const charsPerLine = Math.max(1, metrics.width / Math.max(1, measured + metrics.letterSpacing));
    const wrappedLines = Math.ceil(record.charCount / charsPerLine);
    const lines = Math.max(record.estimatedLineCount || 1, wrappedLines, 1);
    return Math.max(metrics.lineHeight, Math.ceil(lines * metrics.lineHeight));
  };
  const recordKey = record => `${record.byteStart}:${record.byteEnd}:${record.encoding}`;
  const mountStage = () => {
    if (mounted || !isCurrent()) return;
    mounted = true;
    body.replaceChildren(stage);
    body.classList.remove('reader-loading-state');
  };
  const renderFirstPaint = () => {
    if (firstPaint || !isCurrent()) return;
    firstPaint = true;
    lifecycleState = 'reading';
    perfMetrics.firstPaintMs = performance.now() - openStartedAt;
    markMeasure('tco-txt-open-first-screen', openStartMark, `tco-txt-first-${sessionId}`, true);
    publishPerformance(perfMetrics);
    try { options.onFirstPaint?.({ sessionId }); } catch {}
    settle(ready, 'resolve', api);
  };
  const mountBlock = (record, text) => {
    if (!record || record.node || !isCurrent()) return;
    mountStage();
    const block = document.createElement('div');
    block.className = 'reader-text-chunk txt-virtual-block';
    block.dataset.txtBlockId = String(record.id);
    block.textContent = text;
    block.style.transform = `translate3d(0,${record.top}px,0)`;
    record.node = block;
    stage.append(block);
    resizeObserver.observe(block);
    renderFirstPaint();
  };
  const updatePageHeight = page => {
    if (!page.records.length) return;
    const height = page.records.reduce((sum, record) => sum + Math.max(1, record.height), 0);
    const lastRecord = page.records.at(-1);
    const coveredBytes = Math.max(1, (lastRecord?.byteEnd || page.byteStart + 1) - page.byteStart);
    const expectedBytes = Math.max(1, pageBytes(page.number));
    pageHeights.set(page.number, page.loaded ? height : height * expectedBytes / coveredBytes);
    if (page.number === 0 && page.loaded && page.byteEnd > page.byteStart) {
      avgPageHeight = Math.max(240, height * PAGE_BYTES / Math.min(PAGE_BYTES, page.byteEnd - page.byteStart));
    }
  };
  const layoutRecords = () => {
    if (!isCurrent()) return;
    const metrics = typography();
    const orderedPages = [...pages.values()].sort((a, b) => a.number - b.number);
    for (const page of orderedPages) {
      page.records.sort((a, b) => a.byteStart - b.byteStart);
      let localTop = 0;
      for (const record of page.records) {
        if (!record.height) record.height = estimateHeight(record, metrics);
        record.top = localTop;
        localTop += record.height;
      }
      updatePageHeight(page);
    }
    for (const page of orderedPages) {
      const absoluteTop = pageTop(page.number);
      for (const record of page.records) {
        record.absoluteTop = absoluteTop + record.top;
        if (record.node) record.node.style.transform = `translate3d(0,${record.absoluteTop}px,0)`;
      }
    }
    stage.style.height = `${totalHeight()}px`;
    stage.dataset.totalHeight = String(totalHeight());
  };
  const desiredWindow = () => {
    if (!initialized || !pageCount) return { pageNumbers: new Set(), start: 0, end: 0, center: 0 };
    const style = getComputedStyle(body);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const viewHeight = Math.max(320, body.clientHeight);
    const start = Math.max(0, body.scrollTop - paddingTop - viewHeight * 1.5);
    const end = Math.min(totalHeight(), body.scrollTop - paddingTop + viewHeight * 2.5);
    const first = pageAtY(start), last = pageAtY(end), center = pageAtY(body.scrollTop - paddingTop);
    const pageNumbers = new Set();
    for (let page = Math.max(0, first - 1); page <= Math.min(pageCount - 1, last + 1); page++) pageNumbers.add(page);
    pageNumbers.add(0);
    if (pageNumbers.size > MAX_RETAINED_PAGES) {
      const nearby = [...pageNumbers].filter(page => page !== 0).sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      pageNumbers.clear();
      pageNumbers.add(0);
      for (const page of nearby.slice(0, MAX_RETAINED_PAGES - 1)) pageNumbers.add(page);
    }
    return { pageNumbers, start, end, center };
  };
  const cancelFarPages = desired => {
    for (const [page, request] of inFlightPages) {
      if (desired.has(page)) continue;
      worker.postMessage({ type: 'cancel-page', sessionId, requestId, page, rangeId: request.rangeId });
      request.cancelled = true;
      const item = pages.get(page);
      if (item) item.loading = false;
    }
  };
  const requestPages = (desired, center) => {
    if (!initialized || !isCurrent()) return;
    cancelFarPages(desired);
    const candidates = [...desired]
      .filter(number => {
        const page = getPage(number);
        return !page.loading && !inFlightPages.has(number) && (!page.loaded || !page.records.length);
      })
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    while (inFlightPages.size < 2 && candidates.length) {
      const number = candidates.shift();
      const page = getPage(number);
      page.loading = true;
      page.loaded = false;
      const rangeId = ++nextRangeId;
      inFlightPages.set(number, { rangeId, cancelled: false });
      worker.postMessage({ type: 'read-page', sessionId, requestId, page: number, rangeId });
    }
  };
  const prunePages = (desired, center) => {
    if (pages.size <= MAX_RETAINED_PAGES) return;
    const candidates = [...pages.values()]
      .filter(page => !desired.has(page.number) && !page.loading)
      .sort((a, b) => Math.abs(b.number - center) - Math.abs(a.number - center));
    while (pages.size > MAX_RETAINED_PAGES && candidates.length) {
      const page = candidates.shift();
      for (const record of page.records) {
        if (record.node) {
          resizeObserver.unobserve(record.node);
          record.node.remove();
        }
      }
      page.records.length = 0;
      page.loaded = false;
      pages.delete(page.number);
      pageHeights.delete(page.number);
    }
  };
  const renderVisible = () => {
    if (!isCurrent() || !initialized) return;
    const frameStartedAt = performance.now();
    const measureScroll = performanceEnabled && ++scrollFrameCount % 30 === 0;
    const scrollStartMark = `tco-txt-scroll-${sessionId}`;
    if (measureScroll) try { performance.mark(scrollStartMark); } catch {}
    layoutRecords();
    const desired = desiredWindow();
    requestPages(desired.pageNumbers, desired.center);
    const visibleRecords = [];
    for (const page of pages.values()) {
      for (const record of page.records) {
        const top = record.absoluteTop;
        if (top + record.height >= desired.start && top <= desired.end) visibleRecords.push(record);
        else if (record.node) {
          resizeObserver.unobserve(record.node);
          record.node.remove();
          record.node = null;
        }
      }
    }
    for (const record of visibleRecords) {
      if (record.node) continue;
      const text = blockCache.get(recordKey(record));
      if (text !== undefined) mountBlock(record, text);
      else {
        const page = pages.get(record.page);
        if (page) {
          page.loaded = false;
          requestPages(new Set([...desired.pageNumbers, page.number]), desired.center);
        }
      }
    }
    prunePages(desired.pageNumbers, desired.center);
    if (measureScroll) {
      markMeasure(`tco-txt-scroll-frame-${sessionId}`, scrollStartMark, `${scrollStartMark}-end`);
      perfMetrics.lastScrollFrameMs = performance.now() - frameStartedAt;
    }
  };
  const scheduleRender = () => {
    if (disposed || nextFrame) return;
    nextFrame = requestAnimationFrame(() => {
      nextFrame = 0;
      renderVisible();
    });
  };
  const onScroll = () => scheduleRender();
  const resizeObserver = new ResizeObserver(entries => {
    if (!isCurrent()) return;
    let changed = false;
    for (const entry of entries) {
      const id = Number(entry.target.dataset.txtBlockId);
      for (const page of pages.values()) {
        const record = page.records.find(item => item.id === id);
        if (!record) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
        if (Number.isFinite(height) && height > 0 && Math.abs(height - record.height) > 0.75) {
          record.height = height;
          updatePageHeight(page);
          changed = true;
        }
        break;
      }
    }
    if (changed) {
      layoutRecords();
      scheduleRender();
    }
  });
  const bodyObserver = new ResizeObserver(() => {
    if (isCurrent()) scheduleRender();
  });
  bodyObserver.observe(body);
  body.addEventListener('scroll', onScroll, { passive: true });

  const api = {
    ready: ready.promise,
    get state() { return activeSessionId === sessionId ? lifecycleState : 'closing'; },
    get sessionId() { return sessionId; },
    get blockCount() { return [...pages.values()].reduce((sum, page) => sum + page.records.length, 0); },
    scrollToPercent(percent, instant = true) {
      if (!isCurrent() || !fileSize) return false;
      const value = Math.max(0, Math.min(1, Number(percent) || 0));
      const page = Math.min(pageCount - 1, Math.floor((fileSize * value) / PAGE_BYTES));
      const previousBehavior = body.style.scrollBehavior;
      if (instant) body.style.scrollBehavior = 'auto';
      body.scrollTop = pageTop(page) + (Number.parseFloat(getComputedStyle(body).paddingTop) || 0);
      if (instant) body.style.scrollBehavior = previousBehavior;
      scheduleRender();
      return true;
    },
    refreshTypography() {
      if (!isCurrent()) return;
      const metrics = typography();
      for (const page of pages.values()) {
        for (const record of page.records) record.height = estimateHeight(record, metrics);
        updatePageHeight(page);
      }
      layoutRecords();
      scheduleRender();
    },
    dispose() { teardown(abortError()); }
  };

  function teardown(error) {
    if (disposed) return;
    const notifyError = firstPaint && error?.name !== 'AbortError';
    const closeStartedAt = performance.now();
    const closeStartMark = `tco-txt-close-${sessionId}`;
    try { performance.mark(closeStartMark); } catch {}
    if (activeSessionId === sessionId) {
      lifecycleState = 'closing';
      activeSessionId = 0;
    }
    disposed = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try { worker.postMessage({ type: 'cancel', sessionId, requestId }); } catch {}
    worker.terminate();
    body.removeEventListener('scroll', onScroll);
    bodyObserver.disconnect();
    resizeObserver.disconnect();
    cancelAnimationFrame(nextFrame);
    nextFrame = 0;
    for (const page of pages.values()) {
      for (const record of page.records) record.node?.remove();
      page.records.length = 0;
    }
    pages.clear();
    pageHeights.clear();
    inFlightPages.clear();
    blockCache.clear();
    stage.replaceChildren();
    stage.remove();
    body.classList.remove('reader-txt-virtual', 'reader-large-document');
    source.file = null;
    file = null;
    closedSessions++;
    const memory = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(memory)) {
      heapSamples.push(memory);
      if (heapSamples.length > 50) heapSamples.shift();
    }
    perfMetrics.closeMs = performance.now() - closeStartedAt;
    markMeasure('tco-txt-close-response', closeStartMark, `tco-txt-close-end-${sessionId}`);
    try { performance.clearMarks(openStartMark); } catch {}
    publishPerformance(perfMetrics);
    settle(ready, 'reject', error || abortError());
    if (notifyError) {
      try { Promise.resolve(options.onError?.(error, { sessionId })).catch(() => {}); } catch {}
    }
    if (activeDisposer === teardown) {
      activeDisposer = null;
      activeWorker = null;
      activeRequestId = null;
    }
    if (lifecycleState === 'closing' && activeSessionId === 0) lifecycleState = 'idle';
  }

  activeDisposer = teardown;
  worker.onmessage = event => {
    const message = event.data || {};
    if (!isCurrent() || message.sessionId !== sessionId || message.requestId !== requestId) return;
    if (message.type === 'fallback') {
      teardown(new Error(`TXT Worker fallback: ${message.encoding || 'unsupported encoding'}`));
      return;
    }
    if (message.type === 'error') {
      teardown(new Error(message.message || 'TXT Worker failed.'));
      return;
    }
    if (message.type === 'initialized') {
      initialized = true;
      fileSize = Number(message.byteLength) || fileSize;
      pageCount = Math.max(1, Number(message.pageCount) || Math.ceil(fileSize / PAGE_BYTES));
      scheduleRender();
      return;
    }
    if (message.type === 'page-start') {
      const request = inFlightPages.get(message.page);
      if (!request || request.rangeId !== message.rangeId || request.cancelled) return;
      const page = getPage(message.page);
      page.byteStart = message.byteStart;
      page.byteEnd = message.byteEnd;
      return;
    }
    if (message.type === 'page-block') {
      const request = inFlightPages.get(message.page);
      if (!request || request.rangeId !== message.rangeId || request.cancelled) return;
      const page = getPage(message.page);
      const record = { ...message.record, page: message.page, id: ++nextBlockId, height: 0, node: null, top: 0, absoluteTop: 0 };
      const key = recordKey(record);
      blockCache.set(key, message.text);
      if (!page.records.some(item => recordKey(item) === key)) {
        record.height = estimateHeight(record, typography());
        page.records.push(record);
      }
      layoutRecords();
      scheduleRender();
      return;
    }
    if (message.type === 'page-done') {
      const request = inFlightPages.get(message.page);
      if (!request || request.rangeId !== message.rangeId) return;
      inFlightPages.delete(message.page);
      const page = getPage(message.page);
      page.loading = false;
      if (request.cancelled) {
        scheduleRender();
        return;
      }
      page.loaded = true;
      page.byteStart = message.byteStart;
      page.byteEnd = message.byteEnd;
      updatePageHeight(page);
      if (message.page === 0 && !Number.isFinite(perfMetrics.totalOpenMs)) {
        perfMetrics.totalOpenMs = performance.now() - openStartedAt;
        markMeasure('tco-txt-open-total', openStartMark, `tco-txt-total-${sessionId}`);
        publishPerformance(perfMetrics);
      }
      if (Number.isFinite(message.decodeMs)) perfMetrics.workerDecodeMs = message.decodeMs;
      publishPerformance(perfMetrics);
      if (message.page === 0 && page.records.length && message.byteEnd > message.byteStart) {
        avgPageHeight = Math.max(240, pageHeights.get(0) * PAGE_BYTES / Math.min(PAGE_BYTES, message.byteEnd - message.byteStart));
      }
      if (!page.records.length) {
        mountStage();
        renderFirstPaint();
      }
      layoutRecords();
      scheduleRender();
      return;
    }
    if (message.type === 'page-cancelled') {
      const request = inFlightPages.get(message.page);
      if (!request || request.rangeId !== message.rangeId) return;
      inFlightPages.delete(message.page);
      const page = pages.get(message.page);
      if (page) page.loading = false;
      scheduleRender();
      return;
    }
    if (message.type === 'page-error') {
      const request = inFlightPages.get(message.page);
      if (!request || request.rangeId !== message.rangeId || request.cancelled) return;
      teardown(new Error(message.message || 'TXT page could not be read.'));
    }
  };
  worker.onerror = event => teardown(new Error(event.message || 'TXT Worker crashed.'));
  worker.onmessageerror = () => teardown(new Error('TXT Worker returned an unreadable message.'));
  const initialPage = getPage(0);
  initialPage.loading = true;
  inFlightPages.set(0, { rangeId: 0, cancelled: false });
  worker.postMessage({
    type: 'init', sessionId, requestId, file: source.file,
    chunkBytes: PAGE_BYTES, maxChars: 64 * 1024, performanceEnabled
  });
  file = null;

  return api;
}
