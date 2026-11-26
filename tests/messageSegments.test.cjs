require('./helpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeMessageSegments } = require('../src/content/messageSegments.ts');
const message = (name, url, text = 'Please read this file.') => ({
  id: 'm1', role: 'user', content: [{ type: 'text/markdown', text }], attachments: [{ id: 'a1', kind: 'file', name, url }]
});

test('same-role same-text turns with different PDFs remain separate', () => {
  const first = message('one.pdf', 'https://claude.ai/one.pdf');
  const second = message('two.pdf', 'https://claude.ai/two.pdf');
  const result = mergeMessageSegments([[first], [second]]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((turn) => turn.attachments[0].name), ['one.pdf', 'two.pdf']);
});

test('overlapping scroll samples of the same original remain one turn', () => {
  const result = mergeMessageSegments([
    [message('one.pdf', 'https://claude.ai/one.pdf')],
    [message('one.pdf', 'https://claude.ai/one.pdf')]
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].attachments.length, 1);
});

test('attachment-only turns with the same generic label preserve distinct originals', () => {
  const result = mergeMessageSegments([
    [message('Image 1', 'https://claude.ai/one.png', '')],
    [message('Image 1', 'https://claude.ai/two.png', '')]
  ]);
  assert.equal(result.length, 2);
});
