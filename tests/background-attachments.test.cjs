require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const realStore = require('../src/background/attachmentStore.ts');
const { downloadAttachment, ATTACHMENT_HOSTS } = require('../src/background/attachmentDownload.ts');

const file = { transferId: 'transfer', alias: 1, name: 'paper.pdf', mimeType: 'application/pdf', dataBase64: 'JVBERg==', size: 4 };
const conversation = (title = 'Chat') => ({
  version: '1.0', metadata: { source: 'Claude', title, createdAt: '2026-11-25T10:00:00Z' },
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text/markdown', text: 'Read this paper' }],
    attachments: [{ id: 'a1', kind: 'file', name: 'paper.pdf', blobAlias: 1 }] }],
});

const backgroundPath = path.resolve(__dirname, '../src/background/index.ts');
const backgroundOutput = ts.transpileModule(fs.readFileSync(backgroundPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function backgroundHarness(options = {}) {
  const state = {};
  const files = new Map();
  const order = [];
  const calls = [];
  let onMessage;
  let clock = 1000;
  class Clock extends Date { static now() { return options.fixedClock ? 1000 : clock += 1000; } }
  const store = {
    ...realStore,
    async putBlobs(blobs) {
      order.push('putBlobs');
      if (options.failBlobs) throw new Error('Disk full');
      for (const blob of blobs) files.set(`${blob.transferId}:${blob.alias}`, structuredClone(blob));
    },
    async getBlobsByTransfer(id) { return [...files.values()].filter((f) => f.transferId === id); },
    async getBlob(id, alias) { return files.get(`${id}:${alias}`) || null; },
    async deleteBlob(id, alias) { files.delete(`${id}:${alias}`); },
    async deleteBlobsByTransfer(id) { for (const [key, value] of files) if (value.transferId === id) files.delete(key); },
  };
  const chrome = {
    runtime: { id: 'extension-id', onMessage: { addListener(fn) { onMessage = fn; } } },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.map((key) => [key, structuredClone(state[key])])); },
        async set(values) {
          if (values.pendingTransferEncrypted) {
            order.push('setTranscript');
            if (options.failTranscript) throw new Error('Storage quota exceeded');
          }
          Object.assign(state, structuredClone(values));
        },
        async remove(keys) { keys.forEach((key) => delete state[key]); },
      },
      session: { async get() { return {}; }, async remove() {} },
    },
    scripting: { async executeScript(invocation) {
      calls.push({ method: 'executeScript', invocation });
      if (options.document) return [{ result: invocation.func(...invocation.args) }];
      return [{ result: { status: 'success', dataBase64: 'JVBERg==', size: 4 } }];
    } },
    tabs: {
      async query() { calls.push({ method: 'query' }); return [{ id: 99, url: 'https://claude.ai/chat/current' }]; },
      async sendMessage(tabId, message) {
        calls.push({ method: 'sendMessage', tabId, message });
        if (options.captureError) throw new Error(options.captureError);
        return options.captureResponse;
      },
    },
  };
  vm.runInNewContext(backgroundOutput, {
    exports: {}, chrome, document: options.document, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, URL, Date: Clock, console,
    process: { env: {} },
    require(id) {
      if (id === './attachmentStore') return store;
      if (id === './attachmentDownload') return { downloadAttachment, ATTACHMENT_HOSTS };
      return require(path.resolve(path.dirname(backgroundPath), id + '.ts'));
    },
  }, { filename: backgroundPath });
  const send = (request, sender = { id: chrome.runtime.id }) => new Promise((resolve) => onMessage(request, sender, resolve));
  return { state, files, order, calls, send };
}

test('stores the original binary before publishing a transfer and restores files from history', async () => {
  const h = backgroundHarness();
  const first = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  assert.equal(first.status, 'success');
  assert.deepEqual(h.order, ['putBlobs', 'setTranscript']);
  assert.equal(h.state.transferHistory[0].id, first.transferId);
  assert.equal(h.state.transferHistory[0].attachmentTransferId, first.transferId);
  const second = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation('Second'), blobs: [file] });
  assert.notEqual(second.transferId, first.transferId);
  const loaded = await h.send({ type: 'LOAD_HISTORY_ITEM', id: first.transferId });
  assert.equal(loaded.transferId, first.transferId);
  const transcript = await h.send({ type: 'FETCH_TRANSCRIPT' });
  assert.equal(transcript.transferId, first.transferId);
  assert.equal(transcript.payload.metadata.title, 'Chat');
  const captured = await h.send({ type: 'FETCH_ATTACHMENTS', transferId: transcript.transferId });
  assert.equal(captured.blobs[0].dataBase64, file.dataBase64);
});

