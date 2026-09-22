import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import type { TrialPaths } from '../eval/ambient-v2/isolation.js';
import { preflightArm, setUpArm } from '../eval/ambient-v2/run.js';
import { V2_SCENARIOS } from '../eval/ambient-v2/scenario.js';
import { logicalState, stateDiff } from '../eval/ambient-v2/state.js';
import { verifyDelivery } from '../eval/ambient-v2/verify-delivery.js';
import { gitFixture } from './helpers.js';

/**
 * F3: the model must start from the seeded experiment state, never from one
 * a verifier wrote into.
 *
 * The audit on 71b31f3 found that probing an instance is not read-only:
 * recall writes `agent-recall-state.json`, and `agent session-start` spawns a
 * detached `sync --auto` that embeds every node when an embedding server
 * answers. These cases pin the fix -- delivery is proved on a disposable twin
 * -- and prove the guard that would catch it regressing is not vacuous.
 *
 * Heavy: each case builds and seeds a real instance through the built CLI.
 */

const SHADOWED = V2_SCENARIOS.find((s) => s.name === 'shadowed-config')!;
const made: string[] = [];
const HEAVY = 180_000;

function trial(): TrialPaths {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-v2-trial-')));
  made.push(workspace);
  return { workspace, repoDir: join(workspace, 'app'), nmHome: join(workspace, 'nmhome') };
}

afterAll(() => {
  for (const workspace of made) {
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A detached sync from the deliberate self-probe below may still hold the database.
    }
  }
});

describe('F3 pre-flight never changes the trial state', () => {
  it(
    'ambient: proves delivery and leaves the trial exactly as seeded',
    () => {
      const paths = trial();
      SHADOWED.build(paths.repoDir);
      setUpArm('ambient', SHADOWED, paths);
      const seeded = logicalState(paths.repoDir, paths.nmHome);

      expect(preflightArm('ambient', SHADOWED, paths)).toEqual([]);
      expect(stateDiff(seeded, logicalState(paths.repoDir, paths.nmHome))).toEqual([]);
    },
    HEAVY,
  );

  it(
    'mcp: speaking to the server on the trial instance writes nothing',
    () => {
      const paths = trial();
      SHADOWED.build(paths.repoDir);
      setUpArm('mcp', SHADOWED, paths);
      const seeded = logicalState(paths.repoDir, paths.nmHome);

      expect(preflightArm('mcp', SHADOWED, paths)).toEqual([]);
      expect(stateDiff(seeded, logicalState(paths.repoDir, paths.nmHome))).toEqual([]);
    },
    HEAVY,
  );

  it(
    'non-vacuity: probing the trial itself, as 71b31f3 did, is caught',
    () => {
      const paths = trial();
      SHADOWED.build(paths.repoDir);
      setUpArm('ambient', SHADOWED, paths);

      const probeTheTrial = () => verifyDelivery(SHADOWED, { ...paths, env: { ...process.env, NEXUSMEM_HOME: paths.nmHome } });
      const problems = preflightArm('ambient', SHADOWED, paths, probeTheTrial).join('\n');
      expect(problems).toContain("pre-flight changed the trial's own state");
      // Deterministic on every host: recall's own bookkeeping file, written synchronously.
      expect(problems).toContain('agent-recall-state.json');
    },
    HEAVY,
  );

  it(
    'non-vacuity: a verifier-only row or file is detected',
    () => {
      const paths = trial();
      SHADOWED.build(paths.repoDir);
      setUpArm('mcp', SHADOWED, paths);
      const seeded = logicalState(paths.repoDir, paths.nmHome);

      const db = new Database(join(paths.repoDir, '.nexusmem', 'memory.db'));
      try {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('verifier.only', 'synthetic');
      } finally {
        db.close();
      }
      writeFileSync(join(paths.nmHome, 'agent-recall-state.json'), '{}');

      const diff = stateDiff(seeded, logicalState(paths.repoDir, paths.nmHome));
      expect(diff).toContain('db table meta: +1 -0 row(s)');
      expect(diff).toContain('NEXUSMEM_HOME agent-recall-state.json: created');
    },
    HEAVY,
  );
});

describe('logical state keys on a POSIX filesystem', () => {
  it.skipIf(process.platform === 'win32')('keeps `a\\b` and `a/b` as two files, and does not skip `.git\\file` as git internals', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nexusmem-v2-state-sep-'));
    const home = mkdtempSync(join(tmpdir(), 'nexusmem-v2-state-home-'));
    try {
      gitFixture(repo, ['init', '-q', '-b', 'main']);
      gitFixture(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
      mkdirSync(join(repo, 'a'));
      writeFileSync(join(repo, 'a', 'b'), 'slash\n');
      writeFileSync(join(repo, 'a\\b'), 'backslash\n');
      writeFileSync(join(repo, '.git\\file'), 'not git internals\n');

      const tree = logicalState(repo, home).tree;
      expect(Object.keys(tree).sort()).toEqual(['.git\\file', 'a/b', 'a\\b']);
      expect(tree['a/b']).not.toBe(tree['a\\b']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
