require('./helpers.cjs');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

class MockDataTransfer {
  files = [];
  items = { add: (file) => this.files.push(file) };
}
class MockDragEvent extends Event {
  constructor(type, options) { super(type, options); this.dataTransfer = options.dataTransfer; }
}
class MockTextarea extends EventTarget {
  value = '';
  getClientRects() { return [{}]; }
  getAttribute() { return null; }
  closest() { return this.parentElement; }
  focus() {}
}
class MockInput extends EventTarget {
  disabled = false;
  multiple = true;
  accept = '';
  files = [];
  hasAttribute() { return false; }
}
global.DataTransfer = MockDataTransfer;
global.DragEvent = MockDragEvent;
global.HTMLTextAreaElement = MockTextarea;
global.window = { location: { hostname: 'chatgpt.com' } };
let snapshot, blobs, input, composer, messages;
global.chrome = { runtime: {
  onMessage: { addListener() {} },
  sendMessage(request, callback) {
    messages.push(request);
    callback(request.type === 'FETCH_TRANSCRIPT' ? snapshot : {
      status: 'success', blob: blobs.find((blob) => blob.alias === request.alias && blob.transferId === request.transferId) || null,
    });
  },
}, storage: { local: { remove() { throw new Error('A paste must not delete its saved transfer.'); } } } };
global.document = {
  querySelector(selector) { return selector === '#prompt-textarea' ? composer : null; },
  querySelectorAll(selector) {
    if (selector === 'input[type="file"]') return [input];
    if (selector === '*') return [input, composer];
    return [composer];
  },
};
const { injectTransfer } = require('../src/content/target.ts');
const { attachFilesToPage, matchesFileAccept } = require('../src/shared/attachmentUpload.ts');

beforeEach(() => {
  input = new MockInput();
  composer = new MockTextarea();
  composer.parentElement = { contains: (element) => element === input };
  messages = [];
  snapshot = { transferId: 'capture-A', payload: {
    version: '1.0', metadata: { source: 'Claude', createdAt: '2026-11-25T12:00:00Z' },
    messages: [{ id: 'message-1', role: 'user', content: [{ type: 'text/markdown', text: 'Read this report.' }],
      attachments: [{ id: 'file-1', kind: 'file', name: 'report.pdf', blobAlias: 1 }] }],
  } };
  const bytes = Buffer.from('%PDF-1.7\noriginal file bytes');
  blobs = [{ transferId: 'capture-A', alias: 1, name: 'report.pdf', mimeType: 'application/pdf',
    size: bytes.length, dataBase64: bytes.toString('base64') }];
});

test('inline paste stages original binary bytes with their filename and MIME type', async () => {
  const result = await injectTransfer({ type: 'INJECT' });
  assert.equal(result.status, 'success');
  assert.equal(result.attachmentResult.attached, 1);
  assert.equal(input.files[0].name, 'report.pdf');
  assert.equal(input.files[0].type, 'application/pdf');
  assert.equal(await input.files[0].text(), '%PDF-1.7\noriginal file bytes');
  assert.match(composer.value, /Read this report/);
  assert.doesNotMatch(composer.value, /could NOT be automatically uploaded/);
  assert.deepEqual(messages.find((message) => message.type === 'FETCH_ATTACHMENT'), {
    type: 'FETCH_ATTACHMENT', transferId: 'capture-A', alias: 1,
  });
});

test('originals are loaded in separate messages and duplicate references share one file', async () => {
  snapshot.payload.messages[0].attachments.push(
    { id: 'file-2', kind: 'image', name: 'picture.png', blobAlias: 2 },
    { id: 'file-1-copy', kind: 'file', name: 'report.pdf', blobAlias: 1 },
  );
  blobs.push({ transferId: 'capture-A', alias: 2, name: 'picture.png', mimeType: 'image/png', size: 3, dataBase64: btoa('png') });
  const result = await injectTransfer({ type: 'INJECT' });
  assert.equal(result.attachmentResult.attached, 2);
  assert.deepEqual(messages.filter((message) => message.type === 'FETCH_ATTACHMENT').map((message) => message.alias), [1, 2]);
  assert.equal(messages.some((message) => message.type === 'FETCH_ATTACHMENTS'), false);
});

test('paste-as-file adds transcript and originals in one change event', async () => {
  let changes = 0;
  input.addEventListener('change', () => changes++);
  const result = await injectTransfer({ type: 'INJECT_FILE', transferId: 'capture-A',
    base64: btoa('Transcript contents'), filename: 'chat.txt', mimeType: 'text/plain' });
  assert.equal(result.status, 'success');
  assert.equal(changes, 1);
  assert.deepEqual(input.files.map((file) => file.name), ['chat.txt', 'report.pdf']);
  assert.equal(result.attachmentResult.attached, 1, 'original count excludes the transcript');
});

test('raw paste reports missing original bytes and excludes ordinary links from missing files', async () => {
  blobs = [];
  snapshot.payload.messages[0].attachments.push({ id: 'link-1', kind: 'link', name: 'Documentation' });
  const result = await injectTransfer({ type: 'INJECT_RAW' });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.attachmentResult.missing, ['report.pdf']);
  assert.match(composer.value, /Files still needed in this chat: report.pdf/);
  assert.equal(input.files.length, 0);
});

test('a mismatched capture is rejected before any original files are staged', async () => {
  const result = await injectTransfer({ type: 'INJECT_FILE', transferId: 'capture-B',
    base64: btoa('old transcript'), filename: 'chat.txt', mimeType: 'text/plain' });
  assert.equal(result.status, 'error');
  assert.match(result.error, /selected capture changed/);
  assert.equal(input.files.length, 0);
  assert.equal(messages.length, 1);
});

test('disabled or incompatible upload inputs and ignored drops never count as staged', () => {
  const pdf = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
  input.disabled = true;
  assert.equal(attachFilesToPage([pdf]).attached.length, 0);
  input.disabled = false;
  input.accept = 'image/*';
  assert.equal(attachFilesToPage([pdf]).attached.length, 0);
  input.accept = '';
  input.multiple = false;
  assert.equal(attachFilesToPage([pdf, new File(['text'], 'chat.txt')]).attached.length, 0);
});

test('canceling dragover alone does not claim a file batch was staged', () => {
  input.disabled = true;
  composer.addEventListener('dragover', (event) => event.preventDefault());
  assert.equal(attachFilesToPage([new File(['one'], 'one.txt')]).attached.length, 0);
});

test('a composer that accepts the drop can stage a complete batch', () => {
  input.disabled = true;
  composer.addEventListener('drop', (event) => event.preventDefault());
  const files = [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')];
  const result = attachFilesToPage(files);
  assert.equal(result.method, 'drop');
  assert.deepEqual(result.attached, files);
});

test('file inputs outside the composer container are not used', () => {
  composer.parentElement = { contains: () => false };
  assert.equal(attachFilesToPage([new File(['one'], 'one.txt')]).attached.length, 0);
  assert.equal(input.files.length, 0);
});

test('accept rules support case-insensitive extensions and MIME families', () => {
  assert.equal(matchesFileAccept({ name: 'REPORT.PDF', type: 'application/pdf' }, '.pdf,image/*'), true);
  assert.equal(matchesFileAccept({ name: 'picture.png', type: 'image/png' }, 'image/*'), true);
  assert.equal(matchesFileAccept({ name: 'report.pdf', type: 'application/pdf' }, 'image/*'), false);
  assert.equal(matchesFileAccept({ name: 'unknown', type: '' }, '*/*'), true);
});
