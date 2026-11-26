import { CanonicalConversation } from '../schema/canonical';

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function messageSignature(message: CanonicalConversation['messages'][number]): string {
  const text = normalizeMessageText(message.content.map((block) => block.text).join('\n'));
  const attachmentKey = (message.attachments ?? []).map((attachment) => `${attachment.kind}:${attachment.url || attachment.name || attachment.id}`).join('|');
  return `${message.role}\u0000${text}\u0000${attachmentKey}`;
}

export function mergeMessageSegments(segments: CanonicalConversation['messages'][]): CanonicalConversation['messages'] {
  const combineAttachments = (target: CanonicalConversation['messages'][number], source: CanonicalConversation['messages'][number]) => {
    const attachments = [...(target.attachments ?? [])];
    for (const attachment of source.attachments ?? []) {
      const existing = attachments.find((item) => (item.url && item.url === attachment.url) ||
        (item.kind === attachment.kind && item.name === attachment.name && (!item.url || !attachment.url)));
      if (existing) existing.url ||= attachment.url;
      else attachments.push(attachment);
    }
    target.attachments = attachments;
  };
  const merged: CanonicalConversation['messages'] = [];

  const findContainedIndex = (segment: CanonicalConversation['messages']): number => {
    if (segment.length === 0 || segment.length > merged.length) return -1;
    const segmentKeys = segment.map(messageSignature);
    const mergedKeys = merged.map(messageSignature);

    for (let start = 0; start <= mergedKeys.length - segmentKeys.length; start += 1) {
      let matches = true;
      for (let i = 0; i < segmentKeys.length; i += 1) {
        if (mergedKeys[start + i] !== segmentKeys[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return start;
    }

    return -1;
  };

  for (const segment of segments) {
    if (segment.length === 0) continue;

    if (merged.length === 0) {
      merged.push(...segment);
      continue;
    }

    const containedIndex = findContainedIndex(segment);
    if (containedIndex >= 0) {
      segment.forEach((message, index) => combineAttachments(merged[containedIndex + index], message));
      continue;
    }

    const maxOverlap = Math.min(merged.length, segment.length);
    let overlap = 0;

    for (let size = maxOverlap; size > 0; size -= 1) {
      const mergedSlice = merged.slice(merged.length - size).map(messageSignature);
      const segmentSlice = segment.slice(0, size).map(messageSignature);
      if (mergedSlice.every((key, index) => key === segmentSlice[index])) {
        overlap = size;
        break;
      }
    }

    for (let index = 0; index < overlap; index += 1) {
      combineAttachments(merged[merged.length - overlap + index], segment[index]);
    }
    merged.push(...segment.slice(overlap));
  }

  return merged.map((message, index) => ({
    ...message,
    id: `msg-${index}`
  }));
}

