/**
 * React Fiber tree walker for harvesting attachment URLs from ChatGPT.
 *
 * ChatGPT stores file attachment URLs (on oaiusercontent.com) inside React
 * fiber `memoizedProps` / `pendingProps`, not in visible DOM attributes.
 * This script runs in the MAIN world so it can access React internals.
 *
 * Adapted from ChatVault's approach with security hardening:
 * - Strict host allowlist for extracted URLs
 * - Depth and iteration limits to prevent hangs
 * - No eval or dynamic code execution
 */

export interface HarvestedAttachment {
  url: string;
  name?: string;
  mimeType?: string;
}

// Host allowlist for attachment URLs we consider valid
const ALLOWED_HOSTS = [
  'oaiusercontent.com',
  'files.oaiusercontent.com',
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'googleapis.com',
  'googleusercontent.com',
];

function isAllowedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function isAttachmentUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('https://')) return false;
  if (!isAllowedUrl(url)) return false;

  // Exclude known non-attachment patterns (avatars, icons, thumbnails)
  if (/\/(avatar|icon|favicon|thumbnail|thumb|logo)/i.test(url)) return false;

  // For oaiusercontent.com, look for file-like patterns
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname.endsWith('oaiusercontent.com')) {
      // Must have rscd parameter or file- prefix in path (ChatGPT file pattern)
      const hasFileSignal = parsed.searchParams.has('rscd') ||
        /\/file-[A-Za-z0-9]/.test(parsed.pathname) ||
        parsed.pathname.includes('/files/');
      if (!hasFileSignal) return false;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Walks the React fiber tree starting from DOM elements to find attachment URLs.
 * Returns deduplicated list of { url, name?, mimeType? }.
 */
export function harvestAttachmentUrls(): HarvestedAttachment[] {
  const results = new Map<string, HarvestedAttachment>();
  const MAX_FIBERS = 12000;
  const MAX_DEPTH = 16;
  const MAX_OBJECTS = 3000;
  let fiberCount = 0;

  // Find the React fiber key on DOM elements
  function findFiberKey(el: Element): string | null {
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return key;
      }
    }
    return null;
  }

  function findPropsKey(el: Element): string | null {
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactProps$')) {
        return key;
      }
    }
    return null;
  }

  // Recursively scan an object for URL strings
  function scanObject(obj: unknown, depth: number, visited: Set<unknown>): void {
    if (depth > MAX_DEPTH || visited.size > MAX_OBJECTS) return;
    if (!obj || typeof obj !== 'object') return;
    if (visited.has(obj)) return;
    visited.add(obj);

    const record = obj as Record<string, unknown>;

    // Check for URL-like string properties
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (typeof val === 'string' && val.startsWith('https://') && isAttachmentUrl(val)) {
        if (!results.has(val)) {
          // Try to find a name near this URL
          const name = typeof record['name'] === 'string' ? record['name']
            : typeof record['fileName'] === 'string' ? record['fileName']
            : typeof record['file_name'] === 'string' ? record['file_name']
            : typeof record['title'] === 'string' ? record['title']
            : typeof record['alt'] === 'string' ? record['alt']
            : undefined;
          const mimeType = typeof record['mimeType'] === 'string' ? record['mimeType']
            : typeof record['content_type'] === 'string' ? record['content_type']
            : typeof record['type'] === 'string' && (record['type'] as string).includes('/') ? record['type'] as string
            : undefined;
          results.set(val, { url: val, name, mimeType });
        }
      } else if (typeof val === 'object' && val !== null) {
        scanObject(val, depth + 1, visited);
      }
    }
  }

  // Walk fiber tree from a starting fiber node
  function walkFiber(fiber: Record<string, unknown> | null, visited: Set<unknown>): void {
    if (!fiber || typeof fiber !== 'object') return;
    if (visited.has(fiber)) return;
    if (fiberCount++ > MAX_FIBERS) return;
    visited.add(fiber);

    // Scan memoizedProps and pendingProps
    const propsSources = ['memoizedProps', 'pendingProps'];
    for (const propKey of propsSources) {
      const props = fiber[propKey];
      if (props && typeof props === 'object') {
        scanObject(props, 0, new Set());
      }
    }

    // Walk child, sibling, return fibers
    walkFiber(fiber['child'] as Record<string, unknown> | null, visited);
    walkFiber(fiber['sibling'] as Record<string, unknown> | null, visited);
  }

  // Start from conversation turn elements (ChatGPT specific)
  const turnSelectors = [
    'article[data-testid^="conversation-turn-"]',
    '[data-message-author-role]',
    '[data-testid*="message"]',
    'main article',
  ];

  const elements = new Set<Element>();
  for (const sel of turnSelectors) {
    document.querySelectorAll(sel).forEach((el) => elements.add(el));
  }

  // Also try root React container
  const rootEl = document.getElementById('__next') || document.getElementById('root') || document.body;
  if (rootEl) elements.add(rootEl);

  for (const el of elements) {
    const fiberKey = findFiberKey(el);
    if (fiberKey) {
      const fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null;
      walkFiber(fiber, new Set());
    }

    const propsKey = findPropsKey(el);
    if (propsKey) {
      const props = (el as unknown as Record<string, unknown>)[propsKey];
      if (props && typeof props === 'object') {
        scanObject(props, 0, new Set());
      }
    }
  }

  // Also scan __NEXT_DATA__ (NextJS SSR data)
  try {
    const nextDataScript = document.getElementById('__NEXT_DATA__');
    if (nextDataScript?.textContent) {
      const data = JSON.parse(nextDataScript.textContent);
      scanObject(data, 0, new Set());
    }
  } catch { /* ignore */ }

  return Array.from(results.values());
}
