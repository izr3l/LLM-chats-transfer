// Popup script — orchestrates extract/inject via programmatic script injection.
// Features: SPA routing (main ↔ summarize), Groq AI summarization, preview/consent modal.

console.log("Popup script loaded.");

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
  const summarizeBtn = document.getElementById('summarizeBtn') as HTMLButtonElement;

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

  // State
  let currentSummaryMarkdown = '';

  // ========== SPA ROUTING ==========
  function showView(viewId: 'main' | 'summarize') {
    mainView.classList.toggle('active', viewId === 'main');
    summarizeView.classList.toggle('active', viewId === 'summarize');
  }

  summarizeBtn.addEventListener('click', () => {
    showView('summarize');
    runSummarize(false);
  });

  backToMainBtn.addEventListener('click', () => {
    showView('main');
  });

  // ========== HISTORY ==========
  const renderHistory = (items: HistoryItem[]) => {
    historyListDiv.innerHTML = '';
    if (items.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'history-empty';
      emptyDiv.textContent = 'No copied chats yet.';
      historyListDiv.appendChild(emptyDiv);
      return;
    }

    items.forEach((item) => {
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
      summarizeItemBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg>`;

      const deleteItemBtn = document.createElement('button');
      deleteItemBtn.className = 'icon-btn danger';
      deleteItemBtn.dataset.action = 'delete';
      deleteItemBtn.dataset.historyId = item.id;
      deleteItemBtn.title = 'Delete this chat';
      deleteItemBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

      actionsDiv.appendChild(useBtn);
      actionsDiv.appendChild(summarizeItemBtn);
      actionsDiv.appendChild(deleteItemBtn);

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actionsDiv);
      historyListDiv.appendChild(card);
    });
  };

  const refreshHistory = () => {
    chrome.runtime.sendMessage({ type: 'LIST_HISTORY' }, (result) => {
      const items = Array.isArray(result?.items) ? result.items as HistoryItem[] : [];
      renderHistory(items);
    });
  };

  // Check for pending transcript
  chrome.runtime.sendMessage({ type: 'HAS_TRANSCRIPT' }, (result) => {
    if (result?.hasTranscript) {
      statusDiv.textContent = 'Pending transfer found. Ready to inject.';
      statusDiv.className = 'status-box status success';
      injectBtn.disabled = false;
    }
  });

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

  // ========== HISTORY ITEM SELECTION ==========
  historyListDiv.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('button');
    if (!target) return;
    
    const historyId = target.dataset.historyId;
    if (!historyId) return;

    const action = target.dataset.action || 'use';

    if (action === 'delete') {
      chrome.runtime.sendMessage({ type: 'DELETE_HISTORY_ITEM', id: historyId }, (result) => {
        if (result?.status === 'success') {
          refreshHistory();
        } else {
          statusDiv.textContent = result?.error || 'Failed to delete history item.';
          statusDiv.className = 'status-box status error';
        }
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

    // Default 'use' action
    chrome.runtime.sendMessage({ type: 'LOAD_HISTORY_ITEM', id: historyId }, (result) => {
      if (result?.status === 'success') {
        statusDiv.textContent = 'Loaded history item. Ready to inject.';
        statusDiv.className = 'status-box status success';
        injectBtn.disabled = false;
      } else {
        statusDiv.textContent = result?.error || 'Failed to load history item.';
        statusDiv.className = 'status-box status error';
      }
    });
  });

  clearHistoryBtn.addEventListener('click', () => {
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

  // Export as .md file
  exportMdBtn.addEventListener('click', () => {
    if (!currentSummaryMarkdown) return;

    const blob = new Blob([currentSummaryMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const filename = `chat-summary-${new Date().toISOString().slice(0, 10)}.md`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const originalText = exportMdBtn.textContent;
    exportMdBtn.textContent = '✓ Downloaded!';
    setTimeout(() => {
      exportMdBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Export .md`;
    }, 1500);
  });
});