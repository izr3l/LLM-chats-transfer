require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatInjectionFeedback } = require('../src/shared/attachmentFeedback.ts');
const { isValidCanonicalConversation } = require('../src/schema/canonical.ts');
const { buildPlainText, buildMarkdown } = require('../src/shared/transcriptExport.ts');

const conversation = () => ({
  version: '1.0',
  metadata: { source: 'ChatGPT', createdAt: '2026-11-25T10:00:00Z' },
  messages: [{ id: '1', role: 'user', content: [], attachments: [{ id: 'pdf', kind: 'file', name: 'report.pdf', blobAlias: 1 }] }],
});

test('partial transfer feedback identifies originals requiring manual recovery', () => {
  const message = formatInjectionFeedback('Transcript added.', {
    status: 'partial',
    attachmentResult: { attempted: 2, attached: 1, missing: ['report.pdf'], failed: ['photo.png'] },
    warnings: ['Review uploads before sending.'],
  });
  assert.match(message, /1 original file added to the composer/);
  assert.match(message, /Originals unavailable: report.pdf/);
  assert.match(message, /Files not added: photo.png/);
  assert.match(message, /Review uploads before sending/);
  assert.doesNotMatch(message, /uploaded successfully/i);
});

test('plain transcript feedback does not fabricate attachment counts', () => {
  assert.equal(formatInjectionFeedback('Transcript added.', { status: 'success' }), 'Transcript added.');
});

test('malformed attachment aliases and attachment arrays are rejected', () => {
  const value = conversation();
  assert.equal(isValidCanonicalConversation(value), true);
  value.messages[0].attachments[0].blobAlias = NaN;
  assert.equal(isValidCanonicalConversation(value), false);
  value.messages[0].attachments = 'not-an-array';
  assert.equal(isValidCanonicalConversation(value), false);
});

test('standalone exports describe separately stored files without claiming upload failure', () => {
  for (const builder of [buildPlainText, buildMarkdown]) {
    const text = builder(conversation());
    assert.match(text, /report.pdf/);
    assert.match(text, /original files are stored separately/);
    assert.doesNotMatch(text, /not auto-uploaded|must re-upload/);
  }
});
