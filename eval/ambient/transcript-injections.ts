/**
 * NexusMem text injected by one transcript attachment (harness-only). Claude Code 2.1.226 stores a
 * SessionStart digest as a string `content` but tool-event recall as a string array.
 */

export interface TranscriptAttachment {
  type?: string;
  hookName?: string;
  content?: unknown;
}

export function injectedText(attachment: TranscriptAttachment | undefined): string | null {
  if (!attachment?.type?.startsWith('hook')) return null;
  const { content } = attachment;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every((c) => typeof c === 'string')
        ? content.join('\n')
        : null;
  return text?.includes('NexusMem:') ? text : null;
}