test('a failed blob write never publishes an incomplete transcript', async () => {
  const h = backgroundHarness({ failBlobs: true });
  const result = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  assert.equal(result.status, 'error');
  assert.match(result.error, /Disk full/);
  assert.equal(h.state.pendingTransferEncrypted, undefined);
  assert.equal(h.state.transferHistory, undefined);
});

test('rolls back stored files when transcript persistence fails', async () => {
  const h = backgroundHarness({ failTranscript: true });
  const result = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  assert.equal(result.status, 'error');
  assert.equal(h.files.size, 0);
});

function missingFileConversation(title = 'Claude plot') {
  const payload = conversation(title);
  payload.messages[0].attachments = [{
    id: 'a1', kind: 'file', name: 'Unstandardized coef plot',
    captureError: 'The source did not expose a downloadable original.',
  }];
  return payload;
}

function restorePlot(transferId) {
  const png = Buffer.from([137, 80, 78, 71, 0, 255]);
  return {
    type: 'RESTORE_CAPTURE_ATTACHMENT', transferId, messageId: 'm1', attachmentId: 'a1',
    file: { name: 'Unstandardized coef plot.png', mimeType: 'image/png', dataBase64: png.toString('base64'), size: png.length },
  };
}

test('restores user selected bytes to the missing attachment and retains the repair in history', async () => {
  const h = backgroundHarness();
  const { transferId } = await h.send({ type: 'STORE_TRANSCRIPT', payload: missingFileConversation() });
  const request = restorePlot(transferId);
  const [restored, duplicate] = await Promise.all([h.send(request), h.send(request)]);
  assert.equal(restored.status, 'success');
  assert.equal(restored.name, request.file.name);
  assert.match(duplicate.error, /already has a file/);
  assert.equal(h.files.size, 1);
  await h.send({ type: 'STORE_TRANSCRIPT', payload: missingFileConversation('Another chat') });
  await h.send({ type: 'LOAD_HISTORY_ITEM', id: transferId });

  const { payload } = await h.send({ type: 'FETCH_TRANSCRIPT' });
  const ref = payload.messages[0].attachments[0];
  assert.equal(ref.name, request.file.name);
  assert.equal(ref.captureError, undefined);
  assert.equal(payload.metadata.extensions.unavailableAttachments, '0');
  const serialized = JSON.stringify({ metadata: payload.metadata, messages: payload.messages });
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  assert.equal(payload.integrity.sha256, Buffer.from(digest).toString('hex'));
  const { blob } = await h.send({ type: 'FETCH_ATTACHMENT', transferId, alias: ref.blobAlias });
  assert.equal(blob.dataBase64, request.file.dataBase64);
  assert.equal(blob.mimeType, request.file.mimeType);
});

test('rejects stale selections and rolls back a staged repair when updating the capture fails', async () => {
  const options = {};
  const h = backgroundHarness(options);
  const { transferId } = await h.send({ type: 'STORE_TRANSCRIPT', payload: missingFileConversation() });
  const request = restorePlot(transferId);
  await h.send({ type: 'STORE_TRANSCRIPT', payload: missingFileConversation('Another chat') });
  assert.match((await h.send(request)).error, /selected capture changed/);
  assert.equal(h.files.size, 0);
  await h.send({ type: 'LOAD_HISTORY_ITEM', id: transferId });
  options.failTranscript = true;
  assert.match((await h.send(request)).error, /Storage quota exceeded/);
  assert.equal(h.files.size, 0);
  const { payload } = await h.send({ type: 'FETCH_TRANSCRIPT' });
  assert.equal(payload.messages[0].attachments[0].blobAlias, undefined);
});

test('rejects captured aliases without original file data', async () => {
  const h = backgroundHarness();
  const result = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation() });
  assert.equal(result.status, 'error');
  assert.match(result.error, /Missing file data/);
});

test('replacing a capture removes its old files', async () => {
  const h = backgroundHarness();
  const first = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  const second = await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  assert.equal(h.state.transferHistory.length, 1);
  assert.equal(h.files.has(`${first.transferId}:1`), false);
  assert.equal(h.files.has(`${second.transferId}:1`), true);
});

