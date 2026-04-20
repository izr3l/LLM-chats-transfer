// Popup script — orchestrates extract/inject via programmatic script injection.
// Features: SPA routing (main ↔ summarize), Groq AI summarization, preview/consent modal.

import {
  DownloadFormat,
  TranscriptLike,
  blobToBase64,
  buildDocBlob,
  buildMarkdown,
  buildPdfBytes,
  buildPlainText,
  safeName,
} from '../shared/transcriptExport';

console.log("Popup script loaded.");

// ========== PROVIDER DETECTION ==========
const PROVIDER_MAP: Array<[string, string]> = [
  ['claude.ai', 'Claude'],
  ['chatgpt.com', 'ChatGPT'],
  ['gemini.google.com', 'Gemini'],
  ['manus.im', 'Manus'],
  ['manus.com', 'Manus'],
  ['manus.ai', 'Manus'],
  ['manus.computer', 'Manus'],
  ['chat.qwen.ai', 'Qwen'],
  ['qwen.ai', 'Qwen'],
  ['qwenlm.ai', 'Qwen'],
  ['perplexity.ai', 'Perplexity'],
  ['x.com', 'Grok (X)'],
];

function getProviderName(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    for (const [origin, name] of PROVIDER_MAP) {
      if (hostname === origin || hostname.endsWith(`.${origin}`)) return name;
    }
  } catch { /* invalid URL */ }
  return null;
}

type HistoryItem = {
  id: string;
  createdAt: string;
  source: string;
  title: string;
  messageCount: number;
  attachmentCount: number;
};

type PreviewMessage = {
  role: string;
  content: Array<{ text: string }>;
};

type PreviewPayload = {
  metadata: { source: string; title: string; createdAt: string };
  messages: PreviewMessage[];
  integrity?: { messageCount: number; sha256?: string };
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }
  return date.toLocaleString();
}

async function injectContentScript(scriptFile: string): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [scriptFile]
  });

  return tab.id;
}

