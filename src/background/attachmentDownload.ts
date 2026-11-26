/** Provider file hosts used by both download paths. Keep in sync with manifest permissions. */
export const ATTACHMENT_HOSTS = [
  'oaiusercontent.com', 'chatgpt.com', 'chat.openai.com', 'claude.ai',
  'gemini.google.com', 'googleapis.com', 'googleusercontent.com',
  'manus.im', 'manus.com', 'manus.ai', 'manus.computer',
  'perplexity.ai', 'qwen.ai', 'qwenlm.ai', 'x.com',
];

export interface DownloadOptions {
  maxSize: number;
  allowedHosts: string[];
  /** Set only for MAIN-world requests in the sender's own tab. */
  pageOrigin?: string;
}

/**
 * Self-contained because Chrome serializes this function into the source page.
 * Read a bounded stream rather than loading an arbitrarily large response first.
 */
export async function downloadAttachment(fileUrl: string, options: DownloadOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    function isAllowedUrl(candidate: URL): boolean {
      return (candidate.protocol === 'https:' && !candidate.username && !candidate.password &&
        options.allowedHosts.some((host) => candidate.hostname === host || candidate.hostname.endsWith(`.${host}`))) ||
        (candidate.protocol === 'blob:' && Boolean(options.pageOrigin) && candidate.origin === options.pageOrigin) ||
        (candidate.protocol === 'data:' && Boolean(options.pageOrigin));
    }
    const url = new URL(fileUrl);
    if (!isAllowedUrl(url)) {
      throw new Error('Attachment URL is not allowed.');
    }
    if (url.protocol === 'data:' && fileUrl.length > Math.ceil(options.maxSize * 4 / 3) + 4096) {
      throw new Error('Attachment exceeds 25 MB limit.');
    }

    const response = await fetch(fileUrl, {
      credentials: options.pageOrigin ? 'include' : 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.type === 'opaque' || response.type === 'opaqueredirect') {
      throw new Error('The provider did not expose the attachment response.');
    }
    const finalUrl = new URL(response.url || fileUrl);
    if (!isAllowedUrl(finalUrl)) {
      await response.body?.cancel();
      throw new Error('Attachment redirected to a host that is not allowed.');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const declaredSize = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredSize) && declaredSize > options.maxSize) {
      await response.body?.cancel();
      throw new Error('Attachment exceeds 25 MB limit.');
    }
    const mimeType = (response.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const disposition = response.headers.get('Content-Disposition') || '';
    // A login/error document must never be recorded as a successfully captured file.
    if (mimeType === 'text/html' && !/\battachment\b/i.test(disposition)) {
      await response.body?.cancel();
      throw new Error('The provider returned a web page instead of an attachment.');
    }
    if (!response.body) throw new Error('Attachment response has no body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxSize) {
        await reader.cancel();
        throw new Error('Attachment exceeds 25 MB limit.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const binaryChunks: string[] = [];
    for (let start = 0; start < bytes.length; start += 0x8000) {
      binaryChunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
    }
    let filename = '';
    const extended = /filename\*\s*=\s*(?:UTF-8)'[^']*'([^\s;]+)/i.exec(disposition);
    const standard = /filename\s*=\s*(?:"([^"]+)"|([^;\n]+))/i.exec(disposition);
    if (extended) {
      try { filename = decodeURIComponent(extended[1]); } catch { /* use standard filename */ }
    }
    if (!filename && standard) filename = (standard[1] || standard[2]).trim();
    if (!filename && finalUrl.protocol === 'https:') {
      const segment = finalUrl.pathname.split('/').pop() || '';
      if (segment.includes('.')) {
        try { filename = decodeURIComponent(segment); } catch { filename = segment; }
      }
    }
    filename = filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'attachment';
    return { status: 'success', dataBase64: btoa(binaryChunks.join('')), mimeType, filename, size };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
