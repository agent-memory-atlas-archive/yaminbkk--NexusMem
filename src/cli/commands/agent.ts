import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import { readCaptureStatus } from '../../agent/capture-health.js';
import { agentHookCommands } from '../../agent/hook-command.js';
import { recallFailure, recallSessionStart } from '../../agent/recall.js';
import { markInjected, shouldInject } from '../../agent/recall-state.js';
import {
  agentHookStatus,
  type ClaudeSettings,
  removeAgentHooks,
  upsertAgentHooks,
} from '../../adapters/claude-code/install.js';
import { parseHookPayload, parseSessionStart } from '../../adapters/claude-code/payload.js';
import { readConfig, resolveWorkspace } from '../../config/workspace.js';
import { readRepoInfo } from '../../git/repo.js';
import { MemoryStore } from '../../store/store.js';

/**
 * `nexusmem agent ...` -- the Claude Code adapter's user-facing surface.
 *
 * `recall` is the one command an agent runs, not a person: it reads a hook
 * payload on stdin and prints the injection Claude Code understands. Every
 * failure path in it is silent and exits 0, because a memory lookup must
 * never interrupt the agent that is waiting on it.
 */

export type AgentSettingsScope = 'user' | 'project';

export interface AgentCommandOptions {
  cwd: string;
  scope?: AgentSettingsScope;
  out?: (chunk: string) => void;
}

export function settingsPathFor(scope: AgentSettingsScope, cwd: string): string {
  // Project scope uses settings.local.json: a committed settings.json would
  // install NexusMem hooks on every teammate's machine without asking them.
  return scope === 'project' ? join(cwd, '.claude', 'settings.local.json') : join(homedir(), '.claude', 'settings.json');
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as ClaudeSettings) : {};
  } catch {
    return {};
  }
}

async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export async function runAgentInstall(opts: AgentCommandOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const scope = opts.scope ?? 'user';
  const path = settingsPathFor(scope, opts.cwd);
  const existing = existsSync(path);

  const settings = await readSettings(path);
  if (existing && Object.keys(settings).length === 0) {
    out(`${pc.red('refused')} ${path} exists but could not be parsed as JSON -- fix or move it first\n`);
    return 1;
  }

  await writeSettings(path, upsertAgentHooks(settings, agentHookCommands()));
  out(
    [
      `${pc.green('installed')} NexusMem agent hooks in ${path}`,
      `  ${pc.dim('captures')} commands and edits Claude Code makes, redacted, into this machine's agent log`,
      `  ${pc.dim('recalls')}  past failures of the same command, at the moment one fails again`,
      `  ${pc.dim('restart Claude Code for the hooks to take effect')}`,
      '',
    ].join('\n'),
  );
  return 0;
}

export async function runAgentRemove(opts: AgentCommandOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const path = settingsPathFor(opts.scope ?? 'user', opts.cwd);
  const { settings, removed } = removeAgentHooks(await readSettings(path));

  if (removed === 0) {
    out(`${pc.dim('nothing to remove')} no NexusMem agent hooks in ${path}\n`);
    return 0;
  }
  await writeSettings(path, settings);
  out(`${pc.green('removed')} ${removed} NexusMem hook(s) from ${path}\n`);
  return 0;
}

