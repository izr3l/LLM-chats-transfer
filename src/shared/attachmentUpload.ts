/** Browser-side staging only: providers still validate and upload the files. */
export interface AttachmentUploadResult {
  attached: File[];
  failed: File[];
  method?: 'input' | 'drop';
}

export interface AttachmentResult {
  attempted: number;
  attached: number;
  missing: string[];
  failed: string[];
  method?: 'input' | 'drop';
}

/** File inputs do not enforce accept when their FileList is assigned in code. */
export function matchesFileAccept(file: Pick<File, 'name' | 'type'>, accept: string): boolean {
  const patterns = accept.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern === '*/*') return true;
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1));
    return mime === pattern;
  });
}

function queryDeep<T extends Element>(selector: string): T[] {
  const results: T[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    results.push(...Array.from(root.querySelectorAll<T>(selector)));
    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot && element.id !== 'chat-transfer-toolbar') roots.push(element.shadowRoot);
    });
  }
  return results;
}

function dataTransferFor(files: File[]): DataTransfer {
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  return transfer;
}

/**
 * Stage one batch, so a later change event cannot replace an earlier batch.
 * A synthetic drop only counts when a page handler accepts the drag/drop.
 */
export function attachFilesToPage(files: File[]): AttachmentUploadResult {
  if (files.length === 0) return { attached: [], failed: [] };
  const composers = queryDeep<HTMLElement>(
    '#prompt-textarea, .ProseMirror, [data-lexical-editor], textarea, [contenteditable="true"], [role="textbox"]'
  ).filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-disabled') !== 'true');
  if (composers.length === 0) return { attached: [], failed: files };
  const containers = composers.map((element) => element.closest(
    'form, [data-testid*="composer"], [class*="composer"], [class*="Composer"], [class*="input-container"], [class*="input-wrapper"]'
  ) || element.parentElement).filter((element): element is HTMLElement => !!element);
  const inputs = queryDeep<HTMLInputElement>('input[type="file"]')
    .filter((input) => !input.disabled && !input.hasAttribute('webkitdirectory'))
    .filter((input) => containers.some((container) => container.contains(input) || input.form === container));

  // Prefer a single control that can accept the complete batch.
  for (const input of inputs) {
    if (files.length > 1 && !input.multiple) continue;
    if (!files.every((file) => matchesFileAccept(file, input.accept))) continue;
    try {
      input.files = dataTransferFor(files).files;
      if (input.files?.length !== files.length) continue;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { attached: files, failed: [], method: 'input' };
    } catch { /* Another control may support programmatic FileList assignment. */ }
  }

  const dropTargets = new Set<HTMLElement>();
  composers.forEach((composer) => {
    dropTargets.add(composer);
  });
  for (const element of dropTargets) {
    try {
      const transfer = dataTransferFor(files);
      const options = { dataTransfer: transfer, bubbles: true, cancelable: true };
      element.dispatchEvent(new DragEvent('dragenter', options));
      const over = new DragEvent('dragover', options);
      element.dispatchEvent(over);
      const drop = new DragEvent('drop', options);
      element.dispatchEvent(drop);
      if (drop.defaultPrevented) {
        return { attached: files, failed: [], method: 'drop' };
      }
    } catch { /* Synthetic file drops are not supported by every provider. */ }
  }
  return { attached: [], failed: files };
}

export function fileFromBase64(base64: string, name: string, mimeType: string): File {
  if (typeof base64 !== 'string' || typeof name !== 'string' || !name || typeof mimeType !== 'string') {
    throw new Error('Invalid attachment file data.');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: mimeType || 'application/octet-stream' });
}
