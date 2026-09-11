import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureDropStatePath, recordCaptureDrop } from '../src/agent/capture-health.js';
import { agentEventLogPath } from '../src/agent/paths.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { type AgentHookCommands, agentHookCommands } from '../src/agent/hook-command.js';
import {
  agentHookStatus,
  type ClaudeSettings,
  removeAgentHooks,
  upsertAgentHooks,
} from '../src/adapters/claude-code/install.js';
import {
  runAgentInstall,
  runAgentRecall,
  runAgentRemove,
  runAgentSessionStart,
  runAgentStatus,
  settingsPathFor,
} from '../src/cli/commands/agent.js';
import { runInit } from '../src/cli/commands/init.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { readConfig, resolveWorkspace } from '../src/config/workspace.js';
import { sha256Hex } from '../src/core/ids.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

const COMMANDS: AgentHookCommands = {
  capture: 'node /nm/dist/cli/agent-hook.js',
  recall: 'node /nm/dist/cli/index.js agent recall --trigger failure',
  sessionStart: 'node /nm/dist/cli/index.js agent session-start',
};
const OLD_COMMANDS: AgentHookCommands = {
  capture: 'node /old/agent-hook.js',
  recall: 'node /old/index.js agent recall',
  sessionStart: 'node /old/index.js agent session-start',
};
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /other/tool.js' }] };

