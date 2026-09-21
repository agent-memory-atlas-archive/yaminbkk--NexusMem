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

  /**
   * The candidate frozen values, pinned so every CI host -- Windows, macOS and
   * Linux -- has to reproduce them from its own checkout. A deliberate change
   * to the harness updates this list; after a trial has run, a change here
   * means the results before and after it must not be pooled.
   */
  it('reproduces the frozen fingerprints on this host', () => {
    expect(fingerprints()).toEqual({
      scenarios: '916f45e1a6ede2d5',
      fixtures: 'd5413b3962ba02e9',
      prompts: '3e99b2e63764ab08',
      scorer: '0dc30aa6891c060d',
      runner: '67562ffc8d324a92',
      delivery: '5873effb5577d368',
      isolation: 'efc01be13b7feb9d',
      order: '07eb683962cbfa21',
      design: '78d2d05b8d01789f',
    });
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
    // Every event path is rooted at the placeholder and spelled with forward slashes.
    expect(shape).toContain('"filePath":"<root>/config/defaults.json"');
    expect(shape).not.toContain('\\\\');
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
