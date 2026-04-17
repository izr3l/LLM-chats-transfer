# LLM Chat Transfer Agent - Detailed Implementation Plan

## 1. Goal and Product Definition
Build a browser-extension-first product that lets a user transfer an existing chat from one LLM product to another (supporting Claude, ChatGPT, Gemini, Manus, Perplexity, and Grok) with prompt and response content preserved as faithfully as possible.

### Core promise
- Preserve user and assistant text content exactly (including markdown and code blocks).
- Preserve message order and role attribution.
- Preserve useful metadata (timestamps, source platform, conversation title where available).
- Allow the user to continue naturally from the last turn in the target model.

### Reality constraints to design around
- Most providers do not expose a native API to recreate historical messages inside their first-party UI thread.
- Exact preservation of hidden metadata (internal IDs, hidden system prompts, regeneration trees) is not guaranteed.
- UI-driven extraction/injection can break when provider DOM changes.

## 2. Success Metrics and Definition of Done

### Functional KPIs
- >= 98% character-level text fidelity for exported content (excluding provider-side normalization).
- 100% message order preservation for supported providers.
- <= 30 seconds transfer time for conversations up to 100 turns (single-shot mode).
- >= 95% successful transfer completion in test suite for supported provider versions.

### UX KPIs
- User completes transfer in <= 3 clicks after opening source chat.
- Clear warning and consent flow before any cross-provider transfer.
- User sees validation summary before sending to target.

### MVP done checklist
- Claude source adapter working for at least one stable UI version.
- ChatGPT target adapter working in single-shot continuation mode.
- Canonical schema and integrity hash implemented.
- End-to-end tests and manual test checklist passing.
- Privacy controls (local storage encryption and clear-data action) implemented.

## 3. Recommended Build Strategy
Use a phased approach with strict adapter boundaries so you can add providers without rewriting core logic.

### High-level architecture
1. Source adapter
   - Extracts conversation from source page.
2. Canonical transformer
   - Converts provider-specific data into one neutral schema.
3. Validation and integrity engine
   - Checks role order, content non-empty, hash consistency.
4. Target adapter
   - Sends normalized transcript into target provider.
5. UI and storage
   - User controls, preview, settings, encrypted local persistence.

## 4. Tech Stack and Project Setup

### Extension stack (recommended)
- Manifest V3 browser extension.
- TypeScript for all extension code.
- Build tool: Vite or esbuild.
- Validation: Zod or JSON Schema validator.
- Crypto: Web Crypto API (AES-GCM for local encryption).
- Test framework: Vitest/Jest + Playwright for browser integration.

### Suggested folder structure
- src/background/
  - orchestration, transfer workflows, storage service
- src/content/
  - source and target content scripts
- src/adapters/sources/
  - claude adapter and parser
- src/adapters/targets/
  - chatgpt injector and replay logic
- src/schema/
  - canonical types, validation rules
- src/ui/
  - popup, options, status panel
- src/security/
  - encryption, redaction
- tests/
  - unit, integration, fixtures
- docs/
  - provider compatibility notes and runbooks

## 5. Canonical Data Contract
Design this first. Everything else should depend on it.

### Required fields
- conversation metadata
  - id, source, title, createdAt, updatedAt
- messages array
  - id, role, timestamp, content blocks
- content block types
  - text/markdown, code block metadata, optional attachment references
- integrity
  - messageCount, content hash

### Important rules
- Preserve raw markdown where available.
- Never merge adjacent messages unless explicitly configured.
- Normalize line endings and whitespace in a predictable way before hashing.
- Keep source-specific metadata in an extensions object to avoid polluting core schema.

## 6. Source Adapter Plan (Claude First)

### Extraction order of preference
1. Official export/API if available and compliant.
2. Structured app-state extraction (if exposed in page data safely).
3. DOM parser fallback with stable selector strategy.

### Parser design
- Build parser stages:
  - detect conversation container
  - parse message nodes
  - map each node to role and content blocks
  - extract code blocks preserving fences and language labels
- Add confidence scoring:
  - score decreases when key selectors are missing or ambiguous
  - if below threshold, require manual user confirmation before transfer

### Robustness tactics
- Keep selector map versioned.
- Add visual fallback mode that highlights detected messages before transfer.
- Log non-sensitive parsing diagnostics locally for troubleshooting.

## 7. Target Adapter Plan (ChatGPT First)

### Mode A: Single-shot continuation (MVP default)
- Build a strict continuation payload:
  - clear rules to treat transcript as immutable context
  - include full ordered transcript
  - explicitly ask model to respond only to final user turn
- Inject payload into composer and optionally wait for user confirmation before send.

### Mode B: Step replay (post-MVP)
- Send messages one by one, role-tagged.
- Add delay and checkpointing between turns.
- Abort safely on interruption.

### Token limit handling
- Estimate token usage before injection.
- If over limit:
  - Option 1: chunk and summarize earlier segments with user approval.
  - Option 2: transfer only recent turns and attach full transcript for reference.
- Always show user what was omitted or condensed.

## 8. Transfer Workflow Orchestration

### End-to-end workflow
1. User clicks Capture from source tab.
2. Source adapter extracts raw conversation.
3. Transformer normalizes to canonical schema.
4. Validator checks schema and integrity.
5. User preview shown with warnings if needed.
6. User chooses target and transfer mode.
7. Target adapter injects/replays conversation.
8. Post-transfer verification summary displayed.