test('successive attachment and transcript reads are not rejected by the UI rate limiter', async () => {
  const h = backgroundHarness({ fixedClock: true });
  const sender = { id: 'extension-id', tab: { id: 1, url: 'https://chatgpt.com/c/test' } };
  for (let i = 0; i < 2; i++) {
    const result = await h.send({ type: 'DOWNLOAD_IN_PAGE', url: 'https://chatgpt.com/file.pdf' }, sender);
    assert.equal(result.status, 'success', result.error);
    assert.equal((await h.send({ type: 'FETCH_TRANSCRIPT' })).error, undefined);
    assert.equal((await h.send({ type: 'FETCH_ATTACHMENTS' })).error, undefined);
  }
});

test('publishes staged files in small messages and protects published files from discard', async () => {
  const h = backgroundHarness();
  const transferId = 'staged-transfer';
  assert.equal((await h.send({ type: 'STORE_ATTACHMENTS', transferId, blobs: [file] })).status, 'success');
  assert.equal(h.state.pendingTransferEncrypted, undefined);
  assert.equal((await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), stagedTransferId: transferId })).status, 'success');
  assert.equal(h.state.activeTransferId, transferId);
  assert.equal(h.state.transferHistory[0].id, transferId);
  assert.equal((await h.send({ type: 'DISCARD_STAGED_ATTACHMENTS', transferId })).status, 'error');
  assert.equal(h.files.has(`${transferId}:1`), true);
  assert.equal((await h.send({ type: 'STORE_ATTACHMENTS', transferId, blobs: [file] })).status, 'error');
});

test('discards an unpublished capture without changing the active chat', async () => {
  const h = backgroundHarness();
  await h.send({ type: 'STORE_TRANSCRIPT', payload: conversation(), blobs: [file] });
  const active = h.state.activeTransferId;
  await h.send({ type: 'STORE_ATTACHMENTS', transferId: 'unfinished', blobs: [file] });
  assert.equal((await h.send({ type: 'DISCARD_STAGED_ATTACHMENTS', transferId: 'unfinished' })).status, 'success');
  assert.equal(h.files.has('unfinished:1'), false);
  assert.equal(h.state.activeTransferId, active);
  assert.equal(h.files.has(`${active}:1`), true);
});

test('validates encoded file sizes, aliases and per-file limits', () => {
  assert.doesNotThrow(() => realStore.validateAttachmentBlobs([file]));
  assert.throws(() => realStore.validateAttachmentBlobs([{ ...file, size: 5 }]), /invalid file data/i);
  assert.throws(() => realStore.validateAttachmentBlobs([{ ...file, alias: 0 }]), /metadata/);
  assert.throws(() => realStore.validateAttachmentBlobs([file, file]), /Duplicate/);
  assert.throws(() => realStore.validateAttachmentBlobs([{ ...file, size: realStore.MAX_BLOB_SIZE + 1 }]), /25 MB/);
});

async function withFetch(mock, run) {
  const original = global.fetch;
  global.fetch = mock;
  try { await run(); } finally { global.fetch = original; }
}
const downloadOptions = { maxSize: 1024, allowedHosts: ATTACHMENT_HOSTS };

test('downloads exact binary data and Unicode filenames', async () => {
  await withFetch(async () => new Response(new Uint8Array([0, 255, 128, 3]), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" },
  }), async () => {
    const result = await downloadAttachment('https://claude.ai/paper.pdf', downloadOptions);
    assert.equal(result.status, 'success');
    assert.equal(result.filename, 'résumé.pdf');
    assert.equal(result.dataBase64, 'AP+AAw==');
    assert.equal(result.size, 4);
  });
});

test('rejects foreign hosts, credentials, insecure protocols, and foreign blob origins before fetching', async () => {
  await withFetch(() => { throw new Error('fetch should not run'); }, async () => {
    for (const url of [
      'https://claude.ai.evil.test/a.pdf', 'https://name@claude.ai/a.pdf', 'http://claude.ai/a.pdf',
      'blob:https://other.test/uuid', 'file:///tmp/a.pdf',
    ]) {
      const result = await downloadAttachment(url, { ...downloadOptions, pageOrigin: 'https://claude.ai' });
      assert.equal(result.status, 'error');
      assert.match(result.error, /not allowed/);
    }
  });
});

