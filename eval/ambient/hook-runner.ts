import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs the hook commands `agent install` wrote, the way Claude Code runs them
 * (harness-only). Every probe is fail-closed: a hook that does not finish
 * successfully is reported as a failure, never as the silence a negative probe
 * is looking for.
 */

export interface InstalledSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
}

/** The command strings installed on one event, for a Bash tool call. */
export function installedCommands(settings: InstalledSettings, event: string): string[] {
  return (settings.hooks?.[event] ?? [])
    .filter((entry) => entry.matcher === undefined || new RegExp(`^(?:${entry.matcher})$`).test('Bash'))
    .flatMap((entry) => (entry.hooks ?? []).map((h) => h.command ?? ''))
    .filter(Boolean);
}

/** Git Bash on Windows, never the WSL `bash.exe` that PATH usually finds first there. */
export function hookShell(): string | null {
  if (process.platform !== 'win32') return 'bash';
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const candidate = join(execPath, '..', '..', '..', 'bin', 'bash.exe');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const shellPath = (p: string) => `"${p.split('\\').join('/')}"`;
const RECALL_COMMAND = /agent recall/;

/**
 * Each hook keeps its own PID and is waited for by that PID. A bare `wait`
 * returns 0 however its children exited, which let a crashed hook read as the
 * silence an EXIT:0 or dedup probe expects.
 */
function script(commands: readonly string[], input: string, outputs: readonly string[]): string {
  const launches = commands.map((c, i) => `${c} < ${shellPath(input)} > ${shellPath(outputs[i]!)} &\npids+=($!)`);
  return ['pids=()', ...launches, 'rc=0', 'for p in "${pids[@]}"; do wait "$p" || rc=1; done', 'exit $rc', ''].join('\n');
}

export interface HookRunOptions {
  /** A hook that never finishes must fail the probe rather than hang it. */
  timeoutMs?: number;
}

/**
 * Returns what the recall hook printed, or a string saying why this probe
 * proves nothing.
 */
export function runInstalledHooks(
  settings: InstalledSettings,
  event: string,
  payload: object,
  env: NodeJS.ProcessEnv,
  opts: HookRunOptions = {},
): { recall: string } | string {
  const shell = hookShell();
  if (!shell) return 'cannot locate the shell Claude Code runs hooks with';
  const commands = installedCommands(settings, event);
  if (commands.length === 0) return `no hooks are installed on ${event}`;
  const recallIndex = commands.findIndex((c) => RECALL_COMMAND.test(c));
  // No recall hook means no probe below can tell silence from absence.
  if (recallIndex < 0) return `no recall hook is installed on ${event}`;

  const scratch = mkdtempSync(join(tmpdir(), 'nexusmem-preflight-hook-'));
  try {
    const input = join(scratch, 'payload.json');
    writeFileSync(input, JSON.stringify(payload));
    const outputs = commands.map((_, i) => join(scratch, `out-${i}.txt`));
    const result = spawnSync(shell, ['-c', script(commands, input, outputs)], {
      env,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
    });
    if (result.status !== 0) {
      const how = result.signal ? `signal ${result.signal}` : `status ${String(result.status)}`;
      return `an installed ${event} hook did not finish successfully (${how}): ${result.stderr ?? ''}`.trim();
    }
    return { recall: readFileSync(outputs[recallIndex]!, 'utf8') };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
