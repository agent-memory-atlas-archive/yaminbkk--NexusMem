/**
 * NexusMem text injected by one transcript attachment (harness-only). Claude Code 2.1.226 stores a
 * SessionStart digest as a string `content` but tool-event recall as a string array.
 */

export interface TranscriptAttachment {
  type?: string;
  hookName?: string;
  content?: unknown;
  stdout?: unknown;
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

/**
 * The `additionalContext` of a JSON hook envelope. Older Claude Code builds
 * left `content` empty for tool-event recall and kept the envelope only in
 * `stdout`; reading `content` alone reported recall firing 0/9 when it had
 * fired in 2/9.
 */
function envelopeText(stdout: unknown): string | null {
  if (typeof stdout !== 'string') return null;
  try {
    const ctx = (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: unknown } }).hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' && ctx.includes('NexusMem:') ? ctx : null;
  } catch {
    return null;
  }
}

export interface TranscriptEntry {
  message?: { role?: string; content?: unknown };
  attachment?: TranscriptAttachment;
}

const sameInjection = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * Every NexusMem injection in a transcript, each counted once.
 *
 * One injection can be recorded in up to three places: an attachment's
 * `content`, the JSON envelope in an attachment's `stdout`, and user-role
 * text. `content` is read first. A `stdout` or text copy is kept only when it
 * does not repeat a `content` injection, and each `content` injection absorbs
 * at most one copy of each kind, so a recall that genuinely fired twice is
 * still counted twice. Text copies are cut at 1500 characters, so a copy
 * matches its original by prefix.
 */
export function collectInjections(entries: Iterable<TranscriptEntry>): string[] {
  const primary: string[] = [];
  const envelopes: string[] = [];
  const texts: string[] = [];
  for (const entry of entries) {
    const fromContent = injectedText(entry.attachment);
    if (fromContent) primary.push(fromContent);
    else if (entry.attachment?.type?.startsWith('hook')) {
      const fromStdout = envelopeText(entry.attachment.stdout);
      if (fromStdout) envelopes.push(fromStdout);
    }
    const content = entry.message?.content;
    if (entry.message?.role === 'assistant' || !Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== 'text') continue;
      for (const match of String(block.text ?? '').matchAll(/NexusMem:[\s\S]{0,1500}/g)) texts.push(match[0]);
    }
  }

  const out = [...primary];
  for (const copies of [envelopes, texts]) {
    const unclaimed = [...primary];
    for (const text of copies) {
      const i = unclaimed.findIndex((p) => sameInjection(p, text));
      if (i === -1) out.push(text);
      else unclaimed.splice(i, 1);
    }
  }
  return out;
}