function sendTabMessage(tabId: number, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ status: 'error', error: chrome.runtime.lastError.message ?? 'Unknown error' });
      } else {
        resolve(response as Record<string, unknown> ?? { status: 'error', error: 'No response' });
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // ========== ELEMENT REFS ==========
  // Main view
  const mainView = document.getElementById('main-view') as HTMLDivElement;
  const extractBtn = document.getElementById('extractBtn') as HTMLButtonElement;
  const injectBtn = document.getElementById('injectBtn') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;
  const historyListDiv = document.getElementById('historyList') as HTMLDivElement;
  const clearHistoryBtn = document.getElementById('clearHistoryBtn') as HTMLButtonElement;
  const seeAllHistoryBtn = document.getElementById('seeAllHistoryBtn') as HTMLButtonElement;

  // Full history view refs (needed early for refreshHistory)
  const fullHistoryList = document.getElementById('fullHistoryList') as HTMLDivElement;
  const historySearchInput = document.getElementById('historySearchInput') as HTMLInputElement;
  const historyCount = document.getElementById('historyCount') as HTMLSpanElement;
  const historySortBtn = document.getElementById('historySortBtn') as HTMLButtonElement;
  const backFromHistoryBtn = document.getElementById('backFromHistoryBtn') as HTMLButtonElement;
  const summarizeBtn = document.getElementById('summarizeBtn') as HTMLButtonElement;
  const pageDetectDiv = document.getElementById('pageDetect') as HTMLDivElement;

  // Summarize view
  const summarizeView = document.getElementById('summarize-view') as HTMLDivElement;
  const backToMainBtn = document.getElementById('backToMainBtn') as HTMLButtonElement;
  const summarizeMeta = document.getElementById('summarizeMeta') as HTMLDivElement;
  const summaryContent = document.getElementById('summaryContent') as HTMLDivElement;
  const copySummaryBtn = document.getElementById('copySummaryBtn') as HTMLButtonElement;
  const exportMdBtn = document.getElementById('exportMdBtn') as HTMLButtonElement;

  // Preview modal
  const previewModal = document.getElementById('previewModal') as HTMLDivElement;
  const previewMeta = document.getElementById('previewMeta') as HTMLDivElement;
  const previewContent = document.getElementById('previewContent') as HTMLDivElement;
  const confirmInjectBtn = document.getElementById('confirmInjectBtn') as HTMLButtonElement;
  const cancelInjectBtn = document.getElementById('cancelInjectBtn') as HTMLButtonElement;
  const modalCloseBtn = document.getElementById('modalCloseBtn') as HTMLButtonElement;

  // Confirmation modal
  const confirmModal = document.getElementById('confirmModal') as HTMLDivElement;
  const confirmTitle = document.getElementById('confirmTitle') as HTMLHeadingElement;
  const confirmMessage = document.getElementById('confirmMessage') as HTMLParagraphElement;
  const confirmOkBtn = document.getElementById('confirmOkBtn') as HTMLButtonElement;
  const confirmCancelBtn = document.getElementById('confirmCancelBtn') as HTMLButtonElement;
  const confirmIconWrap = document.getElementById('confirmIconWrap') as HTMLDivElement;

  // Settings modal
  const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
  const settingsModal = document.getElementById('settingsModal') as HTMLDivElement;
  const settingsCloseBtn = document.getElementById('settingsCloseBtn') as HTMLButtonElement;
  const providerSelect = document.getElementById('providerSelect') as HTMLSelectElement;
  const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement;
  const toggleApiKeyBtn = document.getElementById('toggleApiKeyBtn') as HTMLButtonElement;
  const saveApiKeyBtn = document.getElementById('saveApiKeyBtn') as HTMLButtonElement;
  const clearApiKeyBtn = document.getElementById('clearApiKeyBtn') as HTMLButtonElement;
  const apiKeyStatus = document.getElementById('apiKeyStatus') as HTMLDivElement;

  // Download picker modal
  const downloadPickerModal = document.getElementById('downloadPickerModal') as HTMLDivElement;
  const downloadPickerClose = document.getElementById('downloadPickerClose') as HTMLButtonElement;
  const downloadPickerList = downloadPickerModal.querySelector('.download-picker-list') as HTMLDivElement;

  // Paste mode picker modal
  const pasteModeModal     = document.getElementById('pasteModeModal') as HTMLDivElement;
  const pasteModeClose     = document.getElementById('pasteModeClose') as HTMLButtonElement;
  const pasteModeList      = pasteModeModal.querySelector('.paste-picker-modal-list') as HTMLDivElement;

  // State
  let currentSummaryMarkdown = '';
  let pendingDownloadHistoryId: string | null = null;  // when downloading a specific history item

  // ========== SPA ROUTING ==========
  const historyView = document.getElementById('history-view') as HTMLDivElement;
  function showView(viewId: 'main' | 'summarize' | 'history') {
    mainView.classList.toggle('active', viewId === 'main');
    summarizeView.classList.toggle('active', viewId === 'summarize');
    historyView.classList.toggle('active', viewId === 'history');
  }

  summarizeBtn.addEventListener('click', () => {
    showView('summarize');
    runSummarize(false);
  });

  backToMainBtn.addEventListener('click', () => {
    showView('main');
  });

  // ========== HISTORY ==========
  let allHistoryItems: HistoryItem[] = [];

  /** Renders the compact recent-history preview (top 3 items) in the main view. */
  const renderHistory = (items: HistoryItem[]) => {
    allHistoryItems = items;
    historyListDiv.innerHTML = '';

    // Show/hide "See All" based on whether there are items
    seeAllHistoryBtn.style.display = items.length > 0 ? '' : 'none';

    if (items.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'history-empty';
      emptyDiv.textContent = 'No copied chats yet.';
      historyListDiv.appendChild(emptyDiv);
      return;
    }

    // Only show the 3 most recent
    const recent = items.slice(0, 3);
    recent.forEach((item) => {
      historyListDiv.appendChild(buildHistoryCard(item));
    });
  };

  /** Builds a single history item card element (shared between recent + full views). */
  function buildHistoryCard(item: HistoryItem): HTMLDivElement {
      const card = document.createElement('div');
      card.className = 'history-item';

      const title = document.createElement('div');
      title.className = 'history-item-title';
      title.textContent = item.title || 'Untitled chat';

      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      meta.textContent = `${item.source} • ${item.messageCount} messages • ${item.attachmentCount || 0} attachments • ${formatTimestamp(item.createdAt)}`;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'history-item-actions';

      const useBtn = document.createElement('button');
      useBtn.className = 'use-btn';
      useBtn.textContent = 'Use This Chat';
      useBtn.dataset.historyId = item.id;
      useBtn.dataset.action = 'use';

      const summarizeItemBtn = document.createElement('button');
      summarizeItemBtn.className = 'icon-btn purple';
      summarizeItemBtn.dataset.action = 'summarize';
      summarizeItemBtn.dataset.historyId = item.id;
      summarizeItemBtn.title = 'Summarize this chat';
      summarizeItemBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="6" x2="14" y2="6"></line>
          <line x1="3" y1="11" x2="12" y2="11"></line>
          <line x1="3" y1="16" x2="8" y2="16"></line>
          <path fill="currentColor" stroke="none" d="M18.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4-3.4-1.1 3.4-1.1z"></path>
          <path fill="currentColor" stroke="none" d="M21 15.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z"></path>
        </svg>`;

      const deleteItemBtn = document.createElement('button');
      deleteItemBtn.className = 'icon-btn danger';
      deleteItemBtn.dataset.action = 'delete';
      deleteItemBtn.dataset.historyId = item.id;
      deleteItemBtn.dataset.title = item.title || 'Untitled chat';
      deleteItemBtn.title = 'Delete this chat';
      deleteItemBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

      actionsDiv.appendChild(useBtn);
      actionsDiv.appendChild(summarizeItemBtn);

      const downloadItemBtn = document.createElement('button');
      downloadItemBtn.className = 'icon-btn';
      downloadItemBtn.dataset.action = 'download';
      downloadItemBtn.dataset.historyId = item.id;
      downloadItemBtn.title = 'Download this chat';
      downloadItemBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
      actionsDiv.appendChild(downloadItemBtn);

      actionsDiv.appendChild(deleteItemBtn);

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actionsDiv);
      return card;
  }

  const refreshHistory = () => {
    chrome.runtime.sendMessage({ type: 'LIST_HISTORY' }, (result) => {
      const items = Array.isArray(result?.items) ? result.items as HistoryItem[] : [];
      renderHistory(items);
      // Also refresh the full history view if it's visible
      if (historyView.classList.contains('active')) {
        renderFullHistory(historySearchInput.value.trim());
      }
    });
  };

  // ========== PAGE DETECTION STRIP ==========
  function renderPageDetect(provider: string | null, hasTranscript: boolean, transcriptSource: string | null) {
    pageDetectDiv.innerHTML = '';

    if (!provider && !hasTranscript) {
      pageDetectDiv.style.display = 'none';
      return;
    }

    pageDetectDiv.style.display = 'flex';

    if (provider) {
      const dot = document.createElement('span');
      dot.className = 'detect-dot';

      const name = document.createElement('span');
      name.className = 'detect-provider';
      name.textContent = `${provider} detected`;

      pageDetectDiv.appendChild(dot);
      pageDetectDiv.appendChild(name);
    }

    if (hasTranscript) {
      if (provider) {
        const sep = document.createElement('span');
        sep.className = 'detect-sep';
        sep.textContent = '·';
        pageDetectDiv.appendChild(sep);
      }

      const info = document.createElement('span');
      info.className = hasTranscript && transcriptSource ? 'detect-transfer' : 'detect-no-page';

      const src = transcriptSource ?? 'Unknown';
      if (provider) {
        info.textContent = src.toLowerCase() !== provider.toLowerCase()
          ? `Captured from ${src} · paste here`
          : 'Chat captured — ready to paste here';
      } else {
        info.textContent = `${src} chat captured — open a target tab to paste`;
      }

      pageDetectDiv.appendChild(info);
    } else if (provider) {
      // Provider detected but no pending transcript
      const sep = document.createElement('span');
      sep.className = 'detect-sep';
      sep.textContent = '·';

      const hint = document.createElement('span');
      hint.className = 'detect-no-page';
      hint.textContent = 'capture or paste a chat here';

      pageDetectDiv.appendChild(sep);
      pageDetectDiv.appendChild(hint);
    }
  }

  // Initialise: detect active tab + check pending transcript in parallel
  async function initPageDetect(skipStatusMsg = false) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeUrl = tabs[0]?.url ?? '';
    const provider = getProviderName(activeUrl);

    chrome.runtime.sendMessage({ type: 'HAS_TRANSCRIPT' }, (result) => {
      const hasTranscript = Boolean(result?.hasTranscript);
      const meta = result?.meta as { source?: string; title?: string } | null;
      const transcriptSource = meta?.source ?? null;

      if (hasTranscript) {
        injectBtn.disabled = false;
        if (!skipStatusMsg) {
          if (!provider) {
            // No recognised page — show generic pending message in status
            statusDiv.textContent = `${transcriptSource ?? 'Chat'} chat captured — open a target tab to paste.`;
            statusDiv.className = 'status-box status success';
          } else {
            statusDiv.textContent = `${transcriptSource ?? 'Chat'} chat captured — ready to paste or capture another.`;
            statusDiv.className = 'status-box status success';
          }
        }
      } else if (provider && !skipStatusMsg) {
        statusDiv.textContent = 'Ready. Capture a chat or paste a previously captured one.';
        statusDiv.className = 'status-box status';
      }

      renderPageDetect(provider, hasTranscript, transcriptSource);
    });
  }

  void initPageDetect();

  refreshHistory();

  // ========== EXTRACT ==========
  extractBtn.addEventListener('click', async () => {
    statusDiv.textContent = 'Extracting...';
    statusDiv.className = 'status-box status';

    try {
      const tabId = await injectContentScript('content-source.js');
      await new Promise((r) => setTimeout(r, 100));
      const response = await sendTabMessage(tabId, { type: 'EXTRACT' });

      if (response.status === 'success') {
        const info = response.data as PreviewPayload | undefined;
        const msgCount = info?.integrity?.messageCount ?? 0;
        const attachmentCount = Array.isArray(info?.messages)
          ? info.messages.reduce((sum: number, msg: PreviewMessage) => {
            const attachments = (msg as Record<string, unknown>).attachments;
            return sum + (Array.isArray(attachments) ? attachments.length : 0);
          }, 0)
          : 0;
        statusDiv.textContent = `Extracted ${msgCount} messages and ${attachmentCount} attachments. Ready to inject.`;
        statusDiv.className = 'status-box status success';
        injectBtn.disabled = false;
        refreshHistory();
        runSummarize(true);
        // Refresh page detect strip with new transcript source
        void initPageDetect(true);
      } else {
        const errMsg = typeof response.error === 'string' ? response.error : 'Extraction failed.';
        if (errMsg.includes('Receiving end does not exist')) {
          statusDiv.textContent = 'Please refresh this page for the extension to load.';
        } else {
          statusDiv.textContent = errMsg;
        }
        statusDiv.className = 'status-box status error';
      }
    } catch (err) {
      statusDiv.textContent = err instanceof Error ? err.message : 'Error executing script.';
      statusDiv.className = 'status-box status error';
    }
  });

  // ========== INJECT (with preview/consent modal) ==========
  function closeModal() {
    previewModal.classList.remove('visible');
  }

  function truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
  }

  function showPreviewModal(transcript: PreviewPayload) {
    const source = transcript.metadata?.source ?? 'Unknown';
    const title = transcript.metadata?.title ?? 'Untitled';
    const msgCount = transcript.integrity?.messageCount ?? transcript.messages?.length ?? 0;
    previewMeta.textContent = `Source: ${source} • Title: ${title} • ${msgCount} messages`;

    previewContent.innerHTML = '';
    const messagesToShow = (transcript.messages ?? []).slice(0, 10);
    messagesToShow.forEach((msg) => {
      const roleSpan = document.createElement('span');
      roleSpan.className = 'preview-role';
      roleSpan.textContent = `[${(msg.role ?? 'unknown').toUpperCase()}]`;
      previewContent.appendChild(roleSpan);

      const textSpan = document.createElement('span');
      textSpan.className = 'preview-text';
      const fullText = Array.isArray(msg.content)
        ? msg.content.map((c) => c.text ?? '').join('\n')
        : '';
      textSpan.textContent = truncateText(fullText, 200);
      previewContent.appendChild(textSpan);
    });

    if ((transcript.messages?.length ?? 0) > 10) {
      const moreSpan = document.createElement('span');
      moreSpan.className = 'preview-role';
      moreSpan.textContent = `... and ${(transcript.messages?.length ?? 0) - 10} more messages`;
      previewContent.appendChild(moreSpan);
    }

    previewModal.classList.add('visible');
  }

  injectBtn.addEventListener('click', () => {
    // Show paste mode picker instead of going straight to preview
    pasteModeModal.classList.add('visible');
  });

  pasteModeClose.addEventListener('click', () => {
    pasteModeModal.classList.remove('visible');
  });
  pasteModeModal.addEventListener('click', (e) => {
    if (e.target === pasteModeModal) pasteModeModal.classList.remove('visible');
  });

  pasteModeList.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.paste-mode-option') as HTMLElement | null;
    if (!btn) return;
    const mode = btn.dataset.mode as 'inline' | 'raw' | 'pdf' | 'txt' | 'doc' | undefined;
    if (!mode) return;

    pasteModeModal.classList.remove('visible');

    if (mode === 'inline') {
      // Existing flow: show preview then confirm-inject
      statusDiv.textContent = 'Loading preview...';
      statusDiv.className = 'status-box status';
      chrome.runtime.sendMessage({ type: 'PREVIEW_TRANSCRIPT' }, (response) => {
        const transcript = response?.payload as PreviewPayload | null;
        if (!transcript) {
          statusDiv.textContent = 'No transcript available for preview.';
          statusDiv.className = 'status-box status error';
          return;
        }
        statusDiv.textContent = 'Review the transcript before injecting.';
        statusDiv.className = 'status-box status';
        showPreviewModal(transcript);
      });
      return;
    }

    // For all other modes, inject content script and send message
    statusDiv.textContent = mode === 'raw' ? 'Injecting raw text…' : `Attaching as ${mode.toUpperCase()}…`;
    statusDiv.className = 'status-box status';

    try {
      const tabId = await injectContentScript('content-target.js');
      await new Promise((r) => setTimeout(r, 100));

      if (mode === 'raw') {
        const response = await sendTabMessage(tabId, { type: 'INJECT_RAW' });
        if (response.status === 'success') {
          statusDiv.textContent = 'Raw transcript injected. You can now press Send.';
          statusDiv.className = 'status-box status success';
        } else {
          statusDiv.textContent = (response.error as string | undefined) ?? 'Injection failed.';
          statusDiv.className = 'status-box status error';
        }
      } else {
        // pdf | txt | doc — build file locally, send as base64
        const result = await new Promise<{ payload?: TranscriptLike | null }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'FETCH_TRANSCRIPT' }, resolve);
        });
        const transcript = result?.payload;
        if (!transcript) {
          statusDiv.textContent = 'No captured chat found.';
          statusDiv.className = 'status-box status error';
          return;
        }

        const name = safeName(transcript.metadata?.title);
        let blob: Blob;
        let filename: string;

        if (mode === 'txt') {
          blob = new Blob([buildPlainText(transcript)], { type: 'text/plain' });
          filename = `${name}.txt`;
        } else if (mode === 'doc') {
          blob = buildDocBlob(transcript);
          filename = `${name}.doc`;
        } else { // pdf
          blob = new Blob([buildPdfBytes(transcript).buffer as ArrayBuffer], { type: 'application/pdf' });
          filename = `${name}.pdf`;
        }

        // Convert to base64 for cross-context transfer (chunked to avoid memory spikes)
        const base64 = await blobToBase64(blob);

        const response = await sendTabMessage(tabId, {
          type: 'INJECT_FILE',
          base64,
          filename,
          mimeType: blob.type,
        });

        if (response.status === 'success') {
          statusDiv.textContent = `${mode.toUpperCase()} file attached to the chat input.`;
          statusDiv.className = 'status-box status success';
        } else {
          // Fallback: download the file
          triggerDownload(blob, filename);
          statusDiv.textContent = `${mode.toUpperCase()} downloaded — attach it to the chat input manually.`;
          statusDiv.className = 'status-box status';
        }
      }
    } catch (err) {
      statusDiv.textContent = err instanceof Error ? err.message : 'Error executing script.';
      statusDiv.className = 'status-box status error';
    }
  });

  confirmInjectBtn.addEventListener('click', async () => {
    closeModal();
    statusDiv.textContent = 'Injecting...';
    statusDiv.className = 'status-box status';

    try {
      const tabId = await injectContentScript('content-target.js');
      await new Promise((r) => setTimeout(r, 100));
      const response = await sendTabMessage(tabId, { type: 'INJECT' });

      if (response.status === 'success') {
        statusDiv.textContent = 'Injected successfully. You can now press Send.';
        statusDiv.className = 'status-box status success';
        injectBtn.disabled = true;
      } else {
        const errMsg = typeof response.error === 'string' ? response.error : 'Injection failed.';
        if (errMsg.includes('Receiving end does not exist')) {
          statusDiv.textContent = 'Please refresh this page for the extension to load.';
        } else {
          statusDiv.textContent = errMsg;
        }
        statusDiv.className = 'status-box status error';
      }
    } catch (err) {
      statusDiv.textContent = err instanceof Error ? err.message : 'Error executing script.';
      statusDiv.className = 'status-box status error';
    }
  });

  cancelInjectBtn.addEventListener('click', () => {
    closeModal();
    statusDiv.textContent = 'Injection cancelled.';
    statusDiv.className = 'status-box status';
  });

  modalCloseBtn.addEventListener('click', closeModal);

  // ========== CONFIRMATION MODAL ==========
  let confirmResolve: ((ok: boolean) => void) | null = null;

  type ConfirmOptions = {
    title: string;
    message: string;
    okLabel: string;
    type: 'danger' | 'warning';
  };

  const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
  const WARN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

  function showConfirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmTitle.textContent = opts.title;
      confirmMessage.textContent = opts.message;
      confirmOkBtn.textContent = opts.okLabel;
      confirmOkBtn.className = opts.type === 'danger' ? 'btn-danger' : 'btn-warning';
      confirmIconWrap.className = `confirm-icon-wrap ${opts.type}`;
      confirmIconWrap.innerHTML = opts.type === 'danger' ? TRASH_ICON : WARN_ICON;
      confirmModal.classList.add('visible');
    });
  }

  confirmOkBtn.addEventListener('click', () => {
    confirmModal.classList.remove('visible');
    confirmResolve?.(true);
    confirmResolve = null;
  });

  confirmCancelBtn.addEventListener('click', () => {
    confirmModal.classList.remove('visible');
    confirmResolve?.(false);
    confirmResolve = null;
  });

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      confirmModal.classList.remove('visible');
      confirmResolve?.(false);
      confirmResolve = null;
    }
  });

  // ========== SETTINGS MODAL ==========
  const PROVIDER_LABELS: Record<string, string> = {
    groq: 'Groq (llama-3.3-70b-versatile)',
    openai: 'OpenAI (gpt-5.4-nano)',
  };

  const EYE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  const EYE_OFF_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

  function openSettings() {
    chrome.runtime.sendMessage({ type: 'GET_AI_CONFIG_META' }, (result) => {
      const providerId = typeof result?.providerId === 'string' ? result.providerId : 'groq';
      const hasKey = Boolean(result?.hasKey);
      providerSelect.value = providerId;
      apiKeyInput.value = '';
      apiKeyInput.type = 'password';
      toggleApiKeyBtn.innerHTML = EYE_ICON;
      if (hasKey) {
        apiKeyStatus.textContent = `\u2713 Encrypted key active for ${PROVIDER_LABELS[providerId] ?? providerId}. Enter a new one to replace it.`;
        apiKeyStatus.className = 'api-key-status active';
      } else {
        apiKeyStatus.textContent = `Using built-in key for ${PROVIDER_LABELS[providerId] ?? providerId}.`;
        apiKeyStatus.className = 'api-key-status empty';
      }
    });
    settingsModal.classList.add('visible');
  }

  settingsBtn.addEventListener('click', openSettings);
  settingsCloseBtn.addEventListener('click', () => settingsModal.classList.remove('visible'));
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove('visible');
  });

  // ── Toolbar visibility toggle ──────────────────────────────────────────────
  const toolbarToggle = document.getElementById('toolbarToggle') as HTMLInputElement;

  // Load saved state (default = on)
  chrome.storage.local.get('toolbarEnabled', (data) => {
    toolbarToggle.checked = data.toolbarEnabled !== false;
  });

  toolbarToggle.addEventListener('change', () => {
    const enabled = toolbarToggle.checked;
    chrome.storage.local.set({ toolbarEnabled: enabled });
  });

  providerSelect.addEventListener('change', () => {
    const providerId = providerSelect.value;
    chrome.runtime.sendMessage({ type: 'GET_AI_CONFIG_META' }, (result) => {
      const currentProviderId = typeof result?.providerId === 'string' ? result.providerId : 'groq';
      const hasKey = Boolean(result?.hasKey) && currentProviderId === providerId;
      if (hasKey) {
        apiKeyStatus.textContent = `\u2713 Encrypted key active. Press Save to switch provider too.`;
        apiKeyStatus.className = 'api-key-status active';
      } else {
        apiKeyStatus.textContent = `No custom key for ${PROVIDER_LABELS[providerId] ?? providerId}. Using built-in key.`;
        apiKeyStatus.className = 'api-key-status empty';
      }
    });
  });

  toggleApiKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleApiKeyBtn.innerHTML = isPassword ? EYE_OFF_ICON : EYE_ICON;
  });

  saveApiKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const providerId = providerSelect.value;
    chrome.runtime.sendMessage({ type: 'SAVE_AI_CONFIG', providerId, apiKey: key }, (result) => {
      apiKeyInput.value = '';
      apiKeyInput.type = 'password';
      toggleApiKeyBtn.innerHTML = EYE_ICON;
      if (result?.status === 'success') {
        const providerLabel = PROVIDER_LABELS[providerId] ?? providerId;
        if (key) {
          apiKeyStatus.textContent = `\u2713 Encrypted key saved for ${providerLabel}.`;
          apiKeyStatus.className = 'api-key-status saved';
          setTimeout(() => {
            apiKeyStatus.textContent = `\u2713 ${providerLabel} \u2014 encrypted key active.`;
            apiKeyStatus.className = 'api-key-status active';
          }, 2000);
        } else {
          apiKeyStatus.textContent = `Provider set to ${providerLabel}. Using built-in key.`;
          apiKeyStatus.className = 'api-key-status empty';
        }
      } else {
        apiKeyStatus.textContent = result?.error || 'Failed to save settings.';
        apiKeyStatus.className = 'api-key-status empty';
      }
    });
  });

  clearApiKeyBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REMOVE_AI_CONFIG' }, (result) => {
      if (result?.status === 'success') {
        apiKeyInput.value = '';
        const providerId = providerSelect.value;
        apiKeyStatus.textContent = `Key removed. Using built-in key for ${PROVIDER_LABELS[providerId] ?? providerId}.`;
        apiKeyStatus.className = 'api-key-status empty';
      }
    });
  });

  // ========== HISTORY ITEM SELECTION ==========
  function handleHistoryItemClick(event: Event) {
    const target = (event.target as HTMLElement).closest('button');
    if (!target) return;

    const historyId = (target as HTMLElement).dataset.historyId;
    if (!historyId) return;

    const action = (target as HTMLElement).dataset.action || 'use';

    if (action === 'delete') {
      const itemTitle = (target as HTMLElement).dataset.title || 'this chat';
      void showConfirm({
        title: 'Delete Chat',
        message: `Are you sure you want to delete "${itemTitle}"? This action cannot be undone.`,
        okLabel: 'Delete',
        type: 'danger'
      }).then((confirmed) => {
        if (!confirmed) return;
        chrome.runtime.sendMessage({ type: 'DELETE_HISTORY_ITEM', id: historyId }, (result) => {
          if (result?.status === 'success') {
            refreshHistory();
          } else {
            statusDiv.textContent = result?.error || 'Failed to delete history item.';
            statusDiv.className = 'status-box status error';
          }
        });
      });
      return;
    }

    if (action === 'summarize') {
      chrome.runtime.sendMessage({ type: 'LOAD_HISTORY_ITEM', id: historyId }, (result) => {
        if (result?.status === 'success') {
          showView('summarize');
          runSummarize(true);
        } else {
          statusDiv.textContent = result?.error || 'Failed to load history item for summary.';
          statusDiv.className = 'status-box status error';
        }
      });
      return;
    }

    if (action === 'download') {
      pendingDownloadHistoryId = historyId;
      downloadPickerModal.classList.add('visible');
      return;
    }

    // Default 'use' action
    chrome.runtime.sendMessage({ type: 'LOAD_HISTORY_ITEM', id: historyId }, (result) => {
      if (result?.status === 'success') {
        showView('main');
        statusDiv.textContent = 'Loaded history item. Ready to inject.';
        statusDiv.className = 'status-box status success';
        injectBtn.disabled = false;
        void initPageDetect();
      } else {
        statusDiv.textContent = result?.error || 'Failed to load history item.';
        statusDiv.className = 'status-box status error';
      }
    });
  }

  historyListDiv.addEventListener('click', handleHistoryItemClick);

  // ========== FULL HISTORY VIEW ==========
  let historySortNewest = true;

  fullHistoryList.addEventListener('click', handleHistoryItemClick);

  function renderFullHistory(filter = '') {
    fullHistoryList.innerHTML = '';
    let filtered = allHistoryItems;
    if (filter) {
      const q = filter.toLowerCase();
      filtered = filtered.filter((i) =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.source || '').toLowerCase().includes(q)
      );
    }
    if (!historySortNewest) {
      filtered = [...filtered].reverse();
    }
    historyCount.textContent = `${filtered.length} chat${filtered.length !== 1 ? 's' : ''}`;
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = filter ? 'No chats match your search.' : 'No captured chats yet.';
      fullHistoryList.appendChild(empty);
      return;
    }
    filtered.forEach((item) => {
      fullHistoryList.appendChild(buildHistoryCard(item));
    });
  }

  seeAllHistoryBtn.addEventListener('click', () => {
    showView('history');
    historySearchInput.value = '';
    renderFullHistory();
  });

  backFromHistoryBtn.addEventListener('click', () => {
    showView('main');
  });

  historySearchInput.addEventListener('input', () => {
    renderFullHistory(historySearchInput.value.trim());
  });

  historySortBtn.addEventListener('click', () => {
    historySortNewest = !historySortNewest;
    historySortBtn.textContent = historySortNewest ? 'Newest first ↓' : 'Oldest first ↑';
    renderFullHistory(historySearchInput.value.trim());
  });

  clearHistoryBtn.addEventListener('click', () => {
    void showConfirm({
      title: 'Clear All Chats',
      message: 'This will permanently remove all captured chats from your history. This action cannot be undone.',
      okLabel: 'Clear All',
      type: 'warning'
    }).then((confirmed) => {
      if (!confirmed) return;
      chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, (result) => {
        if (result?.status === 'success') {
          refreshHistory();
          statusDiv.textContent = 'History cleared.';
          statusDiv.className = 'status-box status success';
        } else {
          statusDiv.textContent = result?.error || 'Failed to clear history.';
          statusDiv.className = 'status-box status error';
        }
      });
    });
  });

  // ========== SUMMARIZE ==========

  /**
   * Converts raw markdown text to basic HTML for display.
   * Handles headers, bold, italic, code blocks, inline code, and bullet lists.
   */
  function markdownToHtml(md: string): string {
    let html = md
      // Escape HTML entities first
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
      return `<pre style="background:#0d1117;border:1px solid var(--border);border-radius:4px;padding:8px;overflow-x:auto;font-size:12px;margin:8px 0;"><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:#21262d;padding:2px 5px;border-radius:3px;font-size:12px;">$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text)">$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Bullet lists
    html = html.replace(/^[-*] (.+)$/gm, '<li style="margin-left:16px;margin-bottom:2px;">$1</li>');

    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;margin-bottom:2px;list-style-type:decimal;">$1</li>');

    // Line breaks (double newline = paragraph break)
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  function runSummarize(force: boolean = false) {
    if (!force && currentSummaryMarkdown) return;

    // Show loading state
    summaryContent.innerHTML = `
      <div class="summary-loading">
        <div class="spinner"></div>
        <span>Summarizing with AI…</span>
      </div>
    `;
    summarizeMeta.style.display = 'none';
    copySummaryBtn.disabled = true;
    exportMdBtn.disabled = true;
    currentSummaryMarkdown = '';

    chrome.runtime.sendMessage({ type: 'SUMMARIZE_TRANSCRIPT' }, (response) => {
      if (response?.status === 'success') {
        const summary = response.summary as string;
        const source = response.source as string;
        const title = response.title as string;
        const messageCount = response.messageCount as number;

        currentSummaryMarkdown = summary;

        // Show metadata
        summarizeMeta.textContent = `Source: ${source} • "${title}" • ${messageCount} messages`;
        summarizeMeta.style.display = 'block';

        // Render markdown summary as HTML
        summaryContent.innerHTML = markdownToHtml(summary);

        // Enable action buttons
        copySummaryBtn.disabled = false;
        exportMdBtn.disabled = false;
      } else {
        const errMsg = typeof response?.error === 'string' ? response.error : 'Summarization failed.';
        summaryContent.innerHTML = `<div class="summary-error">⚠ ${errMsg}</div>`;
        copySummaryBtn.disabled = true;
        exportMdBtn.disabled = true;
      }
    });
  }

  // Copy summary to clipboard
  copySummaryBtn.addEventListener('click', async () => {
    if (!currentSummaryMarkdown) return;

    try {
      await navigator.clipboard.writeText(currentSummaryMarkdown);
      const originalText = copySummaryBtn.textContent;
      copySummaryBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copySummaryBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy`;
      }, 1500);
    } catch {
      copySummaryBtn.textContent = 'Failed';
      setTimeout(() => { copySummaryBtn.textContent = 'Copy'; }, 1500);
    }
  });

  // Download — opens format picker
  exportMdBtn.addEventListener('click', () => {
    pendingDownloadHistoryId = null; // download current transcript
    downloadPickerModal.classList.add('visible');
  });

  // ========== DOWNLOAD FORMAT PICKER ==========

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadTranscript(transcript: TranscriptLike, fmt: DownloadFormat) {
    const name = safeName(transcript.metadata.title);
    switch (fmt) {
      case 'txt':
        triggerDownload(new Blob([buildPlainText(transcript)], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
        break;
      case 'md':
        triggerDownload(new Blob([buildMarkdown(transcript)], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
        break;
      case 'doc':
        triggerDownload(buildDocBlob(transcript), `${name}.doc`);
        break;
      case 'pdf':
        triggerDownload(new Blob([buildPdfBytes(transcript).buffer as ArrayBuffer], { type: 'application/pdf' }), `${name}.pdf`);
        break;
    }
  }

  downloadPickerClose.addEventListener('click', () => downloadPickerModal.classList.remove('visible'));
  downloadPickerModal.addEventListener('click', (e) => {
    if (e.target === downloadPickerModal) downloadPickerModal.classList.remove('visible');
  });

  downloadPickerList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.download-option') as HTMLElement | null;
    if (!btn) return;
    const fmt = btn.dataset.fmt as DownloadFormat;
    if (!fmt) return;

    downloadPickerModal.classList.remove('visible');

    if (pendingDownloadHistoryId) {
      // Download a specific history item
      chrome.runtime.sendMessage({ type: 'LOAD_HISTORY_ITEM', id: pendingDownloadHistoryId }, (result) => {
        if (result?.status !== 'success') {
          statusDiv.textContent = 'Failed to load history item for download.';
          statusDiv.className = 'status-box status error';
          return;
        }
        chrome.runtime.sendMessage({ type: 'PREVIEW_TRANSCRIPT' }, (resp) => {
          const transcript = resp?.payload as TranscriptLike | null;
          if (!transcript) {
            statusDiv.textContent = 'No transcript data available.';
            statusDiv.className = 'status-box status error';
            return;
          }
          downloadTranscript(transcript, fmt);
          statusDiv.textContent = `Downloaded as .${fmt}`;
          statusDiv.className = 'status-box status success';
        });
      });
    } else {
      // Download the current active transcript
      chrome.runtime.sendMessage({ type: 'PREVIEW_TRANSCRIPT' }, (resp) => {
        const transcript = resp?.payload as TranscriptLike | null;
        if (!transcript) {
          statusDiv.textContent = 'No transcript data available.';
          statusDiv.className = 'status-box status error';
          return;
        }
        downloadTranscript(transcript, fmt);
      });
    }
    pendingDownloadHistoryId = null;
  });
});