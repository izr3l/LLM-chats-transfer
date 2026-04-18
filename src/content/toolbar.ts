// LLM Chat Transfer — In-page floating toolbar
// Auto-injected on all supported provider pages.
// Uses Shadow DOM for complete CSS isolation from the host page.

import { ClaudeAdapter } from '../adapters/sources/claude';
import { GenericFallbackAdapter } from '../adapters/sources/fallback';
import { ManusAdapter } from '../adapters/sources/manus';
import { ChatGPTAdapter } from '../adapters/targets/chatgpt';
import { GenericTargetAdapter } from '../adapters/targets/fallback';
import { ManusTargetAdapter } from '../adapters/targets/manus';
import { CanonicalConversation } from '../schema/canonical';

declare global {
  interface Window {
    __chatTransferToolbarRegistered?: boolean;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeSha256(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
}

function msgBg<T = Record<string, unknown>>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Extension context error'));
      } else {
        resolve(resp as T);
      }
    });
  });
}

// ─── Adapter selection (mirrors source.ts / target.ts) ────────────────────────

function getSourceAdapter() {
  const host = window.location.hostname;
  if (host.includes('claude.ai')) return new ClaudeAdapter();
  if (host.includes('chatgpt.com'))
    return new GenericFallbackAdapter('ChatGPT', [
      'article[data-testid^="conversation-turn-"]',
      '[data-message-author-role]',
      '#prompt-textarea'
    ]);
  if (host.includes('gemini.google.com'))
    return new GenericFallbackAdapter('Gemini', [
      '[data-test-id="response-content"]',
      'message-content',
      'user-query',
      '.model-response-text'
    ]);
  if (host.includes('manus.im') || host.includes('manus.com') || host.includes('manus.ai') || host.includes('manus.computer'))
    return new ManusAdapter();
  if (host.includes('qwen.ai') || host.includes('qwenlm.ai') || host.includes('chat.qwen.ai'))
    return new GenericFallbackAdapter('Qwen', [
      '[data-role="assistant"]', '[data-role="user"]',
      '[data-testid*="message"]', '[class*="message"]', '[class*="chat-item"]',
      'main article', 'main .prose'
    ]);
  if (host.includes('perplexity.ai'))
    return new GenericFallbackAdapter('Perplexity', [
      '[data-testid*="answer"]', '[data-testid*="query"]', 'main .prose', 'article'
    ]);
  if (host.includes('x.com'))
    return new GenericFallbackAdapter('Grok', [
      '[data-testid="messageEntry"]', '[data-testid="tweetText"]', 'article'
    ]);
  return null;
}

function getTargetAdapter(): import('../adapters/targets').TargetAdapter | null {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) return new ChatGPTAdapter();
  if (host.includes('claude.ai'))
    return new GenericTargetAdapter('Claude', [
      'div[contenteditable="true"]', 'div[role="textbox"]', 'textarea'
    ]);
  if (host.includes('gemini.google.com'))
    return new GenericTargetAdapter('Gemini', [
      'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'
    ]);
  if (host.includes('manus.im') || host.includes('manus.com') || host.includes('manus.ai') || host.includes('manus.computer'))
    return new ManusTargetAdapter();
  if (host.includes('qwen.ai') || host.includes('qwenlm.ai') || host.includes('chat.qwen.ai'))
    return new GenericTargetAdapter('Qwen', [
      'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'
    ]);
  if (host.includes('perplexity.ai'))
    return new GenericTargetAdapter('Perplexity', [
      'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'
    ]);
  if (host.includes('x.com'))
    return new GenericTargetAdapter('Grok', [
      'textarea[data-testid="tweetTextarea_0"]', 'div[contenteditable="true"]', 'div[role="textbox"]'
    ]);
  return null;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function actionExtract(): Promise<string> {
  const adapter = getSourceAdapter();
  if (!adapter) throw new Error('This page is not supported for extraction.');

  let conversation = adapter.extractConversation();
  let count = conversation.messages.length;

  if (count === 0) {
    const broad = new GenericFallbackAdapter(window.location.hostname, [
      '[data-testid*="message"]', '[data-testid*="chat"]', '[data-message-author]',
      '[data-role]', '[class*="message"]', '[class*="chat"]',
      'main article', 'main .prose', 'main p'
    ]);
    const fallback = broad.extractConversation();
    if (fallback.messages.length > 0) { conversation = fallback; count = fallback.messages.length; }
  }

  if (count === 0) throw new Error('No messages found. Try scrolling through the full conversation first.');

  if (!conversation.integrity) conversation.integrity = { messageCount: count };
  conversation.integrity.sha256 = await computeSha256(
    JSON.stringify({ metadata: conversation.metadata, messages: conversation.messages })
  );

  const result = await msgBg<{ status: string; error?: string }>({
    type: 'STORE_TRANSCRIPT',
    payload: conversation
  });

  if (result.status !== 'success') throw new Error(result.error ?? 'Failed to store transcript.');
  return `${count} message${count !== 1 ? 's' : ''} captured from ${conversation.metadata.source}.`;
}

async function actionPaste(): Promise<string> {
  const adapter = getTargetAdapter();
  if (!adapter) throw new Error('This page is not supported for pasting.');

  const result = await msgBg<{ payload?: CanonicalConversation | null; error?: string }>({
    type: 'FETCH_TRANSCRIPT'
  });

  const transcript = result?.payload;
  if (!transcript) throw new Error('No captured chat found. Extract a chat first.');

  // Prefer file-based injection when the adapter supports it (e.g. Manus)
  let success: boolean;
  if (typeof adapter.injectViaFile === 'function') {
    success = await adapter.injectViaFile(transcript);
    if (!success) throw new Error('File attachment failed. Try clicking the chat input first and retry.');
    return 'Transcript attached as a text file.';
  }

  const prompt = adapter.generateSingleShotPrompt(transcript);
  success = adapter.injectPrompt(prompt);
  if (!success) throw new Error('Could not inject into the text box. Try clicking the input area first.');
  return 'Chat injected into the text box.';
}

