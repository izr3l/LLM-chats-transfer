// Target injection shared by the popup listener and in-page toolbar.
import { TargetAdapter } from '../adapters/targets';
import { ChatGPTAdapter } from '../adapters/targets/chatgpt';
import { GenericTargetAdapter } from '../adapters/targets/fallback';
import { ManusTargetAdapter } from '../adapters/targets/manus';
import { AttachmentBlob, CanonicalConversation, isValidCanonicalConversation } from '../schema/canonical';
import { AttachmentResult, attachFilesToPage, fileFromBase64 } from '../shared/attachmentUpload';
import { formatAttachmentReferences } from '../shared/attachmentReferences';

declare global {
  interface Window { __chatTransferTargetRegistered?: boolean; }
}

export interface InjectionRequest {
  type: 'INJECT' | 'INJECT_RAW' | 'INJECT_FILE';
  base64?: string;
  filename?: string;
  mimeType?: string;
  /** Bind a pre-built transcript file to the snapshot it was generated from. */
  transferId?: string;
}

export interface InjectionResponse {
  status: 'success' | 'partial' | 'error';
  error?: string;
  attachmentResult?: AttachmentResult;
  warnings?: string[];
}

function sendBackground<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (response?.status === 'error') reject(new Error(response.error || 'Extension request failed.'));
      else resolve(response as T);
    });
  });
}

async function verifyIntegrity(transcript: CanonicalConversation): Promise<boolean> {
  if (!transcript.integrity?.sha256) return true;
  const canonical = JSON.stringify({ metadata: transcript.metadata, messages: transcript.messages });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hash === transcript.integrity.sha256;
}

