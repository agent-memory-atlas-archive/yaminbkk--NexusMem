import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact } from '../conversation/redact.js';
import { sha256Hex } from '../core/ids.js';

/**
 * The only writer of the shell hook log. A hook hands one raw command event
 * to this code over stdin; the raw command exists only in memory here --
 * hashed, then redacted -- and only the redacted line is ever persisted.
 */

const HOOK_SHELLS: ReadonlySet<string> = new Set(['pwsh-hook', 'bash-hook', 'zsh-hook']);

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The redacted hook-log line for one raw event, or null for anything malformed (which is then dropped, never written raw). */
export function toHookLogLine(rawEvent: string, shell: string): string | null {
  if (!HOOK_SHELLS.has(shell)) return null;
  let event: unknown;
  try {
    // Windows PowerShell's redirected stdin can append its encoding's BOM when the pipe is closed;
    // String#trim strips U+FEFF (ECMAScript whitespace), JSON.parse alone does not.
    event = JSON.parse(rawEvent.trim());
  } catch {
    // Deliberately swallowed: a JSON.parse error message quotes the input, i.e. the raw command.
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;
  if (typeof e.ts !== 'string' || typeof e.cwd !== 'string' || typeof e.command !== 'string' || e.command.trim() === '') return null;

  return JSON.stringify({
    ts: e.ts,
    cwd: e.cwd,
    exitCode: finiteOrNull(e.exitCode),
    durationMs: finiteOrNull(e.durationMs),
    command: redact(e.command).text,
    shell,
    // From the raw command, before redaction: the same hash hook node ids have always been derived from.
    commandHash: sha256Hex(e.command).slice(0, 12),
  });
}

/** Appends the redacted line in one write -- no temp file, so nothing raw can be left behind by a crash. */
export async function recordShellEvent(rawEvent: string, logPath: string, shell: string): Promise<boolean> {
  const line = toHookLogLine(rawEvent, shell);
  if (!line) return false;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}
