import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { MAX_RECALL_CHARS, recallFailure } from '../src/agent/recall.js';
import { markInjected, MAX_INJECTIONS_PER_SESSION, shouldInject } from '../src/agent/recall-state.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { correlateFailures } from '../src/correlate/failure-fix.js';
import { sha256Hex } from '../src/core/ids.js';
import { MemoryStore } from '../src/store/store.js';

const PROJECT = 'proj-recall';
const ROOT = process.platform === 'win32' ? 'D:/repo' : '/repo';
const HASH = (command: string) => sha256Hex(command).slice(0, 12);

let dir: string;
let store: MemoryStore;
let seq = 0;

const at = (minutes: number) => new Date(Date.parse('2026-09-04T09:00:00.000Z') + minutes * 60_000).toISOString();

const event = (over: Partial<AgentEvent>): AgentEvent =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `e-${(seq += 1)}`,
    ts: at(0),
    cwd: ROOT,
    kind: 'command',
    outcome: 'fail',
    exitCode: 1,
    durationMs: 10,
    ...over,
  } as AgentEvent);

/** Seeds the Day 1 story: edit, fail, edit, fail, edit, pass -- through the real collector. */
function seedDayOne(command = 'npm test'): void {
  const events = [
    event({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(0) }),
    event({ command, ts: at(1) }),
    event({ kind: 'edit', filePath: `${ROOT}/src/b.ts`, outcome: 'ok', exitCode: null, ts: at(10) }),
    event({ command, ts: at(11) }),
    event({ kind: 'edit', filePath: `${ROOT}/src/c.ts`, outcome: 'ok', exitCode: null, ts: at(20) }),
    event({ command, outcome: 'ok', exitCode: 0, ts: at(21) }),
  ];
  store.upsertNodes(collectAgentEvents(events, PROJECT, { repoRoot: ROOT }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-recall-'));
  store = MemoryStore.open(join(dir, 'memory.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recallFailure', () => {
  it('says nothing when this command has never failed here', () => {
    seedDayOne();
    expect(recallFailure(store, PROJECT, HASH('cargo build'))).toBeNull();
  });

  it('says nothing when the command only ever succeeded', () => {
    store.upsertNodes(
      collectAgentEvents([event({ command: 'npm run build', outcome: 'ok', exitCode: 0 })], PROJECT, { repoRoot: ROOT }),
    );
    expect(recallFailure(store, PROJECT, HASH('npm run build'))).toBeNull();
  });

  it('says nothing for another project history', () => {
    seedDayOne();
    expect(recallFailure(store, 'someone-else', HASH('npm test'))).toBeNull();
  });

  it('reports past failures with the files that were edited before each', () => {
    seedDayOne();
    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;

    expect(recall.matched).toBe(2);
    expect(recall.text).toContain('failed in this repository before (2 time(s))');
    expect(recall.text).toContain('src/a.ts');
    expect(recall.text).toContain('src/b.ts');
  });

  it('names the fix once correlation has linked one', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);

    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;
    expect(recall.resolved).toBe(true);
    expect(recall.text).toContain('fixed on 2026-09-04 after editing src/c.ts');
    expect(recall.text).toContain('Check what changed in that fix');
  });

  it('is explicit when nothing ever fixed it, which is itself the useful signal', () => {
    store.upsertNodes(collectAgentEvents([event({ command: 'npm test' })], PROJECT, { repoRoot: ROOT }));

    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;
    expect(recall.resolved).toBe(false);
    expect(recall.text).toContain('no fix for it was ever recorded here');
  });

  it('stays inside its character budget even with a long history', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      event({ command: `npm test -- ${'x'.repeat(300)}`, ts: at(i) }),
    );
    store.upsertNodes(collectAgentEvents(events, PROJECT, { repoRoot: ROOT }));

    const recall = recallFailure(store, PROJECT, HASH(`npm test -- ${'x'.repeat(300)}`))!;
    expect(recall.text.length).toBeLessThanOrEqual(MAX_RECALL_CHARS);
  });

  it('matches on the raw command hash, so two different secrets never look like the same command', () => {
    const a = 'psql postgres://app:secret-one@db/app';
    const b = 'psql postgres://app:secret-two@db/app';
    store.upsertNodes(collectAgentEvents([event({ command: a })], PROJECT, { repoRoot: ROOT }));

    // Both redact to identical text; only the hash keeps them apart.
    expect(recallFailure(store, PROJECT, HASH(a))).not.toBeNull();
    expect(recallFailure(store, PROJECT, HASH(b))).toBeNull();
  });
});

describe('recall quota', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = join(dir, 'recall-state.json');
  });

  it('explains one failure once per session', () => {
    expect(shouldInject('s1', 'hash-a', statePath)).toBe(true);
    markInjected('s1', 'hash-a', statePath);

    expect(shouldInject('s1', 'hash-a', statePath)).toBe(false);
    expect(shouldInject('s1', 'hash-b', statePath)).toBe(true);
    expect(shouldInject('s2', 'hash-a', statePath)).toBe(true);
  });

  it('stops after the per-session ceiling', () => {
    for (let i = 0; i < MAX_INJECTIONS_PER_SESSION; i += 1) markInjected('s1', `hash-${i}`, statePath);
    expect(shouldInject('s1', 'hash-new', statePath)).toBe(false);
  });

  it('treats a missing or corrupt state file as an empty one', () => {
    expect(shouldInject('s1', 'hash-a', join(dir, 'nope.json'))).toBe(true);
  });
});