### Failure handling
- Parsing failed:
  - show actionable message and retry with fallback parser.
- Injection failed:
  - keep payload in clipboard-ready format.
- Provider changed UI:
  - mark adapter as degraded and block unsafe auto-send.

## 9. Security, Privacy, and Compliance Plan

### Security requirements
- Store transcripts encrypted at rest with AES-GCM.
- Never transmit data to your own server in MVP by default.
- Ask explicit user consent each transfer.
- Implement one-click wipe for local cache.

### Privacy controls
- Optional redaction before transfer:
  - email
  - phone
  - key-like strings
- Preview all redactions and allow user override.

### Compliance safeguards
- Review terms for each provider.
- Avoid credential scraping or hidden automation.
- Keep user in control for final send action.

## 10. Detailed Execution Phases

## Phase 0 - Discovery and Contracts (Week 1)
- Finalize product requirements and constraints.
- Define canonical schema and versioning policy.
- Create provider capability matrix (what can and cannot be preserved).
- Draft legal/compliance checklist for supported platforms.

Deliverables:
- Product requirements doc
- Canonical schema v1.0
- Provider compatibility matrix

## Phase 1 - Extension Skeleton and Core Services (Week 1-2)
- Set up MV3 extension with TypeScript build.
- Implement background service worker, popup UI shell, messaging bus.
- Implement storage abstraction and encryption helpers.
- Add logging framework with privacy-safe filtering.

Deliverables:
- Running extension skeleton
- Storage and crypto module
- Base adapter interfaces

## Phase 2 - Claude Source Adapter (Week 2-3)
- Implement parser with selector map and fallback strategy.
- Extract roles, markdown, code blocks, timestamps if available.
- Add parser confidence score and diagnostics.
- Create fixtures from real sample chats for regression tests.

Deliverables:
- Claude extractor v1
- Parser confidence and warning UI
- Adapter tests with fixtures

## Phase 3 - ChatGPT Target Adapter (Week 3)
- Implement single-shot payload builder.
- Implement composer injection with user confirmation gate.
- Add token estimation and overflow warning.
- Add transfer result summary panel.

Deliverables:
- ChatGPT injector v1
- Transfer summary and validation UI

## Phase 4 - End-to-End Transfer and Hardening (Week 4)
- Wire source extraction to target injection via canonical pipeline.
- Add integrity checks (hash, counts, role sequence).
- Implement retries and fallback clipboard mode.
- Add detailed error taxonomy and user-friendly troubleshooting.

Deliverables:
- End-to-end transfer pipeline
- Robust error handling and fallback flows

## Phase 5 - Testing and Release Candidate (Week 5)
- Run unit, integration, and manual QA suite.
- Validate on multiple browser versions and UI states.
- Perform privacy/security review.
- Ship RC build to internal users.

Deliverables:
- Test report
- Security review checklist
- Release candidate build

## 11. Testing Blueprint

### Unit tests
- Schema validation logic
- Hash and integrity functions
- Markdown/code block normalization
- Token estimation

### Integration tests
- Claude extraction with fixture snapshots
- ChatGPT payload injection with mocked DOM
- End-to-end flow with synthetic long conversations

### Manual tests
- Very long chats
- Multiple code blocks and tables
- Mixed language content
- Partial network failures
- Provider UI minor layout changes

### Regression strategy
- Store golden transcript fixtures.
- Diff canonical output across releases.
- Block release if fidelity drops below threshold.

## 12. Observability and Diagnostics

### What to log locally
- Adapter version
- extraction success or failure reason
- message count and size stats
- transfer mode used
- non-sensitive error codes

### What not to log
- raw message text by default
- credentials or auth tokens
- sensitive inferred PII

## 13. Risk Register and Mitigation

### Risk: Provider DOM changes
Mitigation:
- versioned selectors, fallback parser, quick patch pipeline

### Risk: Token overflow on target
Mitigation:
- pre-transfer estimate, chunking and explicit user choices

### Risk: Terms of service conflict
Mitigation:
- legal review and conservative interaction model

### Risk: User trust and privacy concerns
Mitigation:
- local-only default, transparent consent, easy data wipe

## 14. Team and Work Breakdown

### Suggested roles
- Extension engineer (core orchestration, UI)
- Adapter engineer (source/target integrations)
- QA engineer (fixture design and regression)
- Security reviewer (privacy model and crypto checks)

### Sprint cadence
- Weekly sprint with demo at end of week.
- Mid-week adapter stability review.
- Weekly fidelity metrics report.

## 15. Launch Plan

### Beta launch
- Start with invite-only users.
- Collect failure cases with opt-in diagnostics.
- Patch selector drift quickly.

### General availability gates
- Stable success rate across at least 2 recent UI versions per provider.
- Documented known limitations.
- Incident response playbook ready.

## 16. Immediate Next Actions (First 7 Days)
1. Create repository and extension skeleton.
2. Implement canonical schema and validator.
3. Build Claude parser prototype against 5 real chat fixtures.
4. Build ChatGPT single-shot injector prototype.
5. Complete first end-to-end transfer demo.
6. Record fidelity metrics and adjust normalization rules.

## 17. Practical Build Notes
- Start with single-shot mode because it is far more reliable than full replay.
- Keep adapters small and independent so provider breakage is isolated.
- Treat fidelity as a measurable engineering metric, not a subjective one.
- Build user trust with transparency: preview, warnings, and explicit send control.
