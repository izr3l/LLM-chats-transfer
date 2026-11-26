/** Shared feedback for popup and toolbar; staging a File does not confirm a provider upload. */
export interface InjectionResponse {
  status?: string;
  error?: string;
  warnings?: string[];
  attachmentResult?: {
    attempted: number;
    attached: number;
    missing: string[];
    failed: string[];
    method?: 'input' | 'drop';
  };
}

export function formatInjectionFeedback(base: string, response: InjectionResponse): string {
  const parts = [base];
  const result = response.attachmentResult;
  if (result?.attached) {
    parts.push(`${result.attached} original file${result.attached === 1 ? '' : 's'} added to the composer.`);
  }
  if (result?.missing?.length) {
    parts.push(`Originals unavailable: ${result.missing.join(', ')}. Re-upload these manually.`);
  }
  if (result?.failed?.length) {
    parts.push(`Files not added: ${result.failed.join(', ')}. Use the target upload control.`);
  }
  for (const warning of response.warnings ?? []) {
    if (warning && !parts.includes(warning)) parts.push(warning);
  }
  return parts.join(' ');
}