describe('settings upsert', () => {
  it('installs a capture hook on both events and a recall hook on failures', () => {
    const settings = upsertAgentHooks({}, COMMANDS);

    expect(Object.keys(settings.hooks ?? {})).toEqual(['SessionStart', 'PostToolUse', 'PostToolUseFailure']);
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(COMMANDS.sessionStart);
    // No matcher on SessionStart: startup, resume, clear and compact all want the same treatment.
    expect(settings.hooks?.SessionStart?.[0]?.matcher).toBeUndefined();
    expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(COMMANDS.capture);
    const failure = settings.hooks?.PostToolUseFailure ?? [];
    expect(failure.flatMap((e) => e.hooks ?? []).map((h) => h.command)).toEqual([COMMANDS.capture, COMMANDS.recall]);
    // Recall runs before the agent sees its failure, so it carries a short timeout.
    expect(failure[1]?.hooks?.[0]?.timeout).toBe(5);
  });

  it('is idempotent: installing twice leaves exactly one copy', () => {
    const once = upsertAgentHooks({}, COMMANDS);
    expect(upsertAgentHooks(once, COMMANDS)).toEqual(once);
  });

  it('updates in place when the NexusMem path changed, without stacking a second copy', () => {
    const old = upsertAgentHooks({}, OLD_COMMANDS);
    const next = upsertAgentHooks(old, COMMANDS);

    const commands = (next.hooks?.PostToolUseFailure ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([COMMANDS.capture, COMMANDS.recall]);
  });

  it("never disturbs another tool's hooks, on install or on remove", () => {
    const before: ClaudeSettings = { theme: 'dark', hooks: { PostToolUse: [FOREIGN], SessionStart: [FOREIGN] } };

    const installed = upsertAgentHooks(before, COMMANDS);
    expect(installed.hooks?.PostToolUse?.[0]).toEqual(FOREIGN);
    expect(installed.theme).toBe('dark');

    const { settings, removed } = removeAgentHooks(installed);
    // capture on two events, plus recall, plus session-start.
    expect(removed).toBe(4);
    expect(settings).toEqual(before);
  });

  it('drops an empty hooks object it did not create', () => {
    const { settings } = removeAgentHooks(upsertAgentHooks({ theme: 'dark' }, COMMANDS));
    expect(settings).toEqual({ theme: 'dark' });
  });

  it('reports status, including a block pointing at a different install', () => {
    expect(agentHookStatus({}, COMMANDS)).toEqual({ installed: false, upToDate: false });
    expect(agentHookStatus(upsertAgentHooks({}, COMMANDS), COMMANDS)).toEqual({ installed: true, upToDate: true });

    expect(agentHookStatus(upsertAgentHooks({}, OLD_COMMANDS), COMMANDS)).toEqual({ installed: true, upToDate: false });
  });
});

describe('hook command', () => {
  it('always uses quoted forward-slash paths: a backslash path dies in the shell that runs hooks', () => {
    const commands = agentHookCommands('C:\\Program Files\\nodejs\\node.exe', 'D:\\nm\\dist\\cli\\agent-hook.js', 'D:\\nm\\dist\\cli\\index.js');

    expect(commands.capture).toBe('"C:/Program Files/nodejs/node.exe" "D:/nm/dist/cli/agent-hook.js"');
    expect(commands.recall).toBe('"C:/Program Files/nodejs/node.exe" "D:/nm/dist/cli/index.js" agent recall --trigger failure');
    expect(commands.capture + commands.recall).not.toContain('\\');
  });
});

describe('nexusmem agent (CLI)', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-agent-cli-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes project scope to settings.local.json, never to a file the team would commit', async () => {
    const out: string[] = [];
    expect(await runAgentInstall({ cwd: dir, scope: 'project', out: (c) => out.push(c) })).toBe(0);

    const path = join(dir, '.claude', 'settings.local.json');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks.PostToolUseFailure).toHaveLength(2);
    expect(out.join('')).toContain('restart Claude Code');
  });

  it('defaults to the user settings file', () => {
    expect(settingsPathFor('user', dir)).toBe(join(homedir(), '.claude', 'settings.json'));
  });

  it('refuses to touch a settings file it cannot parse, rather than overwriting it', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const path = join(dir, '.claude', 'settings.local.json');
    writeFileSync(path, '{ this is not json');

    const out: string[] = [];
    expect(await runAgentInstall({ cwd: dir, scope: 'project', out: (c) => out.push(c) })).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
    expect(out.join('')).toContain('refused');
  });

  it('round-trips install, status and remove', async () => {
    await runAgentInstall({ cwd: dir, scope: 'project', out: () => {} });

    const installed: string[] = [];
    await runAgentStatus({ cwd: dir, scope: 'project', out: (c) => installed.push(c) });
    expect(installed.join('')).toMatch(/installed\s+yes/);

    const removed: string[] = [];
    await runAgentRemove({ cwd: dir, scope: 'project', out: (c) => removed.push(c) });
    expect(removed.join('')).toContain('removed 4');

    const after: string[] = [];
    await runAgentStatus({ cwd: dir, scope: 'project', out: (c) => after.push(c) });
    expect(after.join('')).toMatch(/installed\s+no/);
  });

  describe('status reports capture evidence, not just configuration', () => {
    // Both live under this file's isolated NEXUSMEM_HOME and outlive a single test.
    beforeEach(() => {
      rmSync(agentEventLogPath(), { force: true });
      rmSync(captureDropStatePath(), { force: true });
    });

    const status = async () => {
      const out: string[] = [];
      await runAgentStatus({ cwd: dir, scope: 'project', out: (c) => out.push(c) });
      return out.join('');
    };

    const writeEvent = (minutesAgo: number) => {
      const path = agentEventLogPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify(
          redactAgentEvent({
            agent: 'claude-code',
            sessionId: 's1',
            eventId: `e-${minutesAgo}`,
            ts: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
            cwd: dir,
            kind: 'command',
            command: 'npm test',
            outcome: 'fail',
            exitCode: 1,
            durationMs: 5,
          } as AgentEvent),
        )}\n`,
      );
    };

    it('says an installed integration has never captured anything', async () => {
      await runAgentInstall({ cwd: dir, scope: 'project', out: () => {} });

      const text = await status();
      expect(text).toMatch(/installed\s+yes/);
      expect(text).toContain('never observed');
    });

    it('says healthy, and shows the last event, once capture has worked', async () => {
      await runAgentInstall({ cwd: dir, scope: 'project', out: () => {} });
      writeEvent(5);

      const text = await status();
      expect(text).toContain('healthy');
      expect(text).toMatch(/last event\s+\d{4}-\d{2}-\d{2}T/);
      expect(text).toContain('(command, fail)');
    });

    it('says stale when the last capture is older than the healthy window', async () => {
      writeEvent(60 * 48);

      expect(await status()).toContain('stale');
    });

    it('says degraded, and names the reason, when recent events were dropped', async () => {
      recordCaptureDrop('unsupported-event');

      const text = await status();
      expect(text).toContain('degraded');
      expect(text).toContain('unsupported-event');
    });

    it('prints nothing about drops when there have been none', async () => {
      writeEvent(5);

      expect(await status()).not.toContain('drops');
    });
  });

  it('says so when there is nothing to remove', async () => {
    const out: string[] = [];
    expect(await runAgentRemove({ cwd: dir, scope: 'project', out: (c) => out.push(c) })).toBe(0);
    expect(out.join('')).toContain('nothing to remove');
  });
});

describe('nexusmem agent recall (CLI)', () => {
  let dir: string;
  let session = 0;

  const payload = (command: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: `sess-${session}`,
      cwd: dir,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_now',
      error: 'Exit code 1\nAssertionError',
      duration_ms: 10,
      ...over,
    });

  beforeEach(async () => {
    session += 1;
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-recall-cli-')));
    const g = (...args: string[]) => gitFixture(dir, args, { env: process.env });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    g('add', '.');
    g('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedFailure(command: string): Promise<void> {
    const ws = resolveWorkspace(dir);
    const { projectId } = await readConfig(ws);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const event = redactAgentEvent({
        agent: 'claude-code',
        sessionId: 'old-session',
        eventId: 'old-1',
        ts: new Date(Date.now() - 3_600_000).toISOString(),
        cwd: dir,
        kind: 'command',
        command,
        outcome: 'fail',
        exitCode: 1,
        durationMs: 10,
      } as AgentEvent);
      store.upsertNodes(collectAgentEvents([event], projectId, { repoRoot: dir }));
    } finally {
      store.close();
    }
  }

  it('prints an injection Claude Code understands when this command failed here before', async () => {
    await seedFailure('npm test');

    const out: string[] = [];
    expect(await runAgentRecall({ input: payload('npm test'), out: (c) => out.push(c) })).toBe(0);

    const printed = JSON.parse(out.join(''));
    expect(printed.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(printed.hookSpecificOutput.additionalContext).toContain('failed in this repository before');
  });

  it('stays silent on a failure with no history, so unrelated work is never interrupted', async () => {
    await seedFailure('npm test');

    const out: string[] = [];
    expect(await runAgentRecall({ input: payload('cargo build'), out: (c) => out.push(c) })).toBe(0);
    expect(out.join('')).toBe('');
  });

  it('explains the same failure only once per session', async () => {
    await seedFailure('npm test');

    const first: string[] = [];
    await runAgentRecall({ input: payload('npm test'), out: (c) => first.push(c) });
    expect(first.join('')).not.toBe('');

    const second: string[] = [];
    await runAgentRecall({ input: payload('npm test'), out: (c) => second.push(c) });
    expect(second.join('')).toBe('');
  });

  it('stays silent, and still exits 0, when the payload is malformed or the repo is unknown', async () => {
    const out: string[] = [];
    expect(await runAgentRecall({ input: '{ not json', out: (c) => out.push(c) })).toBe(0);
    expect(await runAgentRecall({ input: payload('npm test', { cwd: tmpdir() }), out: (c) => out.push(c) })).toBe(0);
    expect(await runAgentRecall({ input: payload('npm test', { hook_event_name: 'PostToolUse' }), out: (c) => out.push(c) })).toBe(0);
    expect(out.join('')).toBe('');
  });

  it('ignores a successful command, which has nothing to recall', async () => {
    await seedFailure('npm test');
    const out: string[] = [];
    await runAgentRecall({
      input: JSON.stringify({
        session_id: `sess-${session}-ok`,
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 't1',
      }),
      out: (c) => out.push(c),
    });
    expect(out.join('')).toBe('');
  });

  it('matches the raw command hash, not the redacted text', async () => {
    const withSecret = 'psql postgres://app:one@db/app';
    await seedFailure(withSecret);

    const hit: string[] = [];
    await runAgentRecall({ input: payload(withSecret), out: (c) => hit.push(c) });
    expect(hit.join('')).toContain('failed in this repository before');
    expect(hit.join('')).not.toContain('one@db');

    const miss: string[] = [];
    await runAgentRecall({ input: payload('psql postgres://app:two@db/app'), out: (c) => miss.push(c) });
    expect(miss.join('')).toBe('');
    expect(sha256Hex(withSecret)).not.toBe(sha256Hex('psql postgres://app:two@db/app'));
  });

  const sessionStartPayload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ session_id: 'sess-start', cwd: dir, hook_event_name: 'SessionStart', source: 'startup', ...over });

  it('opens a session by starting a sync and naming what is still unfixed', async () => {
    await seedFailure('npm test');

    const synced: string[] = [];
    const out: string[] = [];
    expect(
      await runAgentSessionStart({ input: sessionStartPayload(), out: (c) => out.push(c), startSync: (r) => synced.push(r) }),
    ).toBe(0);

    // The sync the user previously had to remember to run.
    expect(synced).toHaveLength(1);
    expect(out.join('')).toContain('with no recorded fix');
    expect(out.join('')).toContain('npm test');
  });

  it('opens silently when this repository has nothing unresolved', async () => {
    const out: string[] = [];
    await runAgentSessionStart({ input: sessionStartPayload(), out: (c) => out.push(c), startSync: () => {} });
    expect(out.join('')).toBe('');
  });

  it('ignores a payload that is not a SessionStart, and never throws', async () => {
    const out: string[] = [];
    const synced: string[] = [];
    await runAgentSessionStart({ input: '{ not json', out: (c) => out.push(c), startSync: (r) => synced.push(r) });
    await runAgentSessionStart({
      input: sessionStartPayload({ hook_event_name: 'SessionEnd' }),
      out: (c) => out.push(c),
      startSync: (r) => synced.push(r),
    });
    expect(out.join('')).toBe('');
    expect(synced).toEqual([]);
  });
});