test('rejects oversized streams even without Content-Length', async () => {
  await withFetch(async () => new Response(new Uint8Array([1, 2, 3, 4])), async () => {
    const result = await downloadAttachment('https://claude.ai/paper.pdf', { ...downloadOptions, maxSize: 3 });
    assert.equal(result.status, 'error');
    assert.match(result.error, /25 MB/);
  });
});

test('rejects login HTML rather than recording it as an attached PDF', async () => {
  await withFetch(async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }), async () => {
    const result = await downloadAttachment('https://claude.ai/paper.pdf', downloadOptions);
    assert.equal(result.status, 'error');
    assert.match(result.error, /web page instead/);
  });
});

test('accepts same-origin blob and inline image data only in the source page', async () => {
  await withFetch(async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } }), async () => {
    for (const url of ['blob:https://claude.ai/uuid', 'data:image/png;base64,AQI=']) {
      assert.equal((await downloadAttachment(url, { ...downloadOptions, pageOrigin: 'https://claude.ai' })).status, 'success');
      assert.equal((await downloadAttachment(url, downloadOptions)).status, 'error');
    }
  });
});

test('accepts provider redirects to approved file hosts and rejects foreign final hosts', async () => {
  for (const [finalUrl, expected] of [
    ['https://files.oaiusercontent.com/signed-paper.pdf', 'success'],
    ['https://untrusted.test/paper.pdf', 'error'],
    ['http://files.oaiusercontent.com/paper.pdf', 'error'],
  ]) {
    await withFetch(async (_url, options) => {
      assert.equal(options.redirect, 'follow');
      const response = new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'application/pdf' } });
      Object.defineProperty(response, 'url', { value: finalUrl });
      return response;
    }, async () => {
      const result = await downloadAttachment('https://chatgpt.com/file-download', downloadOptions);
      assert.equal(result.status, expected);
      if (expected === 'success') assert.equal(result.filename, 'signed-paper.pdf');
      else assert.match(result.error, /redirected/);
    });
  }
});


test('toolbar capture injects the source script in the sender tab and relays attachment counts', async () => {
  const captureResponse = { status: 'success', data: conversation(), capturedAttachments: 2, unavailableAttachments: 1 };
  const h = backgroundHarness({ captureResponse });
  const result = await h.send({ type: 'CAPTURE_ACTIVE_TAB' }, { id: 'extension-id', tab: { id: 7, url: 'https://claude.ai/chat/current' } });
  assert.equal(result, captureResponse);
  assert.equal(h.calls.some((call) => call.method === 'query'), false);
  assert.equal(h.calls[0].invocation.target.tabId, 7);
  assert.deepEqual(Array.from(h.calls[0].invocation.files), ['content-source.js']);
  assert.equal(h.calls[1].method, 'sendMessage');
  assert.equal(h.calls[1].tabId, 7);
  assert.equal(h.calls[1].message.type, 'EXTRACT');
});

test('capture from an extension page queries the active tab and reports connection failures', async () => {
  const h = backgroundHarness({ captureError: 'No receiving content script' });
  const result = await h.send({ type: 'CAPTURE_ACTIVE_TAB' });
  assert.equal(h.calls[0].method, 'query');
  assert.equal(h.calls[1].invocation.target.tabId, 99);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Refresh the source page/);
});

test('harvests committed message props without following root stores or React ownership', async () => {
  const current = { name: 'current.pdf', download_url: 'https://claude.ai/current.pdf' };
  const unrelated = { name: 'report.pdf', download_url: 'https://claude.ai/stale.pdf' };
  const root = {
    closest() { return null; },
    getClientRects() { return [{}]; },
    querySelectorAll() { return []; },
    __reactProps$test: { attachment: current, _owner: { memoizedProps: unrelated }, store: unrelated },
    __reactFiber$test: { memoizedProps: { attachment: current }, memoizedState: unrelated, sibling: { memoizedProps: unrelated }, return: { memoizedProps: unrelated } },
  };
  const document = {
    querySelectorAll(selector) { return selector === 'article[data-testid^="conversation-turn-"]' ? [root] : []; },
    getElementById() { throw new Error('Must never inspect app roots or Next data'); },
  };
  const h = backgroundHarness({ document });
  const result = await h.send({ type: 'HARVEST_FIBER_URLS' }, { id: 'extension-id', tab: { id: 7, url: 'https://claude.ai/chat/current' } });
  assert.equal(result.status, 'success');
  assert.deepEqual(Array.from(result.urls, (entry) => entry.url), [current.download_url]);
});