export async function runAgentStatus(opts: AgentCommandOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const scope = opts.scope ?? 'user';
  const path = settingsPathFor(scope, opts.cwd);
  const status = agentHookStatus(await readSettings(path), agentHookCommands());

  // Configuration and evidence are different questions: hooks can be installed
  // and recording nothing, which is the failure this reports.
  const capture = readCaptureStatus();
  // Wording stays within the evidence: silence is reported as silence, not as
  // a diagnosis, because nothing here can tell an idle week from a break.
  const CAPTURE_LABEL: Record<typeof capture.health, string> = {
    healthy: pc.green('healthy') + pc.dim(' -- an event was captured in the last 24h'),
    stale: pc.yellow('stale') + pc.dim(' -- nothing captured in the last 24h, which is expected if no agent ran'),
    degraded: pc.yellow('degraded') + pc.dim(' -- recent events were dropped, so some agent activity may be missing'),
    'never-observed': pc.yellow('never observed') + pc.dim(' -- no event has been captured yet'),
    unknown: pc.yellow('unknown') + pc.dim(' -- the event log could not be read'),
  };

  out(
    [
      `${pc.dim('settings  ')} ${path}`,
      `${pc.dim('installed ')} ${
        !status.installed
          ? pc.yellow('no')
          : status.upToDate
            ? pc.green('yes')
            : pc.yellow('yes, but pointing at a different NexusMem -- run `nexusmem agent install` again')
      }`,
      `${pc.dim('capture   ')} ${CAPTURE_LABEL[capture.health]}`,
      ...(capture.lastEventAt
        ? [`${pc.dim('last event')} ${capture.lastEventAt} ${pc.dim(`(${capture.lastEventKind}, ${capture.lastEventOutcome})`)}`]
        : []),
      // Only when it happened: a healthy install should print nothing about drops.
      ...(capture.drops > 0
        ? [
            `${pc.dim('drops     ')} ${capture.drops} ${pc.dim(
              `(last: ${capture.lastDropReason ?? 'unrecognised'} from ${capture.lastDropFamily ?? 'unrecognised'} at ${capture.lastDropAt})`,
            )}`,
          ]
        : []),
      '',
    ].join('\n'),
  );
  return 0;
}

export interface AgentSessionStartOptions {
  input?: string;
  out?: (chunk: string) => void;
  /** Overridable so a test never spawns a real background sync. */
  startSync?: (repoRoot: string) => void;
}

/**
 * Detached and unwaited: this is the "sync at session start" step the user
 * previously had to remember, and the session must not wait on it.
 */
function spawnBackgroundSync(repoRoot: string): void {
  const cli = process.argv[1];
  if (!cli) return;
  spawn(process.execPath, [cli, 'sync', '--auto', '--quiet', '-C', repoRoot], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

/**
 * Opens a session: kicks off the sync, then says something only if this
 * repository has failures nothing has fixed. Silent otherwise, and silent on
 * every error, like recall.
 */
export async function runAgentSessionStart(opts: AgentSessionStartOptions = {}): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  try {
    const payload = parseSessionStart(opts.input ?? (await readStdin()));
    if (!payload) return 0;

    const repo = await readRepoInfo(payload.cwd);
    const ws = resolveWorkspace(repo.root);
    if (!existsSync(ws.dbPath) || !existsSync(ws.configPath)) return 0;

    (opts.startSync ?? spawnBackgroundSync)(repo.root);

    const { projectId } = await readConfig(ws);
    const store = MemoryStore.open(ws.dbPath);
    let digest: ReturnType<typeof recallSessionStart>;
    try {
      digest = recallSessionStart(store, projectId);
    } finally {
      store.close();
    }
    if (!digest) return 0;

    // Plain stdout, not JSON: that is the injection form the live probe verified for SessionStart.
    out(`${digest.text}\n`);
    return 0;
  } catch {
    return 0;
  }
}

export interface AgentRecallOptions {
  /** The hook payload. Read from stdin when absent. */
  input?: string;
  out?: (chunk: string) => void;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Always exits 0 and prints nothing unless there is something worth saying.
 * An agent blocked, or fed an error message, by its own memory lookup would
 * be worse than having no memory at all.
 */
export async function runAgentRecall(opts: AgentRecallOptions = {}): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  try {
    const raw = opts.input ?? (await readStdin());
    const event = parseHookPayload(raw, new Date().toISOString());
    if (!event || event.kind !== 'command' || event.outcome !== 'fail' || !event.commandHash || !event.cwd) return 0;
    if (!shouldInject(event.sessionId, event.commandHash)) return 0;

    const repo = await readRepoInfo(event.cwd);
    const ws = resolveWorkspace(repo.root);
    // Not initialized for this repo: nothing to recall, and nothing to create here either.
    if (!existsSync(ws.dbPath) || !existsSync(ws.configPath)) return 0;
    const { projectId } = await readConfig(ws);

    const store = MemoryStore.open(ws.dbPath);
    let recall: ReturnType<typeof recallFailure>;
    try {
      recall = recallFailure(store, projectId, event.commandHash);
    } finally {
      store.close();
    }
    if (!recall) return 0;

    markInjected(event.sessionId, event.commandHash);
    out(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: recall.text },
      })}\n`,
    );
    return 0;
  } catch {
    // Every failure is silent by design: no database, no repository, a shape
    // change in the payload -- the agent carries on as if NexusMem were absent.
    return 0;
  }
}
