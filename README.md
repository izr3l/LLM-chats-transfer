# LLM Chat Transfer

LLM Chat Transfer is a powerful browser extension that enables you to extract your conversation history from one AI provider (like ChatGPT, Claude, or Gemini) seamlessly inject it into another or summarize it using Groq's high-performance LLM APIs, preserving message order, context, timestamps, and roles. This allows for frictionless context-switching between your favorite AI models!

## Features

- **Cross-Platform Transfer:** Extract and inject conversations across multiple top-tier AI targets.
- **Fidelity Preservation:** It captures conversation text, markdown, code blocks, timestamps, and roles using a normalized canonical schema.
- **Attachment Transfer:** Captures accessible original files (images, PDFs, documents, etc.) into IndexedDB and adds them to the destination composer alongside the transcript. Files unavailable from the source or unsupported by the destination are reported by name.
- **AI Chat Summarization:** Automatically summarizes your copied chat using Groq's high-performance LLM APIs, providing quick context overviews before you switch providers.
- **Multiple Paste Modes:** Choose how to inject your captured chat — paste inline (with system framing), paste raw (plain text), or attach as a PDF, TXT, or DOC file.
- **Download Formats:** Export any captured chat as TXT, Markdown, Word (.doc), or PDF — all generated client-side with zero external dependencies.
- **Privacy First:** Chat histories are transferred completely locally. Captured chat states are securely encrypted at-rest in Chrome's local storage (AES-GCM encryption). Attachment blobs are stored in IndexedDB, isolated per-extension.
- **In-Page Toolbar:** A floating toolbar (Shadow DOM isolated) appears on all supported provider pages with quick access to capture, paste, summarize, download, and history.
- **History Viewer:** Easy-to-use clipboard interface within the extension to store multiple chats, switch between them, summarize, export, or delete.

## Supported Platforms

The extension works on and supports extraction/injection for most primary AI interfaces including:
- ChatGPT (`chatgpt.com`)
- Claude (`claude.ai`)
- Google Gemini (`gemini.google.com`)
- Manus (`manus.im`, `manus.com`, `manus.ai`, `manus.computer`)
- Qwen (`chat.qwen.ai`, `qwen.ai`, `qwenlm.ai`)
- Perplexity (`perplexity.ai`)
- Grok / X (`x.com`)

## Prerequisites

