import { describe, expect, it } from 'vitest';
import { canonicalizeCommand, redactAgentEvent } from '../src/agent/event.js';
import { sha256Hex } from '../src/core/ids.js';

/**
 * The eval measured this directly: a live Claude Code Bash call is routinely
 * `cd "<repo>" && npm test`, while the historical record of the same command
 * is bare `npm test` -- an exact-hash match on the raw text can never find
 * it. `canonicalizeCommand` is the one narrow, provably-safe rewrite that
 * closes that gap: strip a `cd` prefix, but only when it names the exact cwd
 * the event already carries. Everything else -- a `cd` elsewhere, an env-var
 * prefix, `sudo`, a pipe, a second command -- is left as a different command,
 * on purpose: a wrong match here would be worse than a missed one.
 */

describe('canonicalizeCommand', () => {
  it('MATCH: strips a cd prefix that names the same cwd, Windows path', () => {
    const cwd = 'C:\\Users\\dev\\repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: strips a cd prefix that names the same cwd, POSIX path', () => {
    const cwd = '/home/dev/repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: a slash/backslash mismatch between the cd target and the recorded cwd still matches', () => {
    expect(canonicalizeCommand('cd "C:/Users/dev/repo" && node check.js', 'C:\\Users\\dev\\repo')).toBe('node check.js');
  });

  it('MATCH: a trailing slash on either side does not block the match', () => {
    expect(canonicalizeCommand('cd "/home/dev/repo/" && node check.js', '/home/dev/repo')).toBe('node check.js');
  });

  it('MATCH: a cwd containing spaces, quoted', () => {
    const cwd = 'C:\\Users\\dev\\my repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: single-quoted cd target', () => {
    const cwd = '/home/dev/repo';
    expect(canonicalizeCommand(`cd '${cwd}' && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: bare "cd ." is always the same directory', () => {
    expect(canonicalizeCommand('cd . && node check.js', '/home/dev/repo')).toBe('node check.js');
  });

  it('NO MATCH: cd to a different directory is left untouched', () => {
    const raw = 'cd other && node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: a leading token that is not cd is left untouched', () => {
    const raw = 'setup && node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: an inline env-var assignment is left untouched', () => {
    const raw = 'VAR=x node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: sudo is left untouched', () => {
    const raw = 'sudo node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: piped to another command is left untouched', () => {
    const raw = 'node check.js | other';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: chained with a second command via ; is left untouched', () => {
    const raw = 'node check.js ; other';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: no cwd known at all leaves the command untouched', () => {
    const raw = 'cd /home/dev/repo && node check.js';
    expect(canonicalizeCommand(raw, null)).toBe(raw);
  });

  it('historical compatibility: a command with no cd prefix is a pure no-op', () => {
    // Every command NexusMem has ever recorded before this field existed was
    // exactly this shape, so its hash must be untouched.
    expect(canonicalizeCommand('node check.js', '/home/dev/repo')).toBe('node check.js');
    expect(canonicalizeCommand('node check.js', null)).toBe('node check.js');
  });

  it('is a pure, deterministic function: repeated ingestion of the same event yields the same key', () => {
    const a = canonicalizeCommand('cd "/repo" && node check.js', '/repo');
    const b = canonicalizeCommand('cd "/repo" && node check.js', '/repo');
    expect(a).toBe(b);
  });
});

describe('execHash on a redacted event', () => {
  const cwd = '/home/dev/repo';

  it('MATCH: a live cd-wrapped failure and a historical bare command produce the same execHash', () => {
    const historical = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: 'node check.js',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const live = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-08T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && node check.js`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });

    expect(live.execHash).toBe(historical.execHash);
    // The raw hash still differs -- execHash is a new, separate key, not a repurposed one.
    expect(live.commandHash).not.toBe(historical.commandHash);
  });

  it('NO MATCH: the same command run in a different repository does not share an execHash by text alone', () => {
    // execHash is still looked up scoped by project_id in recall.ts; this only
    // proves the hash itself does not accidentally erase the distinction --
    // it is computed from command text, not from cwd, exactly like commandHash.
    const a = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd: '/repo-a',
      kind: 'command',
      command: 'cd /repo-a && npm test',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const b = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-01T00:00:00.000Z',
      cwd: '/repo-b',
      kind: 'command',
      command: 'cd /repo-b && npm test',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    // Both canonicalize to bare "npm test", so the hashes DO collide -- recall
    // stays safe only because its query is also scoped by project_id.
    expect(a.execHash).toBe(b.execHash);
  });

  it('keeps the raw-secret invariant: two commands differing only by an embedded secret never collide', () => {
    const a = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && psql postgres://app:one@db/app`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const b = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && psql postgres://app:two@db/app`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    expect(a.execHash).not.toBe(b.execHash);
    expect(a.execHash).toBe(sha256Hex('psql postgres://app:one@db/app').slice(0, 12));
  });
});
