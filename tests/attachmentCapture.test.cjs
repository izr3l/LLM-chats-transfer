require('./helpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureAttachmentBlobs } = require('../src/content/attachmentCapture.ts');
const { extractMessageAttachments } = require('../src/adapters/sources/attachmentExtraction.ts');

function conversation(attachments) {
  return {
    version: '1.0',
    metadata: { source: 'test', createdAt: '2026-11-25T12:00:00Z' },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text/markdown', text: '' }], attachments }]
  };
}
function download(bytes, filename = 'report.pdf', mimeType = 'application/pdf') {
  return { status: 'success', dataBase64: bytes.toString('base64'), size: bytes.length, filename, mimeType };
}

// Minimal DOM fixture for the attribute selectors used by attachment extraction.
function element(localName, attrs = {}, children = [], text = '') {
  const node = {
    localName,
    parentElement: null,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    getClientRects: () => [{}],
    get textContent() { return [text, ...children.map((child) => child.textContent)].filter(Boolean).join('\n'); },
    descendants() { return children.flatMap((child) => [child, ...child.descendants()]); },
    contains(other) { return this === other || this.descendants().includes(other); },
    matches(selectors) {
      return selectors.split(',').some((selector) => {
        selector = selector.trim();
        const tag = /^[a-z]+/.exec(selector)?.[0];
        if (tag && tag !== localName) return false;
        return [...selector.matchAll(/\[([a-z-]+)(?:(\*=|=)"([^"]+)"(?: i)?|)\]/g)]
          .every(([, key, operator, value]) => this.hasAttribute(key) &&
            (!operator || (operator === '*=' ? attrs[key].includes(value) : attrs[key] === value)));
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); },
    querySelectorAll(selector) { return this.descendants().filter((child) => child.matches(selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test('Claude file cards use nested explicit file URLs rather than navigation links', async () => {
  global.window = { location: { href: 'https://claude.ai/chat/thread' } };
  const card = element('div', { 'data-testid': 'attachment-card' }, [
    element('span', { 'data-testid': 'attachment-title' }, [], 'Unstandardized coef plot'),
    { ...element('img', { src: '/thumbnail.jpg' }), alt: 'Report thumbnail' },
    element('a', { href: '/chat/thread?preview=234' }, [], 'Preview'),
    element('button', { 'data-testid': 'file-download', 'data-file-url': '/api/files/234/download' }, [], 'Open'),
  ]);
  const message = element('article', {}, [card]);
  element('a', { href: '/unrelated.pdf', download: 'outside.pdf' }, [message]);
  const refs = extractMessageAttachments(message, 0, true);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'Unstandardized coef plot');
  assert.equal(refs[0].kind, 'file');
  assert.equal(refs[0].url, 'https://claude.ai/api/files/234/download');

  const bytes = Buffer.from('%PDF-1.4\nsource PDF');
  const result = await captureAttachmentBlobs(conversation(refs), async (request) => {
    assert.equal(request.url, refs[0].url);
    return download(bytes, 'coef-plot.pdf');
  });
  assert.equal(result[0].name, 'coef-plot.pdf');
  assert.deepEqual(Buffer.from(result[0].dataBase64, 'base64'), bytes);
});

test('Claude file preview must be open, card-owned, and expose actual PDF bytes', async () => {
  global.window = { location: { href: 'https://claude.ai/chat/thread' } };
  const attrs = { 'data-testid': 'file-card', 'aria-controls': 'own-preview', 'aria-expanded': 'true' };
  const card = element('button', attrs, [], 'Unstandardized coef plot');
  const message = element('article', {}, [card]);
  const pdf = element('object', { type: 'application/pdf', data: '/opaque-file' });
  const panel = element('div', {}, [pdf]);
  const unrelated = element('div', {}, [element('embed', { type: 'application/pdf', src: '/other-file' })]);
  card.ownerDocument = { getElementById: (id) => ({ 'own-preview': panel, 'other-preview': unrelated })[id] };

  const refs = extractMessageAttachments(message, 0, true);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://claude.ai/opaque-file');
  assert.equal(refs[0].mimeType, 'application/pdf');
  const errorPage = Buffer.from('<html>expired preview</html>');
  const result = await captureAttachmentBlobs(conversation(refs), async () => download(errorPage, 'attachment'));
  assert.equal(result.length, 0);
  assert.ok(refs[0].captureError);
  attrs['aria-expanded'] = 'false';
  assert.equal(extractMessageAttachments(message, 0, true)[0].url, undefined);
  attrs['aria-expanded'] = 'true';
  delete attrs['aria-controls'];
  assert.equal(extractMessageAttachments(message, 0, true)[0].url, undefined);
});

test('captures original PDF bytes, falls back to background, and reuses aliases for duplicate URLs', async () => {
  const bytes = Buffer.from('%PDF-1.4\noriginal\0\xff', 'binary');
  const refs = [
    { id: 'a', kind: 'file', name: 'report.pdf', url: 'https://claude.ai/report.pdf' },
    { id: 'b', kind: 'file', name: 'report.pdf', url: 'https://claude.ai/report.pdf' }
  ];
  const requests = [];
  const result = await captureAttachmentBlobs(conversation(refs), async (request) => {
    requests.push(request.type);
    return request.type === 'DOWNLOAD_IN_PAGE' ? { status: 'error', error: 'CORS' } : download(bytes);
  });
  assert.deepEqual(requests, ['DOWNLOAD_IN_PAGE', 'DOWNLOAD_ATTACHMENT_URL']);
  assert.equal(result.length, 1);
  assert.deepEqual(Buffer.from(result[0].dataBase64, 'base64'), bytes);
  assert.equal(refs[0].blobAlias, 1);
  assert.equal(refs[1].blobAlias, 1);
});

test('captures blob and data images in the source context', async () => {
  for (const url of ['blob:https://chatgpt.com/123', 'data:image/png;base64,iVBORw==']) {
    const refs = [{ id: 'a', kind: 'image', name: 'photo.png', url }];
    const requests = [];
    const result = await captureAttachmentBlobs(conversation(refs), async (request) => {
      requests.push(request);
      return download(Buffer.from([137, 80, 78, 71]), 'photo.png', 'image/png');
    });
    assert.equal(result.length, 1);
    assert.deepEqual(requests, [{ type: 'DOWNLOAD_IN_PAGE', url }]);
  }
});

test('preview-only images never regain a thumbnail URL through filename harvesting', async () => {
  const refs = [
    { id: 'preview', kind: 'image', name: 'photo.png', sourceHint: 'image-preview' },
    { id: 'file', kind: 'file', name: 'report.pdf' },
  ];
  const result = await captureAttachmentBlobs(conversation(refs), async (request) => {
    if (request.type === 'HARVEST_FIBER_URLS') return {
      status: 'success', urls: [{ url: 'https://claude.ai/thumbnail/photo.png', name: 'photo.png' }],
    };
    assert.fail('Preview-only images must not be downloaded as originals.');
  });
  assert.equal(result.length, 0);
  assert.equal(refs[0].url, undefined);
  assert.equal(refs[0].blobAlias, undefined);
  assert.ok(refs[0].captureError);
});

test('does not invent PDF bytes from rendered text or attach unrelated harvested assets', async () => {
  const refs = [{ id: 'a', kind: 'file', name: 'missing.pdf', textContent: 'A preview of a PDF document.' }];
  const chat = conversation(refs);
  const requests = [];
  const result = await captureAttachmentBlobs(chat, async (request) => {
    requests.push(request.type);
    return { status: 'success', urls: [{ url: 'https://claude.ai/other.pdf', name: 'other.pdf' }] };
  });
  assert.equal(result.length, 0);
  assert.deepEqual(requests, ['HARVEST_FIBER_URLS']);
  assert.equal(refs[0].blobAlias, undefined);
  assert.match(refs[0].captureError, /downloadable original/);
  assert.equal(chat.metadata.extensions.unavailableAttachments, '1');
  assert.equal(chat.messages[0].attachments.length, 1);
});

test('matches only unique exact filenames and rejects ambiguous harvest matches', async () => {
  const refs = [
    { id: 'a', kind: 'file', name: 'report.pdf' },
    { id: 'b', kind: 'file', name: 'ambiguous.pdf' }
  ];
  const result = await captureAttachmentBlobs(conversation(refs), async (request) => {
    if (request.type === 'HARVEST_FIBER_URLS') return {
      status: 'success', urls: [
        { url: 'https://claude.ai/1', name: 'REPORT.PDF' },
        { url: 'https://claude.ai/2', name: 'ambiguous.pdf' },
        { url: 'https://claude.ai/3', name: 'ambiguous.pdf' },
        { url: 'https://claude.ai/4', name: 'report.pdf.backup' }
      ]
    };
    assert.equal(request.url, 'https://claude.ai/1');
    return download(Buffer.from('%PDF-1.4'));
  });
  assert.equal(result.length, 1);
  assert.equal(refs[0].blobAlias, 1);
  assert.equal(refs[1].blobAlias, undefined);
  assert.match(refs[1].captureError, /downloadable original/);
});

test('rejects incomplete binary replies, continues other files, and ignores normal links', async () => {
  const refs = [
    { id: 'a', kind: 'file', name: 'broken.pdf', url: 'https://claude.ai/broken.pdf' },
    { id: 'b', kind: 'file', name: 'empty.txt', url: 'https://claude.ai/empty.txt' },
    { id: 'c', kind: 'link', name: 'Reference', url: 'https://example.com' }
  ];
  const chat = conversation(refs);
  const result = await captureAttachmentBlobs(chat, async (request) => {
    assert.notEqual(request.url, 'https://example.com');
    if (request.url.includes('broken')) return { status: 'success', dataBase64: 'bm8=', size: 999 };
    return download(Buffer.alloc(0), 'empty.txt', 'text/plain');
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'empty.txt');
  assert.equal(refs[0].blobAlias, undefined);
  assert.ok(refs[0].captureError);
  assert.equal(refs[1].blobAlias, 1);
  assert.equal(chat.metadata.extensions.unavailableAttachments, '1');
});

test('rejects download metadata JSON rather than renaming it as a PDF', async () => {
  const refs = [{ id: 'a', kind: 'file', name: 'report.pdf', url: 'https://claude.ai/api/file' }];
  const result = await captureAttachmentBlobs(conversation(refs), async () =>
    download(Buffer.from('{"download_url":"https://claude.ai/real.pdf"}'), 'report.pdf', 'application/json'));
  assert.equal(result.length, 0);
  assert.equal(refs[0].blobAlias, undefined);
  assert.match(refs[0].captureError, /unexpected format/);
});

test('uses an original server filename or image extension instead of image alt prose', async () => {
  const refs = [{ id: 'a', kind: 'image', name: 'A photo of a tree', url: 'https://claude.ai/photo' }];
  const result = await captureAttachmentBlobs(conversation(refs), async () =>
    download(Buffer.from([137, 80, 78, 71]), 'original-tree.png', 'image/png'));
  assert.equal(result[0].name, 'original-tree.png');
  const genericRefs = [{ id: 'b', kind: 'image', name: 'Image 1', url: 'https://claude.ai/other' }];
  const generic = await captureAttachmentBlobs(conversation(genericRefs), async () =>
    download(Buffer.from([137, 80, 78, 71]), 'attachment', 'image/png'));
  assert.equal(generic[0].name, 'image.png');
});

test('stages one attachment per message before publishing the transcript', async () => {
  const { storeCapturedConversation } = require('../src/content/attachmentCapture.ts');
  const chat = conversation([]);
  const blobs = [
    { transferId: '', alias: 1, name: 'one.txt', mimeType: 'text/plain', dataBase64: 'MQ==', size: 1 },
    { transferId: '', alias: 2, name: 'two.txt', mimeType: 'text/plain', dataBase64: 'Mg==', size: 1 }
  ];
  const messages = [];
  const transferId = await storeCapturedConversation(chat, blobs, async (message) => {
    messages.push(message);
    return { status: 'success', transferId: message.stagedTransferId };
  });
  assert.deepEqual(messages.map((message) => message.type), ['STORE_ATTACHMENTS', 'STORE_ATTACHMENTS', 'STORE_TRANSCRIPT']);
  assert.equal(messages[0].blobs.length, 1);
  assert.equal(messages[1].blobs.length, 1);
  assert.equal(messages[0].transferId, messages[1].transferId);
  assert.equal(messages[2].stagedTransferId, transferId);
  assert.equal(messages[2].blobs, undefined);
});

test('storage failure discards staged files and never reports successful capture', async () => {
  const { storeCapturedConversation } = require('../src/content/attachmentCapture.ts');
  const messages = [];
  await assert.rejects(storeCapturedConversation(conversation([]), [
    { transferId: '', alias: 1, name: 'one.txt', mimeType: 'text/plain', dataBase64: 'MQ==', size: 1 },
    { transferId: '', alias: 2, name: 'two.txt', mimeType: 'text/plain', dataBase64: 'Mg==', size: 1 }
  ], async (message) => {
    messages.push(message);
    return messages.length === 2 ? { status: 'error', error: 'Disk is full.' } : { status: 'success' };
  }), /Disk is full/);
  assert.deepEqual(messages.map((message) => message.type), ['STORE_ATTACHMENTS', 'STORE_ATTACHMENTS', 'DISCARD_STAGED_ATTACHMENTS']);
  assert.equal(messages[2].transferId, messages[0].transferId);
});

test('accepts common PDF MIME aliases while validating original PDF bytes', async () => {
  const refs = [{ id: 'a', kind: 'file', name: 'report.pdf', url: 'https://claude.ai/report.pdf' }];
  const result = await captureAttachmentBlobs(conversation(refs), async () =>
    download(Buffer.from('%PDF-1.4\noriginal'), 'report.pdf', 'application/x-pdf'));
  assert.equal(result.length, 1);
  assert.equal(result[0].mimeType, 'application/pdf');
});
