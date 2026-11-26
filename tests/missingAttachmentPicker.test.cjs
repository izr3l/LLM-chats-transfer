require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountMissingAttachmentPicker } = require('../src/shared/missingAttachmentPicker.ts');

class Element {
  children = [];
  listeners = new Map();
  attributes = new Map();
  fileChooserOpened = false;

  constructor(tag) { this.tag = tag; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { this.fileChooserOpened = true; }
  emit(type, isTrusted = true) { return this.listeners.get(type)?.({ isTrusted }); }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => child.tag === tag ? [child] : child.querySelectorAll(tag));
  }
}

test('the picker links explicitly chosen bytes to the correct missing reference and removes the saved row', async () => {
  global.document = { createElement: (tag) => new Element(tag) };
  const panel = new Element('section');
  const filename = 'Unstandardized coef plot';
  const alreadySaved = { id: 'saved', kind: 'file', name: filename, blobAlias: 1 };
  const missing = { id: 'missing', kind: 'file', name: filename };
  const link = { id: 'link', kind: 'link', name: 'Related link' };
  const payload = { messages: [{ id: 'm1', attachments: [alreadySaved] }, { id: 'm2', attachments: [missing, link] }] };
  const writes = [];
  const feedback = [];
  const refresh = mountMissingAttachmentPicker(panel, async (request) => {
    if (request.type === 'FETCH_TRANSCRIPT') return { payload, transferId: 'existing-capture' };
    writes.push(request);
    missing.blobAlias = 2;
    return { status: 'success' };
  }, (...status) => feedback.push(status));

  await refresh();
  assert.equal(panel.hidden, false);
  const [button] = panel.querySelectorAll('button');
  assert.equal(panel.querySelectorAll('button').length, 1);
  assert.equal(button.attributes.get('aria-label'), `Add file for ${filename}`);
  const [input] = panel.querySelectorAll('input');
  button.emit('click', false);
  assert.equal(input.fileChooserOpened, false);
  button.emit('click');
  assert.equal(input.fileChooserOpened, true);

  const bytes = Uint8Array.of(21, 0, 127, 254);
  input.files = [new File([bytes], 'plot.pdf', { type: 'application/pdf' })];
  await input.emit('change', false);
  assert.equal(writes.length, 0);
  await input.emit('change');
  assert.deepEqual(writes, [{
    type: 'RESTORE_CAPTURE_ATTACHMENT', transferId: 'existing-capture', messageId: 'm2', attachmentId: 'missing',
    file: { name: 'plot.pdf', mimeType: 'application/pdf', size: 4, dataBase64: Buffer.from(bytes).toString('base64') },
  }]);
  assert.equal(feedback.at(-1)[1], 'success');
  assert.equal(panel.hidden, true);
});
