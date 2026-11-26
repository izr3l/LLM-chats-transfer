import { AttachmentRef } from '../../schema/canonical';

const FILE_EXTENSION = /\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|xml|zip|rar|7z|png|jpe?g|gif|webp|svg|avif|heic|mp4|mp3|wav|mov|webm)(?:[?#]|$)/i;
const CHIP_SELECTOR = '[data-testid*="attachment"], [data-testid*="file"], [class*="attachment"], [class*="file-chip"], [class*="upload"]';
const FILE_NAME_SELECTOR = '[data-filename], [data-file-name], [data-testid="file-name"], [data-testid="attachment-title"]';
const DOWNLOAD_ATTRIBUTES = ['data-download-url', 'data-download-href', 'data-file-url', 'data-attachment-url'];
const DOWNLOAD_SELECTOR = DOWNLOAD_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(', ');
const PDF_EMBED_SELECTOR = 'object[type="application/pdf" i][data], embed[type="application/pdf" i][src]';

function isCardControl(element: Element): boolean {
  return (element.localName === 'button' || element.localName === 'a') &&
    (element.hasAttribute('download') || DOWNLOAD_ATTRIBUTES.some((attribute) => element.hasAttribute(attribute)));
}

function normalizedUrl(raw: string | null): string | undefined {
  if (!raw?.trim() || raw.trimStart().startsWith('#')) return undefined;
  try {
    const url = new URL(raw, window.location.href);
    return ['https:', 'blob:', 'data:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function fileName(node: Element, fallback?: string): string | undefined {
  const named = node.querySelector(FILE_NAME_SELECTOR);
  const value = node.getAttribute('download') || node.getAttribute('data-filename') || node.getAttribute('data-file-name') ||
    named?.getAttribute('data-filename') || named?.getAttribute('data-file-name') || named?.textContent || node.getAttribute('title') ||
    (node as HTMLElement).innerText || node.textContent || fallback;
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function declaredDownloadUrl(node: Element): string | undefined {
  for (const attribute of DOWNLOAD_ATTRIBUTES) {
    const url = normalizedUrl(node.getAttribute(attribute));
    if (url) return url;
  }
}

function isFileLink(node: Element, url: string): boolean {
  return node.hasAttribute('download') || FILE_EXTENSION.test(url) || /\/(?:files?|download)(?:\/|$)/i.test(new URL(url).pathname);
}

function chipUrl(node: Element, message: Element): string | undefined {
  const candidates = [node, ...node.querySelectorAll(`a[href], ${DOWNLOAD_SELECTOR}`)];
  const parent = node.closest('a[href]');
  if (parent && parent !== node && message.contains(parent)) candidates.push(parent);
  const declared = new Set(candidates.map(declaredDownloadUrl).filter((url) => url !== undefined));
  if (declared.size > 0) return declared.size === 1 ? [...declared][0] : undefined;
  const links = new Set<string>();
  for (const candidate of candidates) {
    const url = normalizedUrl(candidate.getAttribute('href'));
    if (url && isFileLink(candidate, url)) links.add(url);
  }
  if (links.size > 0) return links.size === 1 ? [...links][0] : undefined;
  return normalizedUrl(node.getAttribute('data-url')) || normalizedUrl(node.getAttribute('data-href'));
}

function embeddedPdfUrl(card: Element, message: Element): string | undefined {
  const scopes = new Set([card]);
  // An open preview can live outside the message. Only follow panels explicitly
  // associated with this file card, never a document-wide preview search.
  for (const control of [card, ...card.querySelectorAll('[aria-controls]')]) {
    if (control.getAttribute('aria-expanded') === 'false') continue;
    const targetId = control.getAttribute('aria-controls')?.trim();
    if (!targetId) continue;
    const panel = card.ownerDocument.getElementById(targetId);
    if (panel && !panel.contains(message) && panel.getClientRects().length && !panel.closest('[hidden], [aria-hidden="true"]')) {
      scopes.add(panel);
    }
  }
  const urls = new Set<string>();
  for (const scope of scopes) {
    for (const embed of scope.querySelectorAll(PDF_EMBED_SELECTOR)) {
      const url = normalizedUrl(embed.getAttribute('data') || embed.getAttribute('src'));
      if (url) urls.add(url);
    }
  }
  return urls.size === 1 ? [...urls][0] : undefined;
}

export function hasAttachmentContent(node: Element): boolean {
  return Boolean(node.querySelector(`img[src], a[download], ${DOWNLOAD_SELECTOR}, ${CHIP_SELECTOR}`));
}

/** Read only references within this message; never infer file bytes from nearby prose. */
export function extractMessageAttachments(node: HTMLElement, messageIndex: number, allowEmbeddedPdf = false): AttachmentRef[] {
  const attachments: AttachmentRef[] = [];
  const findCard = (element: Element) => {
    const candidate = element.closest(CHIP_SELECTOR);
    const card = candidate && isCardControl(candidate) ? candidate.parentElement?.closest(CHIP_SELECTOR) : candidate;
    if (card && card !== node && node.contains(card)) return card;
  };
  const register = (attachment: AttachmentRef) => {
    const existing = attachments.find((item) =>
      (attachment.url && item.url === attachment.url) ||
      (item.kind !== 'link' && attachment.kind !== 'link' && item.name && item.name === attachment.name && (!item.url || !attachment.url))
    );
    if (existing) {
      existing.url ||= attachment.url;
      existing.name ||= attachment.name;
      existing.mimeType ||= attachment.mimeType;
      if (existing.kind === 'link' && attachment.kind !== 'link') existing.kind = attachment.kind;
      return;
    }
    attachments.push(attachment);
  };

  node.querySelectorAll<HTMLImageElement>('img[src]').forEach((image, index) => {
    const src = image.getAttribute('src') || image.currentSrc;
    const attachmentContainer = findCard(image);
    if (!attachmentContainer && (/\/(?:avatars?|icons?|favicons?|logos?)(?:[/.?_-]|$)/i.test(src || '') ||
      image.getAttribute('aria-hidden') === 'true' || /^(?:avatar|profile picture|logo|icon)$/i.test(image.alt))) return;
    const anchor = image.closest('a[href]');
    const anchorUrl = anchor && node.contains(anchor) ? normalizedUrl(anchor.getAttribute('href')) : undefined;
    const originalUrl = anchor && anchorUrl && isFileLink(anchor, anchorUrl) ? anchorUrl : undefined;
    const cardUrl = attachmentContainer ? chipUrl(attachmentContainer, node) : undefined;
    const imageDownloadUrl = declaredDownloadUrl(image);
    // The card's download may be a PDF or another document that uses an image thumbnail.
    if (cardUrl && !imageDownloadUrl && !originalUrl) return;
    const resolvedUrl = originalUrl || imageDownloadUrl || normalizedUrl(src);
    if (!resolvedUrl) return;
    const parsed = new URL(resolvedUrl);
    const resized = [...parsed.searchParams.keys()].some((key) => /^(?:w|width|h|height|resize|quality|q|fit|crop|dpr)$/i.test(key));
    const previewOnly = !originalUrl && !imageDownloadUrl &&
      (/\/(?:thumb(?:nail)?s?|previews?)(?:[/.?_-]|$)/i.test(resolvedUrl) || resized);
    const url = previewOnly ? undefined : resolvedUrl;
    register({
      id: `m${messageIndex}-img-${index}`,
      kind: 'image',
      name: (originalUrl && anchor?.getAttribute('download')) || image.alt || `Image ${index + 1}`,
      url,
      sourceHint: previewOnly ? 'image-preview' : originalUrl || imageDownloadUrl ? 'image-download' : 'img'
    });
  });

  node.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor, index) => {
    const url = normalizedUrl(anchor.getAttribute('href'));
    if (!url) return;
    const card = findCard(anchor);
    const isFile = isFileLink(anchor, url);
    // A link opening a file card's UI is navigation, even if the card is a file.
    if (card && !isFile) return;
    const declared = declaredDownloadUrl(anchor);
    if (declared && declared !== url) return;
    const name = anchor.getAttribute('download') || (card ? fileName(card) : undefined) || fileName(anchor);
    register({
      id: `m${messageIndex}-lnk-${index}`,
      kind: isFile ? 'file' : 'link',
      name,
      url,
      sourceHint: anchor.hasAttribute('download') ? 'download-link' : 'anchor'
    });
  });

  const chips = [...node.querySelectorAll(CHIP_SELECTOR)].filter((chip) => !chip.matches(FILE_NAME_SELECTOR) && !isCardControl(chip));
  chips.forEach((chip, index) => {
    // A file card can have several nested elements with attachment class names.
    // Read its innermost labeled card once, while separate sibling files survive.
    if (chips.some((other) => other !== chip && chip.contains(other))) return;
    const name = fileName(chip);
    const directUrl = chipUrl(chip, node);
    const pdfUrl = allowEmbeddedPdf && !directUrl ? embeddedPdfUrl(chip, node) : undefined;
    const url = directUrl || pdfUrl;
    if (!name && !url) return;
    register({
      id: `m${messageIndex}-chip-${index}`,
      kind: 'file',
      name,
      url,
      mimeType: pdfUrl ? 'application/pdf' : undefined,
      sourceHint: pdfUrl ? 'embedded-pdf' : 'attachment-chip'
    });
  });

  node.querySelectorAll(DOWNLOAD_SELECTOR).forEach((button, index) => {
    const url = declaredDownloadUrl(button);
    if (!url) return;
    const card = findCard(button);
    const name = button.getAttribute('download') || (card ? fileName(card) : undefined) || fileName(button);
    register({ id: `m${messageIndex}-dl-${index}`, kind: 'file', name, url, sourceHint: 'download-btn' });
  });
  return attachments;
}
