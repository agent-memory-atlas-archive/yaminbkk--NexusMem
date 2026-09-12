import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHookCommands } from '../src/agent/hook-command.js';
import { readAgentEvents } from '../src/agent/record.js';

/**
 * Runs the command `nexusmem agent install` writes through a real shell.
 *
 * This is the check that unit tests cannot make: a hook command is a string a
 * shell parses, and a Windows backslash path in it dies there silently -- the
 * bug that made the first end-to-end run capture nothing. Anything that only
 * asserts the generated string proves nothing about the shell that runs it.
 *
 * POSIX runs it through `sh`, which is what Claude Code uses on Linux and
 * macOS; on Windows the same string goes through Git Bash, which is what it
 * uses there. A machine without the relevant shell skips rather than pretends.
 */

const HOOK = resolve('dist/cli/agent-hook.js'); // built by tests/global-setup.ts
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SECRET = 'shell-s3cret-VALUE';
const RAW = `psql postgres://app:${SECRET}@db/app`;

const shell = process.platform === 'win32' ? (existsSync(GIT_BASH) ? GIT_BASH : null) : '/bin/sh';
const toPosix = (path: string) => path.replace(/\\/g, '/');

let home: string;
let logPath: string;
let payloadPath: string;

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'shell-1',
    cwd: 'D:/repo',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: RAW },
    tool_use_id: 'toolu_shell',
    error: 'Exit code 1\nFATAL: authentication failed',
    duration_ms: 12,
    ...over,
  });

/** Feeds the payload on stdin exactly as a hook does: the command never sees it as an argument. */
function runThroughShell(command: string, log: string): { status: number | null; stdout: string; stderr: string } {
  const script = `cat '${toPosix(payloadPath)}' | ${command} --log '${toPosix(log)}'`;
  const result = spawnSync(shell as string, ['-c', script], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-shellhook-')));
  logPath = join(home, 'agent-events.jsonl');
  payloadPath = join(home, 'payload.json');
  writeFileSync(payloadPath, payload());
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(shell === null)('the installed hook command, run by a real shell', () => {
  it('captures the event, writing only the redacted command', () => {
    const { capture } = agentHookCommands(process.execPath, HOOK);

    const result = runThroughShell(capture, logPath);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).toContain('[redacted]');
    expect(raw).not.toContain(SECRET);
  });

  it('survives spaces in the node and script paths', async () => {
    const spaced = join(home, 'nexus mem', 'dist', 'cli');
    mkdirSync(spaced, { recursive: true });
    const spacedHook = join(spaced, 'agent-hook.js');
    copyFileSync(HOOK, spacedHook);

    const { capture } = agentHookCommands(process.execPath, spacedHook);
    expect(runThroughShell(capture, join(home, 'spaced.jsonl')).status).toBe(0);

    const { events } = await readAgentEvents(join(home, 'spaced.jsonl'), 0);
    expect(events).toHaveLength(1);
  });

  it('survives shell metacharacters in the script path', async () => {
    // `$` and a backquote are legal in a filename on both Windows and POSIX,
    // and a double-quoted path is not protection from either: an unescaped one
    // installed a hook that the shell mangled into a path that does not exist.
    const odd = join(home, 'pa$id', '`x`');
    mkdirSync(odd, { recursive: true });
    const oddHook = join(odd, 'agent-hook.js');
    copyFileSync(HOOK, oddHook);

    const { capture } = agentHookCommands(process.execPath, oddHook);
    const log = join(home, 'odd.jsonl');
    const result = runThroughShell(capture, log);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const { events } = await readAgentEvents(log, 0);
    expect(events).toHaveLength(1);
  });

  it('writes the payload nowhere in the command line: stdin is the only transport', () => {
    const { capture } = agentHookCommands(process.execPath, HOOK);

    expect(capture).not.toContain(SECRET);
    expect(capture).not.toContain('tool_input');
    // Forward slashes only: a backslash path is what dies in a shell.
    expect(capture).not.toContain('\\');
  });

  it('stays silent and non-blocking on a payload it cannot use', () => {
    writeFileSync(payloadPath, '{ not json');
    const { capture } = agentHookCommands(process.execPath, HOOK);

    const result = runThroughShell(capture, logPath);

    // Never exit 2: that is the only code that would block the agent's tool call.
    expect(result.status).not.toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(existsSync(logPath)).toBe(false);
  });

  it('resolves node by absolute path rather than trusting PATH', () => {
    const { capture, recall, sessionStart } = agentHookCommands(process.execPath, HOOK);

    for (const command of [capture, recall, sessionStart]) {
      expect(command.startsWith(`"${toPosix(process.execPath)}"`)).toBe(true);
    }
  });
});
