import { ARMS, type Arm } from './scorer.js';

/**
 * The trial-order manifest.
 *
 * The Phase-5 runner always went control -> mcp -> ambient inside every
 * repeat, so any drift over a batch -- service-side variation, a warming
 * filesystem, the machine getting busier -- landed on the arms in a fixed
 * pattern. That is cheap to remove and expensive to argue about afterwards,
 * so the order is balanced here instead: each block of three trials rotates
 * which arm goes first, and the blocks themselves are shuffled from a fixed
 * seed. Reproducible from `SEED` alone, and recorded with the results.
 */

export interface PlannedTrial {
  /** 1-based position in the whole run. */
  order: number;
  scenario: string;
  arm: Arm;
  repeat: number;
}

export const SEED = 0x6e6d3276;

/** mulberry32: small, well-known, and identical on every platform. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, driven by the seeded generator, so the same seed gives the same order. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * One block per (scenario, repeat): all three arms, rotated so no arm is
 * systematically first. Blocks are then shuffled; arms stay adjacent inside a
 * block so the three trials being compared share the closest conditions the
 * design can give them.
 */
export function planTrials(scenarios: readonly string[], repeats: number, seed = SEED): PlannedTrial[] {
  const blocks: Array<Array<Omit<PlannedTrial, 'order'>>> = [];
  scenarios.forEach((scenario, s) => {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const rotation = (s + repeat - 1) % ARMS.length;
      const arms = [...ARMS.slice(rotation), ...ARMS.slice(0, rotation)];
      blocks.push(arms.map((arm) => ({ scenario, arm, repeat })));
    }
  });
  return shuffle(blocks, mulberry32(seed))
    .flat()
    .map((trial, i) => ({ order: i + 1, ...trial }));
}

/** Every arm appears equally often in every starting position across the blocks. */
export function firstPositionCounts(trials: readonly PlannedTrial[]): Record<Arm, number> {
  const counts = Object.fromEntries(ARMS.map((a) => [a, 0])) as Record<Arm, number>;
  for (let i = 0; i < trials.length; i += ARMS.length) counts[trials[i]!.arm] += 1;
  return counts;
}
