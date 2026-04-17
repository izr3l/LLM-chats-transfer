export interface ContentBlock {
  type: 'text/markdown';
  text: string;
}

export interface AttachmentRef {
  id: string;
  kind: 'image' | 'file' | 'link';
  name?: string;
  url?: string;
  mimeType?: string;
  sourceHint?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  timestamp?: string;
  content: ContentBlock[];
  attachments?: AttachmentRef[];
}

export interface ConversationMetadata {
  id?: string;
  source: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  extensions?: Record<string, string>;
}

export interface CanonicalConversation {
  version: '1.0';
  metadata: ConversationMetadata;
  messages: Message[];
  integrity?: {
    messageCount: number;
    sha256?: string;
  };
}

/**
 * Runtime schema validator for CanonicalConversation.
 * Guards against malformed payloads from untrusted sources or corrupted decryption.
 */
export function isValidCanonicalConversation(value: unknown): value is CanonicalConversation {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  if (obj.version !== '1.0') return false;

  // Validate metadata
  if (!obj.metadata || typeof obj.metadata !== 'object') return false;
  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.source !== 'string' || meta.source.length === 0) return false;
  if (typeof meta.createdAt !== 'string') return false;

  // Validate messages array
  if (!Array.isArray(obj.messages)) return false;
  for (const msg of obj.messages) {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (typeof m.id !== 'string') return false;
    if (m.role !== 'user' && m.role !== 'assistant') return false;
    if (!Array.isArray(m.content)) return false;
    for (const block of m.content as unknown[]) {
      if (!block || typeof block !== 'object') return false;
      const b = block as Record<string, unknown>;
      if (b.type !== 'text/markdown') return false;
      if (typeof b.text !== 'string') return false;
    }
  }

  // Validate integrity if present
  if (obj.integrity !== undefined) {
    if (typeof obj.integrity !== 'object' || obj.integrity === null) return false;
    const integ = obj.integrity as Record<string, unknown>;
    if (typeof integ.messageCount !== 'number') return false;
  }

  return true;
}

/** Maximum allowed payload size in bytes (5 MB). */
export const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;