To build and run this extension locally you need:
- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- A Chromium-based browser (Chrome, Edge, Brave, etc.)
- A [Groq API Key](https://console.groq.com/keys) if you wish to use the AI Summarization feature.

## Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/izr3l/LLM-chats-transfer.git
   cd LLM-chats-transfer
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup (For Summarization):**
   Copy the example `.env` file to set up your environment variables locally.
   ```bash
   cp .env.example .env.local
   ```
   Open `.env.local` and substitute your actual Groq API key:
   ```env
   GROQ_API_KEY=your_actual_api_key_here
   ```

4. **Build the Extension:**
   ```bash
   npm run build
   ```
   *This process runs Webpack, transpiles the TypeScript, bundles the assets, and dumps the final, ready-to-use extension into the `dist/` directory.*

## Load Unpacked Extension

1. Open your Chromium-based browser and navigate to the Extensions page (for Chrome, visit `chrome://extensions`).
2. Toggle on **Developer mode** in the top right corner.
3. Click the **Load unpacked** button.
4. Select the initialized `dist` folder located in your `chat-transfer` directory.

## How to Use

1. **Capture Chat**: Open an interface containing your LLM chat (e.g., Claude), open the extension using the popup or the in-page floating toolbar, and click **Capture**. The extension extracts messages, detects file attachments, downloads them, and stores everything locally.
2. **Review/Summarize**: A summary automatically runs in the background after capture. Click the summarize icon (✨) to view it, or use Re-summarize to force a fresh summary.
3. **Download**: Click the download button to export the captured chat as TXT, Markdown, Word (.doc), or PDF.
4. **Paste to Target**: Open your target AI conversation (e.g., ChatGPT), click **Paste**, and choose a mode:
   - **Paste Inline** — Injects the full conversation with system framing
   - **Paste Raw** — Injects plain message text without framing
   - **Attach as PDF / TXT / DOC** — Generates a file and attaches it to the chat input
5. **File Attachments**: Accessible original files are saved with the capture and added to the destination composer in every paste mode. If a file appears under **Missing files**, select **Add file** and choose your local copy. The file is saved with that chat in History and included on future pastes. Review the destination's file chips and wait for uploads to finish before pressing Send.
6. **Manage History**: Review old captured conversations in the history drawer. Load, download, or delete previous captures.

### How Attachment Capture Works

When you capture a chat, the extension:
1. Extracts attachment references from the loaded conversation (images, file chips, download links). Hidden attachment URLs are matched conservatively by exact filename; unrelated assets are excluded.
2. Downloads available original bytes through the authenticated source page, with a background download fallback. Inline image data and same-origin blob URLs are supported.
3. Saves the transcript and validated file data together, linked by a stable transfer ID that also survives loading from history.
4. Adds the saved originals through the destination file input or a handled drop event. When the transcript itself is a PDF, TXT, or DOC, it and the originals are added in one batch.
5. Reports files that could not be captured or added. A filename or rendered preview alone is insufficient to recover an original PDF, image, or document; the extension never substitutes preview text for the original binary.

Provider interfaces, permissions, file type restrictions, and upload limits still apply. A successful file handoff means the files were supplied to the composer; check the destination's upload state before sending. Conversations captured by older versions may need recapturing to recover missing file links. Transcript exports contain attachment references, with original files stored separately.

For **Claude → ChatGPT**, capture the Claude chat and then use Paste in ChatGPT. Claude files that expose a downloadable original can transfer automatically. If Claude only shows a preview, open the saved capture and select **Add file** beside the filename if you have the original on your computer.

### Verify a transfer

Build with `npm run build`, reload the unpacked extension, and refresh both provider tabs. Capture a conversation containing an image and PDF, check the saved file count, then paste into the destination and review the filenames and upload state. Try both inline paste and a transcript-as-file mode. Finally load the capture from History and repeat the paste to confirm its original files remain available.

Development checks: `npm test`, `npm run typecheck`, and `npm run build`.

## Security Notes

- This extension actively secures pending transfer data by utilizing Web Crypto AES-GCM local storage encryption preventing other script access.
- Validates the hostname origin preventing side-channel cross-site injection attacks.
- Attachment downloads are restricted to a strict host allowlist (e.g., `oaiusercontent.com`, `claude.ai`, `googleapis.com`) to prevent exfiltration.
- Individual attachment size capped at 25 MB; total per-transfer capped at 200 MB.
- IndexedDB storage is isolated per-extension by the browser sandbox.

## Architecture

```
src/
├── adapters/
│   ├── sources/       # Per-provider DOM extraction (Claude, ChatGPT, Manus, fallback)
│   └── targets/       # Per-provider prompt injection (ChatGPT, Manus, fallback)
├── background/
│   ├── index.ts       # Service worker: encryption, storage, AI summarization, message routing
│   └── attachmentStore.ts  # IndexedDB CRUD for captured file blobs
├── content/
│   ├── source.ts      # Content script: extraction + attachment download orchestration
│   ├── target.ts      # Content script: injection + file reattachment
│   └── toolbar.ts     # In-page floating toolbar (Shadow DOM)
├── schema/
│   └── canonical.ts   # Universal conversation schema, AttachmentRef, AttachmentBlob
└── ui/
    ├── popup.html      # Extension popup UI
    └── popup.ts        # Popup logic: capture, paste, history, download, settings
```

## Contributing

Contributions, issues, and feature requests are welcome! If you plan to implement new Provider Adapters:
1. Try parsing directly via DOM selector layouts in `src/content/source.ts`.
2. Map it cleanly into the Universal Canonical Types located inside `src/schema/canonical.ts`.
3. Add the supported origin domain mapping into `src/background/index.ts`.
4. For attachment capture, add the provider's file-hosting domains to the allowlist in the `DOWNLOAD_ATTACHMENT_URL` handler.
