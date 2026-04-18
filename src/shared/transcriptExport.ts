/**
 * Shared transcript export utilities.
 * Used by both the toolbar content script and the popup UI to ensure consistent
 * output across all download and paste-as-file flows.
 */

export type DownloadFormat = 'txt' | 'md' | 'doc' | 'pdf';

export type AttachFormat = 'pdf' | 'txt' | 'doc';

export type TranscriptLike = {
  metadata: { source: string; title?: string; createdAt: string };
  messages: Array<{
    role: string;
    content: Array<{ text: string }>;
    attachments?: Array<{ kind: string; name?: string }>;
  }>;
  integrity?: { messageCount: number };
};

export function safeName(title?: string): string {
  return (title ?? 'chat').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
}

export function buildPlainText(t: TranscriptLike): string {
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

export function buildMarkdown(t: TranscriptLike): string {
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;
  let md = `# ${title ?? 'Untitled Chat'}\n\n`;
  md += `**Source:** ${source}  \n**Messages:** ${count}  \n**Captured:** ${new Date(createdAt).toLocaleString()}  \n\n---\n\n`;
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a Word 2003 XML (.doc) blob.
 * Note: this is not a true .docx (OOXML zip); the file extension must be .doc.
 */
export function buildDocBlob(t: TranscriptLike): Blob {
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
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><?mso-application progid="Word.Document"?><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"><w:body>${body}</w:body></w:wordDocument>`;
  return new Blob([docXml], { type: 'application/vnd.ms-word;charset=utf-8' });
}

export function buildPdfBytes(t: TranscriptLike): Uint8Array {
  const { source, title, createdAt } = t.metadata;
  const count = t.integrity?.messageCount ?? t.messages.length;
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

  function pdfEsc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  const LINES_PER_PAGE = 55;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (pages.length === 0) pages.push(['(empty)']);

  const objs: string[] = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`);
  objs.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj');
  pages.forEach((pageLines, pi) => {
    const pn = 4 + pi * 2;
    let stream = 'BT\n/F1 10 Tf\n50 780 Td\n14 TL\n';
    pageLines.forEach((line) => { stream += `(${pdfEsc(line)}) Tj T*\n`; });
    stream += 'ET';
    objs.push(`${pn} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pn + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`);
    objs.push(`${pn + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((obj) => { offsets.push(pdf.length); pdf += obj + '\n'; });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/**
 * Convert a Blob to a base64 string using chunked processing to avoid
 * memory spikes with large files (avoids "Invalid string length" errors).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  const chunkSize = 0xc000; // 49,152 bytes — must be divisible by 3 to prevent base64 padding mid-chunk
  let base64 = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    const chunkChars: string[] = new Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      chunkChars[i] = String.fromCharCode(chunk[i]);
    }
    base64 += btoa(chunkChars.join(''));
  }
  return base64;
}
