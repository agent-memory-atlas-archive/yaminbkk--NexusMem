import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/event.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { makeNodeId } from '../src/core/ids.js';

const ROOT = 'D:/repo';
const PROJECT = 'proj-1';

let seq = 0;
const command = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude-code',
  sessionId: 'sess-1',
  eventId: `cmd-${(seq += 1)}`,
  ts: '2026-09-11T15:00:00.000Z',
  cwd: ROOT,
  kind: 'command',
  command: 'npm test',
  commandHash: 'abc123abc123',
  outcome: 'fail',
  exitCode: 1,
  durationMs: 100,
  ...over,
});

const edit = (filePath: string, over: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude-code',
  sessionId: 'sess-1',
  eventId: `edit-${(seq += 1)}`,
  ts: '2026-09-11T15:00:00.000Z',
  cwd: ROOT,
  kind: 'edit',
  filePath,
  outcome: 'ok',
  exitCode: null,
  durationMs: 1,
  ...over,
});

const collect = (events: AgentEvent[]) => collectAgentEvents(events, PROJECT, { repoRoot: ROOT });

describe('collectAgentEvents', () => {
  it('attaches the edits made since the last command to the command that follows them', () => {
    const [node] = collect([edit(`${ROOT}/src/a.ts`), edit(`${ROOT}/src/b.ts`), command()]);

    expect(node?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    // An agent edit reports no line counts, so none are invented.
    expect(node?.files[0]).toEqual({ path: 'src/a.ts', insertions: null, deletions: null, binary: false });
    expect(node?.body).toContain('changed before this ran: src/a.ts, src/b.ts');
  });

  it('treats each run as its own attempt: edits do not carry over to the next command', () => {
    const nodes = collect([edit(`${ROOT}/src/a.ts`), command(), command(), edit(`${ROOT}/src/c.ts`), command()]);

    expect(nodes.map((n) => n.files.map((f) => f.path))).toEqual([['src/a.ts'], [], ['src/c.ts']]);
  });

  it('keeps sessions apart, so one agent session cannot borrow another session edits', () => {
    const nodes = collect([
      edit(`${ROOT}/src/a.ts`, { sessionId: 'sess-2' }),
      command(),
      command({ sessionId: 'sess-2' }),
    ]);

    expect(nodes.map((n) => n.files.map((f) => f.path))).toEqual([[], ['src/a.ts']]);
  });

  it('produces a shell_command node whose meta matches what failure-fix and precheck already read', () => {
    const event = command();
    const [node] = collect([event]);

    expect(node).toMatchObject({
      id: makeNodeId(PROJECT, 'shell_command', `agent:claude-code:sess-1:${event.eventId}`),
      kind: 'shell_command',
      source: 'agent:claude-code',
      title: 'npm test',
      provenance: 'observed',
      meta: {
        command: 'npm test',
        commandHash: 'abc123abc123',
        cwd: ROOT,
        exitCode: 1,
        agent: 'claude-code',
        agentSessionId: 'sess-1',
        toolUseId: event.eventId,
        outcome: 'fail',
        captureVia: 'hook',
      },
    });
  });

  it('scores a failed run above the same run succeeding', () => {
    const [failed] = collect([command({ outcome: 'fail', exitCode: 1 })]);
    const [ok] = collect([command({ outcome: 'ok', exitCode: 0 })]);

    expect(failed!.signal).toBeGreaterThan(ok!.signal);
  });

  it('records the error signature in the body and meta', () => {
    const [node] = collect([command({ errorSignature: 'FATAL: connection refused' })]);

    expect(node?.body).toContain('error: FATAL: connection refused');
    expect(node?.meta.errorSignature).toBe('FATAL: connection refused');
  });

  it('ignores events belonging to another repository', () => {
    expect(collect([edit('D:/other/x.ts'), command({ cwd: 'D:/other' })])).toEqual([]);
  });

  it('ignores a command with no cwd, which cannot be attributed to a project', () => {
    expect(collect([command({ cwd: null })])).toEqual([]);
  });

  it('records an interrupted run without an exit code, and says so', () => {
    const [node] = collect([command({ outcome: 'interrupted', exitCode: null })]);

    expect(node?.meta.outcome).toBe('interrupted');
    expect(node?.body).toContain('interrupted');
  });

  it('does not repeat a file edited twice before the same command', () => {
    const [node] = collect([edit(`${ROOT}/src/a.ts`), edit(`${ROOT}/src/a.ts`), command()]);

    expect(node?.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});
