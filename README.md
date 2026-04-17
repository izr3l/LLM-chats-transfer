# LLM Chat Transfer

LLM Chat Transfer is a powerful browser extension that enables you to extract your conversation history from one AI provider (like ChatGPT, Claude, or Gemini) seamlessly inject it into another or summarize it using Groq's high-performance LLM APIs, preserving message order, context, timestamps, and roles. This allows for frictionless context-switching between your favorite AI models!

## ✨ Features

- **Cross-Platform Transfer:** Extract and inject conversations across multiple top-tier AI targets.
- **Fidelity Preservation:** It captures conversation text, markdown, code blocks, timestamps, and roles using a normalized canonical schema.
- **AI Chat Summarization:** Automatically summarizes your copied chat using Groq's high-performance LLM APIs, providing quick context overviews before you switch providers.
- **Privacy First:** Chat histories are transferred completely locally. Captured chat states are securely encrypted at-rest in Chrome's local storage (AES-GCM encryption).
- **History Viewer:** Easy-to-use clipboard interface within the extension to store multiple chats, switch between them, summarize, export, or delete.

## 🔗 Supported Platforms

The extension works on and supports extraction/injection for most primary AI interfaces including:
- ChatGPT (`chatgpt.com`)
- Claude (`claude.ai`)
- Google Gemini (`gemini.google.com`)
- Manus (`manus.im`, `manus.com`, `manus.ai`, `manus.computer`)
- Qwen (`chat.qwen.ai`, `qwen.ai`, `qwenlm.ai`)
- Perplexity (`perplexity.ai`)
- Grok / X (`x.com`)

## 🛠️ Prerequisites

To build and run this extension locally you need:
- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- A Chromium-based browser (Chrome, Edge, Brave, etc.)
- A [Groq API Key](https://console.groq.com/keys) if you wish to use the AI Summarization feature.

## 🚀 Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/your-username/chat-transfer.git
   cd chat-transfer
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

## 🔌 Load Unpacked Extension

1. Open your Chromium-based browser and navigate to the Extensions page (for Chrome, visit `chrome://extensions`).
2. Toggle on **Developer mode** in the top right corner.
3. Click the **Load unpacked** button.
4. Select the initialized `dist` folder located in your `chat-transfer` directory.

## 📖 How to Use

1. **Extract Context**: Open an interface containing your LLM chat (e.g., Claude), open the extension using the puzzle-piece icon, and click **Capture Chat**.
2. **Review/Summarize**: The dialog will notify you that your chat has been copied. A summary will automatically run in the background. You can click the top-right summarize icon to generate an automated markdown summary of your chat.
3. **Inject Context**: Open your target AI conversation interface (e.g., ChatGPT), click the extension icon, review your preview content, and click **Paste to Target Model**.
4. **Manage History**: You can review old captured conversations stored below the capture buttons!

## 🛡️ Security Notes

- This extension actively secures pending transfer data by utilizing Web Crypto AES-GCM local storage encryption preventing other script access.
- Validates the hostname origin preventing side-channel cross-site injection attacks.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! If you plan to implement new Provider Adapters:
1. Try parsing directly via DOM selector layouts in `src/content/source.ts`.
2. Map it cleanly into the Universal Canonical Types located inside `src/schema/canonical.ts`.
3. Add the supported origin domain mapping into `src/background/index.ts`!

## 📄 License

This project is licensed under the [ISC License](LICENSE).
