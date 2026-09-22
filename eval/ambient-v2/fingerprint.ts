import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawAgentEvent } from '../../src/agent/event.js';
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
export const PLACEHOLDER_ROOT = '/eval/app';

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

/**
 * One spelling of an event path, whatever host generated it.
 *
 * `scenario.events` builds `filePath` with `node:path`'s `join`, so the same
 * committed definition yields `\eval\app\config\defaults.json` on Windows and
 * `/eval/app/config/defaults.json` on POSIX -- at 71b31f3 that made `scenarios`
 * and `design` differ by host for byte-identical content. Normalised here, at
 * the fingerprint boundary, and nowhere else: the runtime events keep their
 * native paths because that is what the product's collectors receive.
 *
 * Only the separator and the placeholder root are rewritten. Case is kept,
 * a drive letter is kept, and a UNC `\\server\share` stays distinct from
 * `/server/share`: the fingerprint identifies an experiment definition and
 * must not merge two paths that could mean different things.
 */
export function canonicalEventPath(path: string): string {
  const slashed = path.split('\\').join('/');
  if (slashed === PLACEHOLDER_ROOT) return '<root>';
  if (slashed.startsWith(`${PLACEHOLDER_ROOT}/`)) return `<root>${slashed.slice(PLACEHOLDER_ROOT.length)}`;
  return slashed;
}

export function canonicalEvents(events: readonly RawAgentEvent[]): unknown[] {
  return events.map((e) => ({
    ...e,
    ...(e.filePath ? { filePath: canonicalEventPath(e.filePath) } : {}),
    ...(e.cwd ? { cwd: canonicalEventPath(e.cwd) } : {}),
  }));
}

/** Everything about a scenario that decides what a trial means, given its seeded events. */
export function shapeWithEvents(scenario: V2Scenario, events: readonly RawAgentEvent[]): unknown {
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
    events: canonicalEvents(events),
  };
}

/** Everything about a scenario that decides what a trial means. */
export function scenarioShape(scenario: V2Scenario): unknown {
  return shapeWithEvents(scenario, scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH));
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
    runner: sha(`${sourceOf('run.ts')}\n${sourceOf('workspace.ts')}`),
    delivery: sha(sourceOf('verify-delivery.ts')),
    isolation: sha(`${sourceOf('isolation.ts')}\n${sourceOf('state.ts')}`),
    order: sha(canonical({ seed: SEED, repeats: REPEATS, trials: planTrials(V2_SCENARIOS.map((s) => s.name), REPEATS) })),
  };
  return { ...parts, design: sha(canonical(parts)) };
}

/**
 * One hash over every file under `dir`, or null when `dir` does not exist.
 *
 * Keys are relative paths split on the host's own separator only, so a POSIX
 * name containing `\` stays one component. Contents are hashed with LF line
 * endings, as in `sourceOf`.
 */
export function treeHash(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => [rel.split(sep).join('/'), sha(readFileSync(join(dir, rel), 'utf8').split('\r\n').join('\n'))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha(canonical(files));
}

/**
 * The product a trial exercises, kept apart from `design`.
 *
 * `design` identifies the experiment definition and is frozen in a test; the
 * product under test changes with every commit to `src/`. Two runs may be
 * pooled only when `design` and both of these match. `build` is what the
 * trials actually executed, so a stale `dist/` shows up as a `build` that
 * differs between runs with the same `source`.
 */
export interface ProductFingerprints {
  source: string | null;
  build: string | null;
}

export function productFingerprints(root: string): ProductFingerprints {
  return { source: treeHash(join(root, 'src')), build: treeHash(join(root, 'dist')) };
}

if (process.argv[1]?.split(/[\\/]/).pop() === 'fingerprint.ts') {
  const printed = fingerprints();
  for (const [name, hash] of Object.entries(printed)) process.stdout.write(`${name.padEnd(11)} ${hash}\n`);
  const product = productFingerprints(join(HERE, '..', '..'));
  process.stdout.write(`\nproduct\n  source    ${product.source ?? 'missing'}\n  build     ${product.build ?? 'missing (run npm run build)'}\n`);
}