function stripAttachmentPlaceholders(text: string): string {
  return text.replace(/\n*\[attachment:\d+\s+"[^"]*"\]/g, '').trimEnd();
}

function getAdapter(): TargetAdapter {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) {
    return new ChatGPTAdapter();
  } else if (host.includes('claude.ai')) {
    return new GenericTargetAdapter('Claude', [
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      'textarea'
    ]);
  } else if (host.includes('gemini.google.com')) {
    return new GenericTargetAdapter('Gemini', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  } else if (
    host.includes('manus.im') ||
    host.includes('manus.com') ||
    host.includes('manus.ai') ||
    host.includes('manus.computer')
  ) {
    return new ManusTargetAdapter();
  } else if (host.includes('qwen.ai') || host.includes('qwenlm.ai') || host.includes('chat.qwen.ai')) {
    return new GenericTargetAdapter('Qwen', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      '[data-testid*="input"]',
      '[data-testid*="composer"]'
    ]);
  } else if (host.includes('perplexity.ai')) {
    return new GenericTargetAdapter('Perplexity', [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  } else if (host.includes('x.com')) {
    return new GenericTargetAdapter('Grok', [
      'textarea[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ]);
  }

  throw new Error(`Unsupported target: ${host}`);
}

interface OriginalFile { alias: number; file: File; }

async function loadOriginalFiles(transcript: CanonicalConversation, transferId?: string): Promise<{
  files: OriginalFile[]; missing: string[]; warnings: string[];
}> {
  const references = transcript.messages.flatMap((message) => message.attachments || [])
    .filter((attachment) => attachment.kind !== 'link');
  const files: OriginalFile[] = [];
  const missing = new Set<string>();
  const warnings: string[] = [];
  const aliases = new Set<number>();
  for (const reference of references) {
    const name = reference.name || 'unnamed file';
    if (reference.blobAlias === undefined || !transferId) { missing.add(name); continue; }
    if (aliases.has(reference.blobAlias)) continue;
    aliases.add(reference.blobAlias);
    try {
      // Chrome messages have a size cap: load each <=25 MB file separately.
      const response = await sendBackground<{ blob?: AttachmentBlob | null }>({
        type: 'FETCH_ATTACHMENT', transferId, alias: reference.blobAlias,
      });
      const blob = response.blob;
      if (!blob || blob.alias !== reference.blobAlias || blob.transferId !== transferId) {
        missing.add(name);
        continue;
      }
      const file = fileFromBase64(blob.dataBase64, blob.name, blob.mimeType);
      if (file.size !== blob.size) throw new Error('Captured file size does not match stored data.');
      files.push({ alias: blob.alias, file });
    } catch (error) {
      missing.add(name);
      warnings.push(error instanceof Error ? error.message : `Could not load ${name}.`);
    }
  }
  return { files, missing: [...missing], warnings };
}

function rawTranscript(transcript: CanonicalConversation): string {
  return transcript.messages.map((message) => {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    const text = message.content.map((content) => content.text).join('\n').trim();
    return `${role}:\n${text}\n${formatAttachmentReferences(message)}`;
  }).join('\n\n');
}

/** Stage the complete attachment batch once, and keep the saved transfer for retries. */
export async function injectTransfer(request: InjectionRequest): Promise<InjectionResponse> {
  try {
    const adapter = getAdapter();
    const snapshot = await sendBackground<{ payload?: unknown; transferId?: string }>({ type: 'FETCH_TRANSCRIPT' });
    if (!isValidCanonicalConversation(snapshot.payload)) {
      throw new Error('No valid captured chat found. Capture a chat first.');
    }
    const transcript = snapshot.payload;
    if (request.transferId && request.transferId !== snapshot.transferId) {
      throw new Error('The selected capture changed. Choose Paste again to use the current capture.');
    }
    if (!await verifyIntegrity(transcript)) {
      throw new Error('Integrity check failed. Transfer aborted. Capture the chat again.');
    }
    const originals = await loadOriginalFiles(transcript, snapshot.transferId);
    let transcriptFile: File | undefined;
    if (request.type === 'INJECT_FILE') {
      transcriptFile = fileFromBase64(request.base64!, request.filename!, request.mimeType!);
    } else if (request.type === 'INJECT' && adapter.createTranscriptFile) {
      transcriptFile = adapter.createTranscriptFile(transcript);
    }
    const files = [...(transcriptFile ? [transcriptFile] : []), ...originals.files.map((entry) => entry.file)];
    const uploaded = attachFilesToPage(files);
    const attachedOriginals = originals.files.filter((entry) => uploaded.attached.includes(entry.file));
    const attachmentResult: AttachmentResult = {
      attempted: originals.files.length,
      attached: attachedOriginals.length,
      missing: originals.missing,
      failed: originals.files.filter((entry) => !uploaded.attached.includes(entry.file)).map((entry) => entry.file.name),
      method: uploaded.method,
    };
    const warnings = [...originals.warnings];
    if (uploaded.attached.length) warnings.push('Review the files in the composer and wait for uploads to finish before sending.');
    if (originals.missing.length) warnings.push('Some original files were unavailable during capture. Add them manually if needed.');
    if (attachmentResult.failed.length) warnings.push('The target did not accept the file batch. Use its upload button to add the files manually.');

    if (transcriptFile && !uploaded.attached.includes(transcriptFile)) {
      return { status: 'error', error: 'The transcript file could not be added to this composer.', attachmentResult, warnings };
    }
    if (request.type !== 'INJECT_FILE') {
      let prompt = request.type === 'INJECT_RAW' ? rawTranscript(transcript)
        : transcriptFile ? (adapter.filePrompt?.(transcript) || 'Read the attached transcript and continue from its last message.')
        : adapter.generateSingleShotPrompt(transcript);
      if (attachmentResult.failed.length || attachmentResult.missing.length) {
        prompt += `\n\nFiles still needed in this chat: ${[...attachmentResult.missing, ...attachmentResult.failed].join(', ')}. Ask the user to upload any of these needed to answer.`;
      }
      if (!adapter.injectPrompt(stripAttachmentPlaceholders(prompt))) {
        const staged = uploaded.attached.length
          ? ` ${uploaded.attached.length} file(s) were already added to the composer. Review them before retrying to avoid duplicates.`
          : '';
        return { status: 'error', error: `Could not find a text input on this page.${staged}`, attachmentResult, warnings };
      }
    }
    return {
      status: attachmentResult.failed.length || attachmentResult.missing.length || originals.warnings.length ? 'partial' : 'success',
      attachmentResult, warnings,
    };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

// The same guard is used when this module is bundled in the toolbar and injected by the popup.
if (!window.__chatTransferTargetRegistered) {
  window.__chatTransferTargetRegistered = true;
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!['INJECT', 'INJECT_RAW', 'INJECT_FILE'].includes(request.type)) return;
    void injectTransfer(request as InjectionRequest).then(sendResponse);
    return true;
  });
}
