import { describe, expect, it } from 'vitest';
import { canonical, fingerprints, scenarioShape } from '../eval/ambient-v2/fingerprint.js';
import { V2_SCENARIOS } from '../eval/ambient-v2/scenario.js';

/**
 * The fingerprints are what the future model-eval gate records. They have to
 * be stable across runs and hosts, and they have to move when the experiment
 * moves -- otherwise two different experiments could be pooled under one
 * number without anyone noticing.
 */

describe('harder-eval fingerprints', () => {
  it('is stable across calls', () => {
    expect(fingerprints()).toEqual(fingerprints());
  });

  it('covers every artifact a trial\'s meaning depends on', () => {
    const printed = fingerprints();
    for (const key of ['scenarios', 'fixtures', 'prompts', 'scorer', 'runner', 'delivery', 'isolation', 'order', 'design']) {
      expect(printed, key).toHaveProperty(key);
      expect(printed[key as keyof typeof printed]).toMatch(/^[0-9a-f]{16}$/);
    }
    // The combined hash is not one of the parts under another name.
    const parts = Object.entries(printed).filter(([k]) => k !== 'design');
    expect(parts.some(([, v]) => v === printed.design)).toBe(false);
  });

  it('does not depend on the minute it was taken or the host it ran on', () => {
    const shape = JSON.stringify(scenarioShape(V2_SCENARIOS[0]!));
    expect(shape).not.toContain(process.cwd());
    expect(shape).toContain('/eval/app');
  });

  it('moves when the experiment moves', () => {
    const before = canonical(V2_SCENARIOS.map(scenarioShape));
    const after = canonical(V2_SCENARIOS.map((s) => ({ ...scenarioShape(s) as object, task: 'a different sentence' })));
    expect(after).not.toBe(before);
  });

  it('canonicalises key order, so re-ordering a definition cannot move a hash', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });
});
