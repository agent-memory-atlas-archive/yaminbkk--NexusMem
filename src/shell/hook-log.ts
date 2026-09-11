import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact } from '../conversation/redact.js';
import { sha256Hex } from '../core/ids.js';

/**
 * One line of the opt-in hook log: a JSONL file the installed shell hook
 * appends to on every command. This is the high-quality tier -- exact
 * timestamp, cwd and exit code, none of which the scrape-based fallbacks can
 * offer.
 */
/** Which live hook wrote this line. Absent on lines predating this field -- the only hook that existed then was PowerShell's. */
export type HookShellKind = 'pwsh-hook' | 'bash-hook' | 'zsh-hook';

const HOOK_SHELL_KINDS: ReadonlySet<string> = new Set<HookShellKind>(['pwsh-hook', 'bash-hook', 'zsh-hook']);

export interface HookLogEntry {
  ts: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number | null;
  command: string;
  shell?: HookShellKind;
  /** sha256 prefix of the raw command, written when `sanitizeHookLog` redacted this line, so ids derived from it survive. */
  commandHash?: string;
}

/** A malformed line (typically a torn write from a crash mid-append) is skipped, not fatal. */
export function parseHookLogLine(line: string): HookLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== 'string' || typeof o.cwd !== 'string' || typeof o.command !== 'string') return null;
  const commandHash = typeof o.commandHash === 'string' && /^[0-9a-f]{12}$/.test(o.commandHash) ? o.commandHash : undefined;

  return {
    ...(commandHash ? { commandHash } : {}),
    ts: o.ts,
    cwd: o.cwd,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    command: o.command,
    shell: typeof o.shell === 'string' && HOOK_SHELL_KINDS.has(o.shell) ? (o.shell as HookShellKind) : undefined,
  };
}

export interface ReadHookLogResult {
  entries: HookLogEntry[];
  /** Total lines currently in the file -- the caller's next cursor. */
  totalLines: number;
  /**
   * Which live hooks have *ever* written to this file, across its full
   * content -- not just the lines returned in `entries`. A cursor-scoped
   * "did I just see a bash-hook line" would flicker true/false across
   * incremental syncs depending on whether bash ran a command since the last
   * one; this reflects the whole file, since the file already has to be read
   * and split in full regardless of `fromLine` (see below).
   */
  shellsSeen: ReadonlySet<HookShellKind>;
}

/**
 * Read lines appended since `fromLine`.
 *
 * `fromLine` beyond the file's current length means the file was rotated or
 * cleared out from under a stale cursor -- treated the same way a stale git
 * cursor is: fall back to reading everything, rather than silently skipping
 * history that is actually new.
 */
export async function readHookLog(path: string, fromLine: number): Promise<ReadHookLogResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { entries: [], totalLines: fromLine, shellsSeen: new Set() };
  }

  // The whole file is already read and split above regardless of `fromLine`,
  // so parsing every line here (not just the slice) to compute `shellsSeen`
  // costs no extra I/O -- only cheap, already-necessary JSON parsing.
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const allParsed = lines.map(parseHookLogLine);

  // A line with no `shell` field predates that field and is implicitly
  // PowerShell's -- the only hook that existed before it was added.
  const shellsSeen = new Set<HookShellKind>();
  for (const e of allParsed) if (e) shellsSeen.add(e.shell ?? 'pwsh-hook');

  const sliceStart = fromLine > 0 && fromLine <= lines.length ? fromLine : 0;
  const entries = allParsed.slice(sliceStart).filter((e): e is HookLogEntry => e !== null);

  return { entries, totalLines: lines.length, shellsSeen };
}

function sanitizeLine(line: string): { line: string; legacy: boolean } {
  if (line.trim().length === 0) return { line, legacy: false };
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { line: redact(line).text, legacy: false }; // a torn line is still text a secret can sit in
  }
  const o = obj as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.command !== 'string') return { line: redact(line).text, legacy: false };

  // The recorder stamps commandHash on every line it writes; a line without one came from an
  // older hook that appended the command raw. Stamping it here makes the next pass count only new ones.
  const legacy = typeof o.commandHash !== 'string';
  const raw = o.command;
  const { text } = redact(raw);
  if (!legacy && text === raw) return { line, legacy };
  const commandHash = legacy ? sha256Hex(raw).slice(0, 12) : o.commandHash;
  return { line: JSON.stringify({ ...o, command: text, commandHash }), legacy };
}

/** Line endings are kept byte-for-byte, so a log with nothing to change comes back identical. */
function sanitizeText(raw: string): { text: string; changed: number; legacy: number } {
  const parts = raw.split(/(\r?\n)/);
  let changed = 0;
  let legacy = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const next = sanitizeLine(parts[i]!);
    if (next.legacy) legacy += 1;
    if (next.line !== parts[i]) {
      parts[i] = next.line;
      changed += 1;
    }
  }
  return { text: parts.join(''), changed, legacy };
}

export interface SanitizeHookLogResult {
  linesChanged: number;
  /** Lines an outdated (pre-recorder) hook wrote raw since the last pass. */
  legacyLines: number;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, buf.length, start);
    return buf;
  } finally {
    await fh.close();
  }
}

const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Redact every command in the hook log in place. Current hooks write through
 * the recorder (shell/recorder.ts), which never persists a raw command; this
 * cleans up after hooks installed before it, and after pre-0.10.5 logs.
 * `sync` runs it after every read, `scrub-secrets` on demand. Line count and
 * order are preserved exactly -- every project's cursor into this shared log
 * is a line count. The temp file only ever holds already-redacted text.
 */
export async function sanitizeHookLog(path: string, opts: { dryRun?: boolean } = {}): Promise<SanitizeHookLogResult> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    return { linesChanged: 0, legacyLines: 0 };
  }
  const first = sanitizeText(raw.toString('utf8'));
  if (first.changed === 0 || opts.dryRun) return { linesChanged: first.changed, legacyLines: first.legacy };

  const tmp = `${path}.${process.pid}.scrub.tmp`;
  let linesChanged = first.changed;
  let legacyLines = first.legacy;
  try {
    await writeFile(tmp, first.text, { encoding: 'utf8', mode: 0o600 });
    let consumed = raw.length;
    for (let attempt = 0; ; attempt += 1) {
      // A shell may have appended meanwhile: carry those lines over, redacted, right before the swap.
      const size = (await stat(path)).size;
      if (size > consumed) {
        const extra = sanitizeText((await readRange(path, consumed, size)).toString('utf8'));
        await appendFile(tmp, extra.text, 'utf8');
        linesChanged += extra.changed;
        legacyLines += extra.legacy;
        consumed = size;
      }
      try {
        await rename(tmp, path);
        break;
      } catch (err) {
        // Windows refuses the swap while a shell holds the file open for its append.
        if (attempt >= 20 || !RENAME_BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { linesChanged, legacyLines };
}

/** Append one entry. Exposed for tests; the real writer is the shell recorder (shell/recorder.ts). */
export async function appendHookLogEntry(path: string, entry: HookLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
