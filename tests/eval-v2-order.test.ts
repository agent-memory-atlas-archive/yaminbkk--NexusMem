import { describe, expect, it } from 'vitest';
import { firstPositionCounts, planTrials, SEED } from '../eval/ambient-v2/order.js';
import { V2_SCENARIOS } from '../eval/ambient-v2/scenario.js';
import { ARMS } from '../eval/ambient-v2/scorer.js';
import { REPEATS } from '../eval/ambient-v2/fingerprint.js';
import {
  checkArmSetup,
  checkDistinctWorkspaces,
  checkFreshWorkspace,
  type TrialPaths,
} from '../eval/ambient-v2/isolation.js';

const NAMES = V2_SCENARIOS.map((s) => s.name);

describe('harder-eval trial order', () => {
  it('is reproducible from the seed alone', () => {
    expect(planTrials(NAMES, REPEATS)).toEqual(planTrials(NAMES, REPEATS, SEED));
    expect(planTrials(NAMES, REPEATS)).not.toEqual(planTrials(NAMES, REPEATS, SEED + 1));
  });

  it('runs every scenario, arm and repeat exactly once', () => {
    const trials = planTrials(NAMES, REPEATS);
    expect(trials).toHaveLength(NAMES.length * REPEATS * ARMS.length);
    expect(new Set(trials.map((t) => `${t.scenario}/${t.arm}/${t.repeat}`)).size).toBe(trials.length);
    expect(trials.map((t) => t.order)).toEqual(trials.map((_, i) => i + 1));
  });

  it('gives no arm a systematic head start', () => {
    const counts = firstPositionCounts(planTrials(NAMES, REPEATS));
    const values = Object.values(counts);
    expect(new Set(values).size).toBe(1);
    expect(values.reduce((a, b) => a + b, 0)).toBe(NAMES.length * REPEATS);
  });

  it('keeps the three arms of one block adjacent, so they share the closest conditions', () => {
    const trials = planTrials(NAMES, REPEATS);
    for (let i = 0; i < trials.length; i += ARMS.length) {
      const block = trials.slice(i, i + ARMS.length);
      expect(new Set(block.map((t) => `${t.scenario}/${t.repeat}`)).size).toBe(1);
      expect(new Set(block.map((t) => t.arm)).size).toBe(ARMS.length);
    }
  });
});

describe('harder-eval isolation checks', () => {
  const paths: TrialPaths = { workspace: '/w/trial', repoDir: '/w/trial/app', nmHome: '/w/trial/nmhome' };

  it('rejects a workspace that already existed, or state kept outside it', () => {
    expect(checkFreshWorkspace(paths, false)).toEqual([]);
    expect(checkFreshWorkspace(paths, true)).toHaveLength(1);
    expect(checkFreshWorkspace({ ...paths, nmHome: '/elsewhere/nmhome' }, false)).toHaveLength(1);
  });

  it('rejects a reused workspace', () => {
    expect(checkDistinctWorkspaces(['/w/a', '/w/b'])).toEqual([]);
    expect(checkDistinctWorkspaces(['/w/a', '/w/a'])).toHaveLength(1);
  });

  it('reads arm setup off the filesystem, not from what the runner intended', () => {
    // Nothing exists at these paths, which is exactly right for control and
    // wrong for the two arms that are supposed to have been seeded.
    expect(checkArmSetup('control', paths)).toEqual([]);
    expect(checkArmSetup('mcp', paths).length).toBeGreaterThan(0);
    expect(checkArmSetup('ambient', paths).length).toBeGreaterThan(0);
  });
});
