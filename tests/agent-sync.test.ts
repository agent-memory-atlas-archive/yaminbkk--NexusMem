import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactAgentEvent } from '../src/agent/event.js';
import { agentEventLogPath } from '../src/agent/paths.js';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import { makeProjectId } from '../src/core/project.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * The Day 1 half of the scenario v0.10.6 exists for: an agent tries A, fails,
 * tries B, fails, then fixes it with C. This asserts the whole ingest path --
 * hook log to nodes to a failure->fix link -- runs off a plain `sync`, with no
 * --link-failures flag, because nobody would remember to pass one.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/agent-sync.git';
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

let dir: string;
let projectId: string;
let seq = 0;

interface AgentRow {
  id: string;
  ts: string;
  body: string;
  meta: string;
  paths: string | null;
}

/** Read straight from SQL: this asserts what was persisted, not what a reader re-derives. */
function agentNodes(): AgentRow[] {
  const store = MemoryStore.open(resolveWorkspace(dir).dbPath);
  try {
    return store.raw
      .prepare(
        `SELECT n.id, n.ts, n.body, n.meta,
                (SELECT group_concat(f.path) FROM node_files f WHERE f.node_id = n.id) AS paths
         FROM nodes n
         WHERE n.project_id = ? AND n.source = 'agent:claude-code'
         ORDER BY n.ts`,
      )
      .all(projectId) as AgentRow[];
  } finally {
    store.close();
  }
}

function writeAgentLog(lines: object[]): void {
  const path = agentEventLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

const at = (minutes: number) => new Date(Date.parse('2026-09-11T10:00:00.000Z') + minutes * 60_000).toISOString();

const cmd = (minutes: number, outcome: 'ok' | 'fail') =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `cmd-${(seq += 1)}`,
    ts: at(minutes),
    cwd: dir,
    kind: 'command',
    command: 'npm test',
    outcome,
    exitCode: outcome === 'ok' ? 0 : 1,
    ...(outcome === 'ok' ? {} : { errorSignature: 'AssertionError: expected 1 to be 2' }),
    durationMs: 2000,
  });

const edit = (minutes: number, file: string) =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `edit-${(seq += 1)}`,
    ts: at(minutes),
    cwd: dir,
    kind: 'edit',
    filePath: join(dir, file),
    outcome: 'ok',
    exitCode: null,
    durationMs: 5,
  });

beforeEach(async () => {
  // realpath: git reports the resolved root, and an unresolved temp path would
  // not match it on Windows, so every event would be scoped out of the repo.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-agent-sync-')));
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);

  await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
  // No shell hook belongs to this throwaway repo, so a real shell sync would
  // scrape this machine's own history instead of the fixture below.
  const ws = resolveWorkspace(dir);
  const config = await readConfig(ws);
  await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });

  projectId = makeProjectId({ root: dir, originUrl: REMOTE });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync: agent events', () => {
  it('ingests a failed-then-fixed run and links it, with no --link-failures flag', async () => {
    writeAgentLog([
      edit(0, 'src/a.ts'),
      cmd(1, 'fail'),
      edit(10, 'src/b.ts'),
      cmd(11, 'fail'),
      edit(20, 'src/c.ts'),
      cmd(21, 'ok'),
    ]);

    const chunks: string[] = [];
    const code = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: (c) => chunks.push(c) });
    expect(code).toBe(0);

    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('3 agent action(s)');
    expect(out).toMatch(/chains: \d+ failure\(s\) examined/);

    const nodes = agentNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.paths)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(JSON.parse(nodes[0]!.meta)).toMatchObject({ outcome: 'fail', exitCode: 1, agent: 'claude-code' });
    expect(nodes[0]!.body).toContain('AssertionError: expected 1 to be 2');

    // The whole point: the first failure now points at the run that fixed it.
    const store = MemoryStore.open(resolveWorkspace(dir).dbPath);
    try {
      expect(store.getLinkedNodeIds(nodes[0]!.id, RESOLVED_BY_RETRY)).toEqual([nodes[2]!.id]);
    } finally {
      store.close();
    }
  });

  it('advances its cursor: a second sync re-reads nothing and creates no duplicate', async () => {
    writeAgentLog([edit(0, 'src/a.ts'), cmd(1, 'fail')]);
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });

    const chunks: string[] = [];
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: (c) => chunks.push(c) });

    expect(stripAnsi(chunks.join(''))).not.toContain('agent action(s)');
    expect(agentNodes()).toHaveLength(1);
  });

  it('ignores events from another repository', async () => {
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-agent-other-')));
    try {
      writeAgentLog([{ ...cmd(1, 'fail'), cwd: other }]);
      await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
      expect(agentNodes()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('stays silent when the source is disabled in config', async () => {
    writeAgentLog([cmd(1, 'fail')]);
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, agent: { enabled: false } } });

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
    expect(agentNodes()).toEqual([]);
  });
});
