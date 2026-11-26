import { Message } from '../schema/canonical';

/** Describe captured files without claiming a provider has accepted their upload. */
export function formatAttachmentReferences(message: Pick<Message, 'attachments'>): string {
  if (!message.attachments?.length) return '';
  const lines = message.attachments.map((attachment) => {
    const name = attachment.name || 'unnamed file';
    if (attachment.kind === 'link') return `- [link] ${name}`;
    const availability = attachment.blobAlias !== undefined
      ? 'original captured separately; use the corresponding file if available in this chat'
      : 'original not captured; ask the user to upload it if needed';
    return `- [${attachment.kind}] ${name} (${availability})`;
  });
  return `Source attachments:\n${lines.join('\n')}\n`;
}
