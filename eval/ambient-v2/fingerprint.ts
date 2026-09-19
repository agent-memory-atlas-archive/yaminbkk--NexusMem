import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTrials, SEED } from './order.js';
import { V2_SCENARIOS, type V2Scenario } from './scenario.js';

/**
 * Stable hashes over everything a trial's meaning depends on.
 *
 * The future model-eval gate records these. If any of them changes after
 * trials have begun, results from before and after the change describe
 * different experiments and must not be pooled.
 *
 * Line endings are normalised before hashing so a Windows checkout and a
 * POSIX one agree; the fixture timestamps are generated from a fixed epoch
 * and a placeholder root for the same reason.
 *
 *   npx tsx eval/ambient-v2/fingerprint.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fixed so the hash describes the fixture's shape, not the minute it was hashed. */
export const FINGERPRINT_EPOCH = Date.UTC(2026, 0, 2, 3, 4, 5);
const PLACEHOLDER_ROOT = '/eval/app';

export const REPEATS = 7;

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

const sourceOf = (file: string): string => readFileSync(join(HERE, file), 'utf8').split('\r\n').join('\n');

/** Canonical JSON: keys sorted at every level, so key order cannot move a hash. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Everything about a scenario that decides what a trial means. */
export function scenarioShape(scenario: V2Scenario): unknown {
  return {
    name: scenario.name,
    command: scenario.command,
    task: scenario.task,
    deadEnds: scenario.deadEnds,
    fix: scenario.fix,
    dayOneGreen: scenario.dayOneGreen,
    staleTrap: scenario.staleTrap,
    noiseFiles: scenario.noiseFiles,
    primaryEndpoint: scenario.primaryEndpoint,
    history: scenario.history,
    events: scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH),
  };
}

export interface Fingerprints {
  scenarios: string;
  fixtures: string;
  prompts: string;
  scorer: string;
  runner: string;
  delivery: string;
  isolation: string;
  order: string;
  /** One hash over all of the above. This is the number to quote. */
  design: string;
}

export function fingerprints(): Fingerprints {
  const parts = {
    scenarios: sha(canonical(V2_SCENARIOS.map(scenarioShape))),
    fixtures: sha(`${sourceOf('scenario.ts')}\n${sourceOf('fixture.ts')}`),
    prompts: sha(canonical(V2_SCENARIOS.map((s) => s.task))),
    scorer: sha(sourceOf('scorer.ts')),
    runner: sha(sourceOf('run.ts')),
    delivery: sha(sourceOf('verify-delivery.ts')),
    isolation: sha(sourceOf('isolation.ts')),
    order: sha(canonical({ seed: SEED, repeats: REPEATS, trials: planTrials(V2_SCENARIOS.map((s) => s.name), REPEATS) })),
  };
  return { ...parts, design: sha(canonical(parts)) };
}

if (process.argv[1]?.split(/[\\/]/).pop() === 'fingerprint.ts') {
  const printed = fingerprints();
  for (const [name, hash] of Object.entries(printed)) process.stdout.write(`${name.padEnd(11)} ${hash}\n`);
}
