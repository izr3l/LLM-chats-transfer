import type { CanonicalConversation } from '../schema/canonical';
import { blobToBase64 } from './transcriptExport';

interface CaptureSnapshot {
  payload?: CanonicalConversation | null;
  transferId?: string | null;
}

interface MissingFile {
  transferId: string;
  messageId: string;
  attachmentId: string;
  name: string;
}

/** Let the user link a local original to the exact message and file in a saved capture. */
export function mountMissingAttachmentPicker(
  container: HTMLElement,
  request: (message: Record<string, unknown>) => Promise<unknown>,
  report: (message: string, state: 'info' | 'success' | 'error') => void,
) {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  const list = document.createElement('div');
  list.className = 'missing-attachment-list';
  container.append(input, list);

  let pending: MissingFile | undefined;
  let saving = false;
  let refreshVersion = 0;

  async function refresh() {
    const version = ++refreshVersion;
    let snapshot: CaptureSnapshot | undefined;
    try {
      snapshot = await request({ type: 'FETCH_TRANSCRIPT' }) as CaptureSnapshot | undefined;
    } catch {
      // The next panel or history refresh can retry.
    }
    if (version !== refreshVersion) return;

    const entries: MissingFile[] = [];
    if (snapshot?.transferId && snapshot.payload) {
      for (const message of snapshot.payload.messages) {
        for (const attachment of message.attachments ?? []) {
          if (attachment.kind === 'link' || attachment.blobAlias !== undefined) continue;
          entries.push({ transferId: snapshot.transferId, messageId: message.id, attachmentId: attachment.id, name: attachment.name || 'Unnamed file' });
        }
      }
    }
    container.hidden = entries.length === 0;
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'missing-attachment-row';
      const name = document.createElement('span');
      name.textContent = entry.name;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Add file';
      button.setAttribute('aria-label', `Add file for ${entry.name}`);
      button.disabled = saving;
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || saving) return;
        pending = entry;
        input.value = '';
        input.click();
      });
      row.append(name, button);
      list.appendChild(row);
    }
  }

  input.addEventListener('cancel', () => { pending = undefined; });
  input.addEventListener('change', async (event) => {
    if (!event.isTrusted || saving) return;
    const entry = pending;
    pending = undefined;
    const file = input.files?.[0];
    input.value = '';
    if (!entry || !file) return;
    if (file.size > 25 * 1024 * 1024) {
      report('This file exceeds the 25 MB limit.', 'error');
      return;
    }

    saving = true;
    list.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    report(`Saving ${file.name} with this chat…`, 'info');
    try {
      const { transferId, messageId, attachmentId } = entry;
      const result = await request({
        type: 'RESTORE_CAPTURE_ATTACHMENT', transferId, messageId, attachmentId,
        file: { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataBase64: await blobToBase64(file) },
      }) as { status?: string; error?: string } | undefined;
      if (result?.status !== 'success') throw new Error(result?.error || 'Could not save the file with this chat.');
      report(`${file.name} saved with this chat. It will be included when you paste.`, 'success');
    } catch (error) {
      report(error instanceof Error ? error.message : 'Could not save the file with this chat.', 'error');
    } finally {
      saving = false;
      await refresh();
    }
  });

  return refresh;
}