/** Try to attach a File object to the page via DataTransfer (file input or drag-drop). */
function tryAttachFile(file: File): boolean {
  // Strategy 1: programmatic file input
  const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  for (const inp of fileInputs) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch { /* try next */ }
  }
  // Strategy 2: synthetic drag-drop on the composer
  const dropSelectors = [
    '.ProseMirror', '[data-lexical-editor]', '[role="textbox"]',
    'textarea', 'div[contenteditable]', '[data-testid*="composer"]',
    '[data-testid*="input"]', 'form', 'main',
  ];
  for (const sel of dropSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** Paste raw message text with no system-prompt framing. */
async function actionPasteRaw(): Promise<string> {
  const adapter = getTargetAdapter();
  if (!adapter) throw new Error('This page is not supported for pasting.');

  const result = await msgBg<{ payload?: CanonicalConversation | null }>({ type: 'FETCH_TRANSCRIPT' });
  const transcript = result?.payload;
  if (!transcript) throw new Error('No captured chat found. Capture a chat first.');

  const raw = transcript.messages.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.content.map((c) => c.text).join('\n').trim();
    return `${role}:\n${text}`;
  }).join('\n\n');

  const success = adapter.injectPrompt(raw);
  if (!success) throw new Error('Could not inject into the text box. Try clicking the input area first.');
  return 'Raw transcript injected into the text box.';
}

type AttachFormat = 'pdf' | 'txt' | 'docx';

/** Build a file and try to attach it to the page; fall back to download. */
async function actionPasteAsFile(fmt: AttachFormat): Promise<string> {
  const transcript = await fetchTranscript();
  const base = safeName(transcript.metadata.title);

  let blob: Blob;
  let filename: string;

  if (fmt === 'txt') {
    blob = new Blob([buildPlainText(transcript)], { type: 'text/plain' });
    filename = `${base}.txt`;
  } else if (fmt === 'docx') {
    blob = buildDocxBlob(transcript);
    filename = `${base}.doc`;
  } else {
    blob = new Blob([buildPdfBytes(transcript).buffer as ArrayBuffer], { type: 'application/pdf' });
    filename = `${base}.pdf`;
  }

  const file = new File([blob], filename, { type: blob.type });
  const attached = tryAttachFile(file);
  if (attached) return `${fmt.toUpperCase()} file attached to the chat input.`;

  // Fallback: trigger download so user can attach manually
  triggerDownload(blob, filename);
  return `${fmt.toUpperCase()} downloaded — attach it to the chat input manually.`;
}

async function actionSummarize(): Promise<string> {
  const result = await msgBg<{ status: string; summary?: string; source?: string; title?: string; messageCount?: number; providerName?: string; error?: string }>({
    type: 'SUMMARIZE_TRANSCRIPT'
  });
  if (result.status !== 'success') throw new Error(result.error ?? 'Summarization failed.');
  return result.summary ?? '';
}

// ─── Download format generators ───────────────────────────────────────────────

type DownloadFormat = 'txt' | 'md' | 'docx' | 'pdf';

async function fetchTranscript(): Promise<CanonicalConversation> {
  const result = await msgBg<{ payload?: CanonicalConversation | null }>({
    type: 'FETCH_TRANSCRIPT'
  });
  if (!result?.payload) throw new Error('No captured chat to download. Capture first.');
  return result.payload;
}

function safeName(title?: string): string {
  return (title ?? 'chat').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
}

function buildPlainText(t: CanonicalConversation): string {
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;
  let out = `${title ?? 'Untitled Chat'}\n`;
  out += `Source: ${source}\nMessages: ${count}\nCaptured: ${new Date(createdAt).toLocaleString()}\n`;
  out += `${'─'.repeat(60)}\n\n`;
  out += `--- TRANSCRIPT START ---\n\n`;
  t.messages.forEach((msg) => {
    const role = msg.role === 'user' ? 'You' : source;
    const text = msg.content.map((c) => c.text).join('\n').trim();
    out += `[${role}]\n${text}\n`;
    if (msg.attachments && msg.attachments.length > 0) {
      out += `Attachments (not auto-uploaded — user must re-upload manually):\n`;
      msg.attachments.forEach((att) => {
        out += `  - [${att.kind}] ${att.name || 'unnamed file'}\n`;
      });
    }
    out += `\n${'─'.repeat(60)}\n\n`;
  });
  out += `--- TRANSCRIPT END ---\n`;
  return out;
}

