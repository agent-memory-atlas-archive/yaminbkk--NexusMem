import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V2_SCENARIOS } from '../eval/ambient-v2/scenario.js';
import { verifyScenario } from '../eval/ambient-v2/verify-fixtures.js';

/**
 * The harder eval's fixtures have to be truthful before any model runs
 * against them, and the task the model is handed has to read like ordinary
 * work. Both are checked here rather than only in the standalone verifier, so
 * a change that quietly makes a "dead end" into the answer fails CI.
 */

/** Language that would tell the model what the benchmark is measuring. */
const MECHANISM = /nexusmem|\bmemory\b|\brecall\b|previous attempt|known fix|\bstale\b|failed before|\bhint\b/i;

describe('harder-eval scenarios', () => {
  for (const scenario of V2_SCENARIOS) {
    it(`${scenario.name} is internally truthful`, () => {
      expect(verifyScenario(scenario)).toEqual([]);
    });
  }

  it('hands every arm the same sentence, and it names nothing', () => {
    const tasks = new Set(V2_SCENARIOS.map((s) => s.task));
    expect(tasks.size).toBe(1);
    for (const scenario of V2_SCENARIOS) {
      expect(scenario.task).not.toMatch(MECHANISM);
      expect(scenario.task).not.toContain(scenario.fix.file);
      for (const edit of scenario.deadEnds) expect(scenario.task).not.toContain(edit.file);
    }
  });

  it('leaks nothing through scenario or file names', () => {
    for (const scenario of V2_SCENARIOS) {
      expect(scenario.name).not.toMatch(MECHANISM);
      const dir = mkdtempSync(join(tmpdir(), 'nexusmem-v2-names-'));
      try {
        scenario.build(dir);
        const paths = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => !p.startsWith('.git'));
        for (const path of paths) expect(path, `${scenario.name}: ${path}`).not.toMatch(MECHANISM);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('gives the primary endpoint something to vary on, and the null case nothing', () => {
    const withDeadEnds = V2_SCENARIOS.filter((s) => s.primaryEndpoint);
    expect(withDeadEnds.length).toBeGreaterThanOrEqual(2);
    for (const scenario of withDeadEnds) {
      expect(scenario.deadEnds.length).toBeGreaterThanOrEqual(2);
      // A dead end that is also the answer would score every run as a repeat.
      for (const edit of scenario.deadEnds) expect(edit.file).not.toBe(scenario.fix.file);
    }
    for (const scenario of V2_SCENARIOS.filter((s) => !s.primaryEndpoint)) expect(scenario.deadEnds).toEqual([]);
  });

  it('records a rediscovery route for every scenario, and keeps it out of the task', () => {
    for (const scenario of V2_SCENARIOS) {
      expect(scenario.rediscoveryRoute.length).toBeGreaterThan(40);
      expect(scenario.task).not.toContain(scenario.rediscoveryRoute);
    }
  });

  it('dates the reverted-window history so the revert is strictly later than the fix', () => {
    const scenario = V2_SCENARIOS.find((s) => s.name === 'reverted-window')!;
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-v2-dates-'));
    try {
      scenario.build(dir);
      const stamps = execFileSync('git', ['-C', dir, 'log', '--reverse', '--format=%ct'], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map(Number);
      for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
