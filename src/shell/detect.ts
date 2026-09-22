import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { sha256Hex } from '../core/ids.js';
import { readHookLog, type HookLogEntry, type HookShellKind } from './hook-log.js';
import { parseBashHistory } from './parse-bash.js';
import { parsePsReadLineHistory } from './parse-psreadline.js';
import { parseZshHistory } from './parse-zsh.js';
import { bashHistoryPath, hookLogPath, psReadLineHistoryPath, zshHistoryPath } from './paths.js';
import type { RawShellEntry } from './types.js';

export interface ShellSourceResult {
  /** The `shell:<name>` suffix used for both MemoryNode.source and the sync_state key. */
  name: string;
  entries: RawShellEntry[];
  /** Hook source only: how far into the log this read reached, to persist as the next cursor. */
  cursorAfter?: string;
}

export interface CollectShellHistoryOptions {
  /** How many lines to keep from scrape-based (non-hook) sources. Default 300. */
  tailLines?: number;
  /** Repo root, for scoping hook-log entries to this project by cwd. */
  repoRoot?: string;
  /** Previous cursor for the hook log (a line count), or null to read from the start. */
  hookCursor?: string | null;
  /**
   * Once the hook is installed, its PowerShell coverage is authoritative --
   * the raw PSReadLine file duplicates the same commands with worse data
   * (no cwd, no exit code) and is skipped. Bash/zsh scraping is unaffected;
   * the hook only covers PowerShell. Default true.
   */
  preferHook?: boolean;
  /** Whose path rules decide which hook entries belong to `repoRoot`. Defaults to this host's. */
  platform?: NodeJS.Platform;
}

/**
 * One path in the form project admission decides on: lexically normalised by
 * the host's own path rules (`..` resolved, repeated separators collapsed), a
 * trailing separator dropped unless it is the filesystem root, and case folded
 * only on Windows, whose volumes fold it. A backslash is a separator only on
 * Windows; on POSIX it is an ordinary filename character. Nothing here touches
 * the filesystem -- the path may be historical or since deleted -- so symlinks
 * are not resolved.
 */
function forAdmission(path: string, platform: NodeJS.Platform): { text: string; sep: string } {
  const impl = platform === 'win32' ? win32 : posix;
  let text = impl.normalize(path);
  const root = impl.parse(text).root;
  if (text.length > root.length) text = text.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  return { text: platform === 'win32' ? text.toLowerCase() : text, sep: impl.sep };
}

/**
 * Whether an event at `cwd` belongs to the repository at `root`: the project
 * admission boundary for both the shell and the agent-event collector.
 *
 * It used to fold case and read every backslash as a separator everywhere, so
 * on a case-sensitive filesystem `/home/dev/Repo` was admitted into
 * `/home/dev/repo`'s history, and `/repo/src/../../other` passed as inside
 * `/repo`. Wrong admission puts another project's commands into this one's
 * recall and digest, while a missed event only costs a recall, so anything
 * whose identity cannot be proven from the path alone stays out: macOS is
 * compared case-sensitively though its volumes are usually not, and Git Bash
 * (`/c/...`) or WSL (`/mnt/c/...`) spellings never match a Windows root, as
 * before. `platform` is the host the hooks ran on, which is the host syncing.
 */
export function isUnderRoot(cwd: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = forAdmission(cwd, platform);
  const r = forAdmission(root, platform);
  if (c.text === r.text) return true;
  return c.text.startsWith(r.text.endsWith(r.sep) ? r.text : r.text + r.sep);
}

function hookEntryToRaw(e: HookLogEntry): RawShellEntry {
  // Lines predating the `shell` field are all PowerShell's -- it was the only hook that existed then.
  const shell = e.shell ?? 'pwsh-hook';
  // A line already redacted by sanitizeHookLog carries its raw command's hash, keeping the id stable.
  const commandHash = e.commandHash ?? sha256Hex(e.command).slice(0, 12);
  return {
    naturalKey: `${shell}:${e.ts}:${commandHash}`,
    commandHash,
    command: e.command,
    ts: e.ts,
    tsApprox: false,
    exitCode: e.exitCode,
    cwd: e.cwd,
    durationMs: e.durationMs,
    shell,
  };
}

async function tryReadScrapeSource(
  path: string,
  parse: (raw: string, mtimeMs: number, opts: { tailLines?: number }) => RawShellEntry[],
  tailLines: number,
): Promise<RawShellEntry[] | null> {
  if (!existsSync(path)) return null;
  const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return parse(raw, stats.mtimeMs, { tailLines });
}

export async function collectAvailableShellHistory(opts: CollectShellHistoryOptions = {}): Promise<ShellSourceResult[]> {
  const results: ShellSourceResult[] = [];
  const tailLines = opts.tailLines ?? 300;
  const preferHook = opts.preferHook ?? true;

  const hookPath = hookLogPath();
  const hookExists = existsSync(hookPath);

  // Whether *this shell's* live hook has ever produced a line, across the
  // log's whole history -- not just since the last cursor, since a shell
  // that hasn't run a command since the last sync would otherwise flicker
  // back to "not seen" and re-enable its raw-history scrape every other run.
  let shellsSeen: ReadonlySet<HookShellKind> = new Set();

  if (hookExists) {
    const fromLine = Number(opts.hookCursor ?? '0') || 0;
    const { entries, totalLines, shellsSeen: seen } = await readHookLog(hookPath, fromLine);
    shellsSeen = seen;
    const scoped = opts.repoRoot ? entries.filter((e) => isUnderRoot(e.cwd, opts.repoRoot!, opts.platform)) : entries;
    results.push({ name: 'pwsh-hook', entries: scoped.map(hookEntryToRaw), cursorAfter: String(totalLines) });
  }

  const skipPwshScrape = preferHook && shellsSeen.has('pwsh-hook');
  if (!skipPwshScrape && process.platform === 'win32') {
    const entries = await tryReadScrapeSource(psReadLineHistoryPath(), parsePsReadLineHistory, tailLines);
    if (entries) results.push({ name: 'pwsh', entries });
  }

  const skipBashScrape = preferHook && shellsSeen.has('bash-hook');
  if (!skipBashScrape) {
    const bashEntries = await tryReadScrapeSource(bashHistoryPath(), parseBashHistory, tailLines);
    if (bashEntries) results.push({ name: 'bash', entries: bashEntries });
  }

  const skipZshScrape = preferHook && shellsSeen.has('zsh-hook');
  if (!skipZshScrape) {
    const zshEntries = await tryReadScrapeSource(zshHistoryPath(), parseZshHistory, tailLines);
    if (zshEntries) results.push({ name: 'zsh', entries: zshEntries });
  }

  return results;
}