function buildMarkdown(t: CanonicalConversation): string {
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;
  let md = `# ${title ?? 'Untitled Chat'}\n\n`;
  md += `**Source:** ${source}  \n`;
  md += `**Messages:** ${count}  \n`;
  md += `**Captured:** ${new Date(createdAt).toLocaleString()}  \n\n---\n\n`;
  md += `> --- TRANSCRIPT START ---\n\n`;
  t.messages.forEach((msg) => {
    const role = msg.role === 'user' ? '### You' : `### ${source}`;
    const text = msg.content.map((c) => c.text).join('\n').trim();
    md += `${role}\n\n${text}\n`;
    if (msg.attachments && msg.attachments.length > 0) {
      md += `\n**Attachments** *(not auto-uploaded — user must re-upload manually):*\n`;
      msg.attachments.forEach((att) => {
        md += `- \`[${att.kind}]\` ${att.name || 'unnamed file'}\n`;
      });
    }
    md += `\n---\n\n`;
  });
  md += `> --- TRANSCRIPT END ---\n`;
  return md;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildDocxBlob(t: CanonicalConversation): Blob {
  // Minimal OOXML .docx (single-file flat OPC for broad compatibility)
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;

  let body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(title ?? 'Untitled Chat')}</w:t></w:r></w:p>`;
  body += `<w:p><w:r><w:t>Source: ${escapeXml(source)}  |  Messages: ${count}  |  Captured: ${escapeXml(new Date(createdAt).toLocaleString())}</w:t></w:r></w:p>`;
  body += `<w:p><w:r><w:t>────────────────────────────────</w:t></w:r></w:p>`;
  body += `<w:p><w:r><w:t>--- TRANSCRIPT START ---</w:t></w:r></w:p>`;

  t.messages.forEach((msg) => {
    const role = msg.role === 'user' ? 'You' : source;
    const text = msg.content.map((c) => c.text).join('\n').trim();
    body += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${escapeXml(role)}</w:t></w:r></w:p>`;
    // Split by newlines so each line becomes its own run
    text.split('\n').forEach((line) => {
      body += `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
    });
    if (msg.attachments && msg.attachments.length > 0) {
      body += `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Attachments (not auto-uploaded — user must re-upload manually):</w:t></w:r></w:p>`;
      msg.attachments.forEach((att) => {
        body += `<w:p><w:r><w:t xml:space="preserve">  - [${escapeXml(att.kind)}] ${escapeXml(att.name || 'unnamed file')}</w:t></w:r></w:p>`;
      });
    }
    body += `<w:p><w:r><w:t>────────────────────────────────</w:t></w:r></w:p>`;
  });

  body += `<w:p><w:r><w:t>--- TRANSCRIPT END ---</w:t></w:r></w:p>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?mso-application progid="Word.Document"?>
<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wx="http://schemas.microsoft.com/office/word/2003/auxHint">
  <w:body>${body}</w:body>
</w:wordDocument>`;

  return new Blob([docXml], { type: 'application/vnd.ms-word;charset=utf-8' });
}

function buildPdfBytes(t: CanonicalConversation): Uint8Array {
  // Minimal valid PDF 1.4 built from scratch — no libraries needed
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;

  // Build text content as array of lines
  const lines: string[] = [];
  lines.push(title ?? 'Untitled Chat');
  lines.push(`Source: ${source}  |  Messages: ${count}  |  Captured: ${new Date(createdAt).toLocaleString()}`);
  lines.push('');
  lines.push('--- TRANSCRIPT START ---');
  lines.push('');

  t.messages.forEach((msg) => {
    const role = msg.role === 'user' ? 'You' : source;
    const text = msg.content.map((c) => c.text).join('\n').trim();
    lines.push(`[${role}]`);
    // Wrap long lines at ~90 chars
    text.split('\n').forEach((raw) => {
      if (raw.length <= 90) { lines.push(raw); return; }
      for (let i = 0; i < raw.length; i += 90) lines.push(raw.slice(i, i + 90));
    });
    if (msg.attachments && msg.attachments.length > 0) {
      lines.push('Attachments (not auto-uploaded):');
      msg.attachments.forEach((att) => {
        lines.push(`  - [${att.kind}] ${att.name || 'unnamed file'}`);
      });
    }
    lines.push('────────────────────────────────');
    lines.push('');
  });

  lines.push('--- TRANSCRIPT END ---');

  // PDF text operators (Tj) need parentheses-safe strings
  function pdfEsc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  // Split lines into pages (~55 lines per page)
  const LINES_PER_PAGE = 55;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push(['(empty)']);

  // Build PDF objects
  const objs: string[] = [];
  // obj 1: Catalog
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  // obj 2: Pages (kids filled below)
  const pageObjStart = 4; // first page content starts at obj 4
  const kids = pages.map((_, i) => `${pageObjStart + i * 2} 0 R`).join(' ');
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`);
  // obj 3: Font
  objs.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj');

  // Page + stream pairs
  pages.forEach((pageLines, pi) => {
    const pageObjNum = pageObjStart + pi * 2;
    const streamObjNum = pageObjNum + 1;

    // Build stream: place text starting from top
    let stream = 'BT\n/F1 10 Tf\n50 780 Td\n14 TL\n';
    pageLines.forEach((line) => {
      stream += `(${pdfEsc(line)}) Tj T*\n`;
    });
    stream += 'ET';

    objs.push(`${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${streamObjNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`);
    objs.push(`${streamObjNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  });

  // Assemble PDF
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((obj) => {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function actionDownload(format: DownloadFormat): Promise<string> {
  const transcript = await fetchTranscript();
  const name = safeName(transcript.metadata.title);
  switch (format) {
    case 'txt': {
      const blob = new Blob([buildPlainText(transcript)], { type: 'text/plain;charset=utf-8' });
      triggerDownload(blob, `${name}.txt`);
      return `Downloaded ${name}.txt`;
    }
    case 'md': {
      const blob = new Blob([buildMarkdown(transcript)], { type: 'text/markdown;charset=utf-8' });
      triggerDownload(blob, `${name}.md`);
      return `Downloaded ${name}.md`;
    }
    case 'docx': {
      triggerDownload(buildDocxBlob(transcript), `${name}.doc`);
      return `Downloaded ${name}.doc`;
    }
    case 'pdf': {
      const bytes = buildPdfBytes(transcript);
      triggerDownload(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }), `${name}.pdf`);
      return `Downloaded ${name}.pdf`;
    }
  }
}

// ─── Toolbar UI ───────────────────────────────────────────────────────────────

const STYLES = `
  :host { all: initial; }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  .fab {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: linear-gradient(135deg, #7c5cbf 0%, #5a3fa0 100%);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 16px rgba(124,92,191,0.45), 0 2px 6px rgba(0,0,0,0.3);
    transition: transform 0.2s cubic-bezier(.34,1.56,.64,1), box-shadow 0.2s;
    outline: none;
  }
  .fab:hover {
    transform: scale(1.1);
    box-shadow: 0 6px 24px rgba(124,92,191,0.6), 0 2px 8px rgba(0,0,0,0.4);
  }
  .fab:active { transform: scale(0.95); }
  .fab svg { width: 28px; height: 28px; border-radius: 6px; }

  .panel {
    position: fixed;
    bottom: 78px;
    right: 24px;
    z-index: 2147483646;
    width: 264px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,92,191,0.15);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    color: #e6edf3;
    overflow: hidden;
    transform-origin: bottom right;
    transform: scale(0.85) translateY(8px);
    opacity: 0;
    pointer-events: none;
    transition: transform 0.22s cubic-bezier(.34,1.56,.64,1), opacity 0.18s ease;
  }
  .panel.open {
    transform: scale(1) translateY(0);
    opacity: 1;
    pointer-events: all;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid #21262d;
  }
  .panel-header-logo {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .panel-header-logo svg { width: 24px; height: 24px; }
  .panel-title {
    flex: 1;
    font-weight: 600;
    font-size: 12.5px;
    color: #e6edf3;
    letter-spacing: 0.01em;
  }
  .panel-close {
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    color: #8b949e;
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
    padding: 0;
  }
  .panel-close:hover { background: #21262d; color: #e6edf3; }
  .panel-close svg { width: 14px; height: 14px; }

  .status-strip {
    padding: 8px 14px;
    background: #161b22;
    border-bottom: 1px solid #21262d;
    font-size: 11.5px;
    color: #8b949e;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #484f58;
    transition: background 0.3s;
  }
  .status-dot.ready { background: #3fb950; }
  .status-dot.pending { background: #d29922; }
  .status-text { flex: 1; line-height: 1.4; }

  .actions {
    padding: 10px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .action-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 10px 8px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    color: #e6edf3;
    cursor: pointer;
    font-size: 11.5px;
    font-weight: 500;
    transition: all 0.15s ease;
    font-family: inherit;
    line-height: 1.2;
    text-align: center;
  }
  .action-btn:hover:not(:disabled) {
    background: #21262d;
    border-color: #58a6ff;
    color: #58a6ff;
    transform: translateY(-1px);
    box-shadow: 0 3px 10px rgba(0,0,0,0.3);
  }
  .action-btn:active:not(:disabled) { transform: translateY(0); }
  .action-btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }
  .action-btn svg { width: 18px; height: 18px; }

  .action-btn.extract:hover:not(:disabled) { border-color: #3fb950; color: #3fb950; }
  .action-btn.paste:hover:not(:disabled)   { border-color: #58a6ff; color: #58a6ff; }
  .action-btn.summarize:hover:not(:disabled) { border-color: #bc8cff; color: #bc8cff; }
  .action-btn.download:hover:not(:disabled) { border-color: #79c0ff; color: #79c0ff; }

  .action-btn.loading { opacity: 0.7; pointer-events: none; }
  .action-btn.loading svg { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .feedback {
    margin: 0 10px 10px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 11.5px;
    line-height: 1.45;
    display: none;
  }
  .feedback.show { display: block; }
  .feedback.success { background: #0d2a18; border: 1px solid #1f5a2d; color: #3fb950; }
  .feedback.error   { background: #2a0d0d; border: 1px solid #5a1f1f; color: #f85149; }
  .feedback.info    { background: #0d1a2a; border: 1px solid #1f3a5a; color: #79c0ff; }

  .summary-area {
    margin: 0 10px 10px;
    max-height: 280px;
    overflow-y: auto;
    border-radius: 8px;
    border: 1px solid #30363d;
    background: #161b22;
    padding: 10px 12px;
    font-size: 11.5px;
    line-height: 1.6;
    color: #c9d1d9;
    display: none;
  }
  .summary-area.show { display: block; }
  .summary-area::-webkit-scrollbar { width: 4px; }
  .summary-area::-webkit-scrollbar-track { background: transparent; }
  .summary-area::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }

  .summary-area h1, .summary-area h2, .summary-area h3 {
    color: #e6edf3;
    font-size: 12px;
    margin: 8px 0 4px;
    font-weight: 600;
  }
  .summary-area h1 { font-size: 13px; margin-top: 0; }
  .summary-area ul, .summary-area ol { padding-left: 16px; }
  .summary-area li { margin: 2px 0; }
  .summary-area code {
    background: #0d1117;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 10.5px;
  }
  .summary-area p { margin: 4px 0; }
  .summary-area strong { color: #e6edf3; font-weight: 600; }

  .summary-close {
    margin: 0 10px 10px;
    width: calc(100% - 20px);
    padding: 6px;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #8b949e;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
    display: none;
  }
  .summary-close:hover { background: #30363d; color: #e6edf3; }
  .summary-close.show { display: block; }

  .summary-resync {
    margin: -4px 10px 10px;
    width: calc(100% - 20px);
    padding: 6px;
    background: #161b22;
    border: 1px solid #3d2f6e;
    border-radius: 8px;
    color: #bc8cff;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    display: none;
  }
  .summary-resync:hover { background: #1e1535; border-color: #bc8cff; color: #d2a8ff; }
  .summary-resync.show { display: block; }

  .format-picker {
    margin: 0 10px 10px;
    border: 1px solid #30363d;
    border-radius: 8px;
    background: #161b22;
    overflow: hidden;
    display: none;
  }
  .format-picker.show { display: block; }
  .format-picker-title {
    padding: 8px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 1px solid #21262d;
  }
  .format-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid #21262d;
    color: #e6edf3;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s;
    text-align: left;
  }
  .format-option:last-child { border-bottom: none; }
  .format-option:hover { background: #21262d; }
  .format-option .fmt-icon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .format-option .fmt-txt  { background: #2d333b; color: #8b949e; }
  .format-option .fmt-md   { background: #1f3a2e; color: #3fb950; }
  .format-option .fmt-doc  { background: #1a2744; color: #58a6ff; }
  .format-option .fmt-pdf  { background: #3b1a1a; color: #f85149; }
  .format-option .fmt-label { flex: 1; }
  .format-option .fmt-desc { font-size: 10.5px; color: #8b949e; }

  /* ── Paste mode picker ── */
  .paste-picker {
    display: none;
    border-top: 1px solid #30363d;
    background: #0d1117;
    border-radius: 0 0 10px 10px;
    overflow: hidden;
  }
  .paste-picker.show { display: block; }
  .paste-picker-title {
    padding: 7px 12px 5px;
    font-size: 10.5px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .paste-option {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: #c9d1d9;
    border-bottom: 1px solid #21262d;
    text-align: left;
    transition: background .12s;
  }
  .paste-option:last-child { border-bottom: none; }
  .paste-option:hover { background: #21262d; }
  .paste-option .po-icon {
    width: 30px; height: 18px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700; flex-shrink: 0;
  }
  .paste-option .po-inline { background: #1f2b3a; color: #58a6ff; }
  .paste-option .po-raw    { background: #1f2b1f; color: #3fb950; }
  .paste-option .po-pdf    { background: #3b1a1a; color: #f85149; }
  .paste-option .po-txt    { background: #2d333b; color: #8b949e; }
  .paste-option .po-doc    { background: #1a2744; color: #79c0ff; }
  .paste-option .po-label  { flex: 1; }
  .paste-option .po-desc   { font-size: 10.5px; color: #8b949e; }

  /* ── History drawer ── */
  .history-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 7px 14px;
    background: none;
    border: none;
    border-top: 1px solid #21262d;
    color: #8b949e;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    user-select: none;
  }
  .history-toggle:hover { color: #e6edf3; background: #161b22; }
  .history-toggle .ht-label { display: flex; align-items: center; gap: 5px; }
  .history-toggle .ht-count {
    background: #30363d;
    color: #8b949e;
    border-radius: 8px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
  }
  .history-toggle .ht-arrow {
    font-size: 10px;
    transition: transform 0.2s;
  }
  .history-toggle.open .ht-arrow { transform: rotate(180deg); }

  .history-drawer {
    border-top: 1px solid #21262d;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.25s ease;
  }
  .history-drawer.open { max-height: 220px; }

  .history-drawer-inner {
    max-height: 220px;
    overflow-y: auto;
    padding: 4px 0 6px;
  }
  .history-drawer-inner::-webkit-scrollbar { width: 4px; }
  .history-drawer-inner::-webkit-scrollbar-track { background: transparent; }
  .history-drawer-inner::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }

  .history-empty-msg {
    padding: 12px 14px;
    font-size: 11.5px;
    color: #484f58;
    text-align: center;
  }

  .history-chat-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    cursor: pointer;
    transition: background 0.12s;
    border-radius: 0;
  }
  .history-chat-item:hover { background: #161b22; }
  .history-chat-item.active { background: #0d1f38; }

  .hci-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #30363d;
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .history-chat-item.active .hci-dot { background: #3fb950; }

  .hci-body { flex: 1; min-width: 0; }
  .hci-title {
    font-size: 11.5px;
    font-weight: 500;
    color: #e6edf3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .history-chat-item.active .hci-title { color: #58a6ff; }
  .hci-meta {
    font-size: 10px;
    color: #8b949e;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hci-use {
    flex-shrink: 0;
    padding: 3px 8px;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 5px;
    color: #8b949e;
    font-size: 10px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .hci-use:hover { background: #30363d; color: #e6edf3; border-color: #58a6ff; }
  .history-chat-item.active .hci-use {
    background: #0d2a18;
    border-color: #1f5a2d;
    color: #3fb950;
  }
`;

// ─── Markdown → basic HTML (for summary display) ─────────────────────────────

function mdToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hup])/gm, '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.startsWith('<') ? l : `<p>${l}</p>`)
    .join('\n');
}

// ─── Status helpers ───────────────────────────────────────────────────────────

async function getStatus(): Promise<{ hasTranscript: boolean; source?: string; title?: string }> {
  try {
    const resp = await msgBg<{ hasTranscript?: boolean; meta?: { source?: string; title?: string } }>({
      type: 'HAS_TRANSCRIPT'
    });
    return {
      hasTranscript: Boolean(resp?.hasTranscript),
      source: resp?.meta?.source,
      title: resp?.meta?.title
    };
  } catch {
    return { hasTranscript: false };
  }
}

// ─── Toolbar injection ────────────────────────────────────────────────────────

function injectToolbar() {
  // Host element
  const host = document.createElement('div');
  host.id = 'llm-chat-transfer-toolbar';
  const shadow = host.attachShadow({ mode: 'open' });

  // Styles
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  // FAB button
  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.title = 'LLM Chat Transfer';
  fab.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
    <rect x="2" y="2" width="124" height="124" rx="28" fill="#161b22" stroke="#30363d" stroke-width="4"/>
    <path d="M28 44 h40 c8.8 0 16 7.2 16 16 v24 c0 8.8 -7.2 16 -16 16 h-8 l-16 16 v-16 h-16 c-8.8 0 -16 -7.2 -16 -16 v-24 c0 -8.8 7.2 -16 16 -16 z" fill="#21262d" stroke="#8b949e" stroke-width="4" stroke-linejoin="round"/>
    <path d="M48 24 h48 c8.8 0 16 7.2 16 16 v24 c0 8.8 -7.2 16 -16 16 h-16 v16 l-16 -16 h-16 c-8.8 0 -16 -7.2 -16 -16 v-24 c0 -8.8 7.2 -16 16 -16 z" fill="#0d1117" stroke="#58a6ff" stroke-width="4" stroke-linejoin="round"/>
    <path d="M52 56 h20 m-6 -6 l10 6 -10 6" fill="none" stroke="#58a6ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  shadow.appendChild(fab);

  // Panel
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-header">
      <div class="panel-header-logo">
        <svg viewBox="0 0 128 128">
          <rect x="2" y="2" width="124" height="124" rx="28" fill="#161b22" stroke="#30363d" stroke-width="4"/>
          <path d="M28 44 h40 c8.8 0 16 7.2 16 16 v24 c0 8.8 -7.2 16 -16 16 h-8 l-16 16 v-16 h-16 c-8.8 0 -16 -7.2 -16 -16 v-24 c0 -8.8 7.2 -16 16 -16 z" fill="#21262d" stroke="#8b949e" stroke-width="4" stroke-linejoin="round"/>
          <path d="M48 24 h48 c8.8 0 16 7.2 16 16 v24 c0 8.8 -7.2 16 -16 16 h-16 v16 l-16 -16 h-16 c-8.8 0 -16 -7.2 -16 -16 v-24 c0 -8.8 7.2 -16 16 -16 z" fill="#0d1117" stroke="#58a6ff" stroke-width="4" stroke-linejoin="round"/>
          <path d="M52 56 h20 m-6 -6 l10 6 -10 6" fill="none" stroke="#58a6ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="panel-title">Chat Transfer</span>
      <button class="panel-close" title="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="status-strip">
      <div class="status-dot" id="tb-dot"></div>
      <span class="status-text" id="tb-status">Checking…</span>
    </div>
    <div class="actions">
      <button class="action-btn extract" id="tb-extract" title="Capture this chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Capture
      </button>
      <button class="action-btn paste" id="tb-paste" title="Paste captured chat here">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Paste
      </button>
      <button class="action-btn summarize" id="tb-summarize" title="Summarize with AI">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="6" x2="14" y2="6"/>
          <line x1="3" y1="11" x2="12" y2="11"/>
          <line x1="3" y1="16" x2="8" y2="16"/>
          <path fill="currentColor" stroke="none" d="M18.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4-3.4-1.1 3.4-1.1z"/>
          <path fill="currentColor" stroke="none" d="M21 15.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z"/>
        </svg>
        Summarize
      </button>
      <button class="action-btn download" id="tb-download" title="Download chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 17v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3"/>
          <polyline points="8 12 12 16 16 12"/><line x1="12" y1="4" x2="12" y2="16"/>
        </svg>
        Download
      </button>
    </div>
    <div class="feedback" id="tb-feedback"></div>
    <div class="summary-area" id="tb-summary"></div>
    <div class="format-picker" id="tb-format-picker">
      <div class="format-picker-title">Download as…</div>
      <button class="format-option" data-fmt="txt">
        <span class="fmt-icon fmt-txt">TXT</span>
        <span class="fmt-label">Plain Text</span>
        <span class="fmt-desc">.txt</span>
      </button>
      <button class="format-option" data-fmt="md">
        <span class="fmt-icon fmt-md">MD</span>
        <span class="fmt-label">Markdown</span>
        <span class="fmt-desc">.md</span>
      </button>
      <button class="format-option" data-fmt="docx">
        <span class="fmt-icon fmt-doc">DOC</span>
        <span class="fmt-label">Word Document</span>
        <span class="fmt-desc">.doc</span>
      </button>
      <button class="format-option" data-fmt="pdf">
        <span class="fmt-icon fmt-pdf">PDF</span>
        <span class="fmt-label">PDF Document</span>
        <span class="fmt-desc">.pdf</span>
      </button>
    </div>
    <div class="paste-picker" id="tb-paste-picker">
      <div class="paste-picker-title">Paste as…</div>
      <button class="paste-option" data-mode="inline">
        <span class="po-icon po-inline">↓▤</span>
        <span class="po-label">Paste inline</span>
        <span class="po-desc">Into the text box</span>
      </button>
      <button class="paste-option" data-mode="raw">
        <span class="po-icon po-raw">RAW</span>
        <span class="po-label">Paste raw text</span>
        <span class="po-desc">No system framing</span>
      </button>
      <button class="paste-option" data-mode="pdf">
        <span class="po-icon po-pdf">PDF</span>
        <span class="po-label">Attach as PDF</span>
        <span class="po-desc">Attach or download</span>
      </button>
      <button class="paste-option" data-mode="txt">
        <span class="po-icon po-txt">TXT</span>
        <span class="po-label">Attach as text file</span>
        <span class="po-desc">Attach or download</span>
      </button>
      <button class="paste-option" data-mode="doc">
        <span class="po-icon po-doc">DOC</span>
        <span class="po-label">Attach as Word doc</span>
        <span class="po-desc">Attach or download</span>
      </button>
    </div>
    <button class="summary-close" id="tb-summary-close">Hide summary ↑</button>
    <button class="summary-resync" id="tb-resync">↺ Re-summarize</button>
    <button class="history-toggle" id="tb-history-toggle">
      <span class="ht-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px">
          <path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>
        </svg>
        Captured Chats
        <span class="ht-count" id="tb-history-count">0</span>
      </span>
      <span class="ht-arrow">▾</span>
    </button>
    <div class="history-drawer" id="tb-history-drawer">
      <div class="history-drawer-inner" id="tb-history-list">
        <div class="history-empty-msg">No captured chats yet.</div>
      </div>
    </div>
  `;
  shadow.appendChild(panel);
  document.body.appendChild(host);

  // ── Element refs ────────────────────────────────────────────────────────────
  const dot        = shadow.getElementById('tb-dot') as HTMLElement;
  const statusText = shadow.getElementById('tb-status') as HTMLElement;
  const btnExtract  = shadow.getElementById('tb-extract') as HTMLButtonElement;
  const btnPaste    = shadow.getElementById('tb-paste') as HTMLButtonElement;
  const btnSummarize = shadow.getElementById('tb-summarize') as HTMLButtonElement;
  const btnDownload = shadow.getElementById('tb-download') as HTMLButtonElement;
  const formatPicker = shadow.getElementById('tb-format-picker') as HTMLElement;
  const pastePicker  = shadow.getElementById('tb-paste-picker') as HTMLElement;
  const feedback    = shadow.getElementById('tb-feedback') as HTMLElement;
  const summaryArea = shadow.getElementById('tb-summary') as HTMLElement;
  const summaryClose = shadow.getElementById('tb-summary-close') as HTMLButtonElement;
  const btnResync    = shadow.getElementById('tb-resync') as HTMLButtonElement;
  const historyToggle = shadow.getElementById('tb-history-toggle') as HTMLButtonElement;
  const historyDrawer = shadow.getElementById('tb-history-drawer') as HTMLElement;
  const historyList   = shadow.getElementById('tb-history-list') as HTMLElement;
  const historyCount  = shadow.getElementById('tb-history-count') as HTMLElement;
  const panelClose  = shadow.querySelector('.panel-close') as HTMLButtonElement;

  let panelOpen = false;
  let cachedSummary: string | null = null;
  let activeHistoryId: string | null = null;

  // ── Status refresh ──────────────────────────────────────────────────────────
  async function refreshStatus() {
    const s = await getStatus();
    if (s.hasTranscript) {
      dot.className = 'status-dot ready';
      const src = s.source ? ` · ${s.source}` : '';
      statusText.textContent = `Chat captured${src} — ready to paste`;
      btnPaste.disabled = false;
      btnSummarize.disabled = false;
      btnDownload.disabled = false;
    } else {
      dot.className = 'status-dot';
      statusText.textContent = 'No chat captured yet';
      btnPaste.disabled = true;
      btnSummarize.disabled = true;
      btnDownload.disabled = true;
    }
  }

  // ── Feedback helpers ────────────────────────────────────────────────────────
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  function showFeedback(msg: string, type: 'success' | 'error' | 'info', autoClear = true) {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedback.textContent = msg;
    feedback.className = `feedback show ${type}`;
    if (autoClear) {
      feedbackTimer = setTimeout(() => {
        feedback.className = 'feedback';
        feedbackTimer = null;
      }, 4000);
    }
  }

  const SPINNER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

  function setLoading(btn: HTMLButtonElement, label: string, originalHTML: string, on: boolean) {
    if (on) {
      btn.dataset.original = originalHTML;
      btn.innerHTML = `${SPINNER_SVG}${label}`;
      btn.classList.add('loading');
    } else {
      btn.innerHTML = btn.dataset.original ?? originalHTML;
      btn.classList.remove('loading');
    }
  }

  // ── Panel open/close ────────────────────────────────────────────────────────
  function openPanel() {
    panelOpen = true;
    panel.classList.add('open');
    dot.className = 'status-dot pending';
    statusText.textContent = 'Checking…';
    feedback.className = 'feedback';
    summaryArea.className = 'summary-area';
    summaryClose.className = 'summary-close';
    void refreshStatus();
    // Refresh history count badge silently
    msgBg<{ items?: HistoryItem[] }>({ type: 'LIST_HISTORY' })
      .then((resp) => { historyCount.textContent = String(Array.isArray(resp?.items) ? resp.items.length : 0); })
      .catch(() => {});
  }

  function closePanel() {
    panelOpen = false;
    panel.classList.remove('open');
  }

  fab.addEventListener('click', () => {
    if (panelOpen) closePanel(); else openPanel();
  });
  panelClose.addEventListener('click', closePanel);

  // Close panel if user clicks outside
  document.addEventListener('click', (e) => {
    if (panelOpen && !host.contains(e.target as Node)) closePanel();
  }, true);

  // ── Extract ─────────────────────────────────────────────────────────────────
  const extractOrig = btnExtract.innerHTML;
  btnExtract.addEventListener('click', async () => {
    // Clear stale cache on new capture
    cachedSummary = null;
    summaryArea.className = 'summary-area';
    summaryClose.className = 'summary-close';
    btnResync.className = 'summary-resync';
    setLoading(btnExtract, 'Capturing…', extractOrig, true);
    try {
      const msg = await actionExtract();
      await refreshStatus();
      // Auto-summarize silently after capture
      showFeedback(`✓ ${msg} — summarizing…`, 'info', false);
      try {
        cachedSummary = await actionSummarize();
        showFeedback(`✓ ${msg} — summary ready.`, 'success');
      } catch {
        // Summarization failed silently; user can retry manually
        showFeedback(`✓ ${msg}`, 'success');
      }
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(btnExtract, 'Capturing…', extractOrig, false);
    }
  });

  // ── Paste — toggle picker ────────────────────────────────────────────────────
  btnPaste.addEventListener('click', () => {
    const isOpen = pastePicker.classList.contains('show');
    // Close format picker if open
    formatPicker.classList.remove('show');
    btnDownload.classList.toggle('active', false);
    pastePicker.classList.toggle('show', !isOpen);
    btnPaste.classList.toggle('active', !isOpen);
  });

  // ── Paste picker — option click ───────────────────────────────────────────
  pastePicker.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.paste-option') as HTMLElement | null;
    if (!btn) return;
    const mode = btn.dataset.mode as 'inline' | 'raw' | 'pdf' | 'txt' | 'doc' | undefined;
    if (!mode) return;

    pastePicker.classList.remove('show');
    btnPaste.classList.remove('active');

    const pasteOrig = btnPaste.innerHTML;
    setLoading(btnPaste, 'Pasting…', pasteOrig, true);
    try {
      let msg: string;
      if (mode === 'inline') {
        msg = await actionPaste();
      } else if (mode === 'raw') {
        msg = await actionPasteRaw();
      } else {
        // 'pdf' | 'txt' | 'doc' — map 'doc' → 'docx' internally
        msg = await actionPasteAsFile(mode === 'doc' ? 'docx' : mode);
      }
      showFeedback(`✓ ${msg}`, 'success');
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(btnPaste, 'Pasting…', pasteOrig, false);
    }
  });

  // ── Summarize ───────────────────────────────────────────────────────────────
  const summarizeOrig = btnSummarize.innerHTML;
  btnSummarize.addEventListener('click', async () => {
    // If we already have a cached summary, show it instantly
    if (cachedSummary) {
      feedback.className = 'feedback';
      summaryArea.innerHTML = mdToHtml(cachedSummary);
      summaryArea.className = 'summary-area show';
      summaryClose.className = 'summary-close show';
      btnResync.className = 'summary-resync show';
      return;
    }
    // No cache — call AI
    summaryArea.className = 'summary-area';
    summaryClose.className = 'summary-close';
    btnResync.className = 'summary-resync';
    setLoading(btnSummarize, 'Thinking…', summarizeOrig, true);
    showFeedback('Summarizing with AI… this may take a moment.', 'info', false);
    try {
      const summary = await actionSummarize();
      cachedSummary = summary;
      feedback.className = 'feedback';
      summaryArea.innerHTML = mdToHtml(summary);
      summaryArea.className = 'summary-area show';
      summaryClose.className = 'summary-close show';
      btnResync.className = 'summary-resync show';
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(btnSummarize, 'Thinking…', summarizeOrig, false);
    }
  });

  summaryClose.addEventListener('click', () => {
    summaryArea.className = 'summary-area';
    summaryClose.className = 'summary-close';
    btnResync.className = 'summary-resync';
  });

  // ── History drawer ──────────────────────────────────────────────────────────
  type HistoryItem = { id: string; source: string; title: string; messageCount: number; createdAt: string };

  function renderHistoryList(items: HistoryItem[]) {
    historyCount.textContent = String(items.length);
    historyList.innerHTML = '';
    if (items.length === 0) {
      historyList.innerHTML = '<div class="history-empty-msg">No captured chats yet.</div>';
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-chat-item' + (item.id === activeHistoryId ? ' active' : '');
      row.dataset.id = item.id;

      const dateStr = new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      row.innerHTML = `
        <div class="hci-dot"></div>
        <div class="hci-body">
          <div class="hci-title" title="${item.title.replace(/"/g, '&quot;')}">${item.title || 'Untitled'}</div>
          <div class="hci-meta">${item.source} · ${item.messageCount} msgs · ${dateStr}</div>
        </div>
        <button class="hci-use" title="Use this chat">${item.id === activeHistoryId ? '✓ Active' : 'Use'}</button>
      `;
      historyList.appendChild(row);
    });
  }

  async function loadHistory() {
    try {
      const resp = await msgBg<{ items?: HistoryItem[] }>({ type: 'LIST_HISTORY' });
      renderHistoryList(Array.isArray(resp?.items) ? resp.items : []);
    } catch {
      historyList.innerHTML = '<div class="history-empty-msg">Could not load history.</div>';
    }
  }

  historyToggle.addEventListener('click', () => {
    const isOpen = historyDrawer.classList.contains('open');
    historyDrawer.classList.toggle('open', !isOpen);
    historyToggle.classList.toggle('open', !isOpen);
    if (!isOpen) void loadHistory();
  });

  historyList.addEventListener('click', async (e) => {
    const row = (e.target as HTMLElement).closest('.history-chat-item') as HTMLElement | null;
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    // Already active
    if (id === activeHistoryId) {
      showFeedback('This chat is already active.', 'info');
      return;
    }

    try {
      const resp = await msgBg<{ status: string; error?: string }>({ type: 'LOAD_HISTORY_ITEM', id });
      if (resp.status !== 'success') throw new Error(resp.error ?? 'Failed to load chat');
      activeHistoryId = id;
      cachedSummary = null; // clear stale summary
      await refreshStatus();
      void loadHistory(); // re-render to update active indicator
      showFeedback('✓ Chat loaded — ready to paste or summarize.', 'success');
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });

  // ── Re-summarize (force new AI call, update cache) ───────────────────────────
  const resyncOrig = btnResync.innerHTML;
  btnResync.addEventListener('click', async () => {
    setLoading(btnResync, 'Re-summarizing…', resyncOrig, true);
    showFeedback('Re-summarizing with AI…', 'info', false);
    try {
      const summary = await actionSummarize();
      cachedSummary = summary;
      feedback.className = 'feedback';
      summaryArea.innerHTML = mdToHtml(summary);
      summaryArea.className = 'summary-area show';
      summaryClose.className = 'summary-close show';
      btnResync.className = 'summary-resync show';
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(btnResync, 'Re-summarizing…', resyncOrig, false);
    }
  });

  // ── Download (format picker) ────────────────────────────────────────────────
  const downloadOrig = btnDownload.innerHTML;
  btnDownload.addEventListener('click', () => {
    // Toggle format picker visibility; close paste picker if open
    const isOpen = formatPicker.classList.contains('show');
    pastePicker.classList.remove('show');
    btnPaste.classList.remove('active');
    formatPicker.className = isOpen ? 'format-picker' : 'format-picker show';
  });

  formatPicker.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.format-option') as HTMLElement | null;
    if (!btn) return;
    const fmt = btn.dataset.fmt as DownloadFormat;
    if (!fmt) return;

    formatPicker.className = 'format-picker';
    setLoading(btnDownload, 'Preparing…', downloadOrig, true);
    try {
      const msg = await actionDownload(fmt);
      showFeedback(`✓ ${msg}`, 'success');
    } catch (err) {
      showFeedback(`✗ ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(btnDownload, 'Preparing…', downloadOrig, false);
    }
  });

  // ── FAB stays fixed at bottom-right — no anchoring to send button ──────────
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

if (!window.__chatTransferToolbarRegistered) {
  window.__chatTransferToolbarRegistered = true;

  const boot = () => {
    // Check setting before injecting (default = enabled)
    chrome.storage.local.get('toolbarEnabled', (data) => {
      if (data.toolbarEnabled === false) return; // user disabled toolbar
      injectToolbar();
    });
  };

  // Listen for live toggle changes from the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.toolbarEnabled) return;
    const enabled = changes.toolbarEnabled.newValue;
    const existing = document.getElementById('llm-chat-transfer-toolbar');
    if (enabled && !existing) {
      injectToolbar();
    } else if (!enabled && existing) {
      existing.remove();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
