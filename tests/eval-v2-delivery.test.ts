import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { V2_SCENARIOS, type V2Scenario } from '../eval/ambient-v2/scenario.js';
import { buildDeliveryFixture, revertsDayOneFix, verifyDelivery, type DeliveryFixture } from '../eval/ambient-v2/verify-delivery.js';

/**
 * Delivery coverage against the real CLI and a real database: the product has
 * to be able to put a scenario's intended memory in front of the model, and
 * has to stay silent for the scenario whose memory is irrelevant.
 *
 * One scenario of each kind is covered here so CI proves the mechanism;
 * `eval/ambient-v2/verify-delivery.ts` runs the same checks over all of them
 * before any trial and is what the model-eval gate must re-run.
 *
 * The last case is the mutation proof required before these numbers are
 * trusted: a scenario whose relevant-memory mapping has been corrupted must
 * fail verification rather than quietly pass.
 */

const SHADOWED = V2_SCENARIOS.find((s) => s.name === 'shadowed-config')!;
const NULL_CASE = V2_SCENARIOS.find((s) => s.name === 'unrelated-history')!;
const fixtures: DeliveryFixture[] = [];

function fixtureFor(scenario: V2Scenario): DeliveryFixture {
  const fixture = buildDeliveryFixture(scenario);
  fixtures.push(fixture);
  return fixture;
}

afterAll(() => {
  for (const fixture of fixtures) {
    // Best-effort: on Windows the database file can still be held open.
    try {
      rmSync(fixture.workspace, { recursive: true, force: true });
    } catch {
      /* left for the operating system to reap */
    }
  }
});

describe('harder-eval delivery coverage', () => {
  it('delivers the seeded chain for a scenario that has one', () => {
    expect(verifyDelivery(SHADOWED, fixtureFor(SHADOWED))).toEqual([]);
  });

  it('stays silent for a command nothing was ever recorded against', () => {
    expect(verifyDelivery(NULL_CASE, fixtureFor(NULL_CASE))).toEqual([]);
  });

  it('mutation: corrupting the relevant-memory mapping fails verification', () => {
    const corrupted: V2Scenario = {
      ...SHADOWED,
      deadEnds: [{ file: 'src/schedule.js', from: 'HOURLY_MS', to: 'HOURLY_MS' }, ...SHADOWED.deadEnds.slice(1)],
    };
    const problems = verifyDelivery(corrupted, fixtureFor(SHADOWED));
    expect(problems.join('\n')).toContain('src/schedule.js is missing from the recalled history');
  });

  it('reads the stale state out of the fixture\'s own git history', () => {
    const window = V2_SCENARIOS.find((s) => s.name === 'reverted-window')!;
    const shadowed = fixtureFor(SHADOWED);
    expect(revertsDayOneFix(shadowed.repoDir, SHADOWED)).toBe(false);
    const reverted = fixtureFor(window);
    expect(revertsDayOneFix(reverted.repoDir, window)).toBe(true);
  });
});
