import { join } from 'node:path';
import type { RawAgentEvent } from '../../src/agent/event.js';
import { applyEdit, buildRepo, type Commit, type Edit } from './fixture.js';

/**
 * The harder ambient-memory experiment: scenario definitions.
 *
 * The Phase-5 set reached 9/9 task success in all three arms, so it could not
 * answer whether delivered history changes behaviour. The reason, from the
 * audit, was not sample size: in all three of those fixtures the failing
 * command's own output named the module to change, so no arm ever took a
 * wrong turn and the dead-end rate was 0/27 everywhere. A rate with no
 * variance in the control arm cannot discriminate.
 *
 * These fixtures are built the other way round. The failure output names a
 * symptom and no file; the most attractive candidate in the workspace is
 * proven not to fix it; and the history records that someone already tried
 * that candidate. Task success is deliberately NOT the endpoint -- a ceiling
 * there is expected and acceptable. What is measured is whether a run spends
 * an edit on an approach the seeded history already disproved.
 *
 * Every task string is the same sentence, names no file, no approach and no
 * memory system, and is handed identically to all three arms.
 */

export const TASK =
  '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.';

export interface V2Scenario {
  name: string;
  /** The command the agent is asked to fix, and which scoring re-runs. */
  command: string;
  /**
   * Approaches the seeded history proves were tried and left the check
   * failing. Editing one of these files is the primary endpoint's event.
   * Empty for the null-memory scenario, which is excluded from that endpoint.
   */
  deadEnds: readonly Edit[];
  /** What makes the state the agent is handed pass. */
  fix: Edit;
  /** What day 1 ended green on, where that is not today's answer. */
  dayOneGreen?: Edit;
  /**
   * Day 1's answer applied today: reverted in git and now inert. Editing this
   * file is a memory-attributable detour, not an ordinary dead end.
   */
  staleTrap?: Edit;
  /** Files named only by the seeded off-topic history. Editing one is following noise. */
  noiseFiles: readonly string[];
  /** Whether this scenario contributes to the frozen primary endpoint. */
  primaryEndpoint: boolean;
  /** The legitimate route a memoryless run can take. Recorded here, never in the task. */
  rediscoveryRoute: string;
  task: string;
  history: readonly Commit[];
  build(dir: string): void;
  /** Day-1 agent events, as the adapter would hand them over. `now` is explicit so fingerprints are stable. */
  events(repoDir: string, now: number): RawAgentEvent[];
}

/** One day-1 attempt: the file it edited, then the command's result. */
interface Attempt {
  file: string;
  outcome: 'ok' | 'fail';
  errorSignature?: string;
  /** Minutes after the start of day 1. */
  at: number;
}

/** Commands in the fixtures that have nothing to do with any task. Recalling one is noise. */
export const UNRELATED_COMMANDS = ['npm run lint', 'npm run typecheck'] as const;

/** Fake, and never a real credential shape anyone could mistake for one. */
export const EVAL_SECRET = 'ghp_evalF4keToken0123456789abcd';

/**
 * The event log the hook would have written on the day this was first worked
 * on, plus two chains that have nothing to do with it -- one resolved, one
 * left open so the session digest has something off-topic it could name.
 */
function agentEvents(
  repoDir: string,
  command: string,
  attempts: readonly Attempt[],
  sessionId: string,
  now: number,
): RawAgentEvent[] {
  const daysAgo = 7;
  const at = (minutes: number) => new Date(now - (daysAgo * 24 * 60 - minutes) * 60_000).toISOString();
  const base = { agent: 'claude-code', sessionId, cwd: repoDir, durationMs: 1500 };

  const events: RawAgentEvent[] = [];
  let n = 0;
  for (const attempt of attempts) {
    n += 1;
    events.push({
      ...base,
      eventId: `e${n}a`,
      ts: at(attempt.at),
      kind: 'edit',
      filePath: join(repoDir, attempt.file),
      outcome: 'ok',
      exitCode: null,
    });
    events.push({
      ...base,
      eventId: `e${n}b`,
      ts: at(attempt.at + 1),
      kind: 'command',
      command,
      outcome: attempt.outcome,
      exitCode: attempt.outcome === 'ok' ? 0 : 1,
      ...(attempt.errorSignature ? { errorSignature: attempt.errorSignature } : {}),
    });
  }

  // Unrelated chain 1: failed, then fixed. Carries the fake credential so the
  // delivery verifier has something real to assert the redaction path against.
  const other = `npm run lint --token=${EVAL_SECRET}`;
  events.push({ ...base, eventId: 'x1', ts: at(200), kind: 'edit', filePath: join(repoDir, '.eslintrc.json'), outcome: 'ok', exitCode: null });
  events.push({ ...base, eventId: 'x2', ts: at(201), kind: 'command', command: other, outcome: 'fail', exitCode: 1, errorSignature: 'Parsing error: Unexpected token' });
  events.push({ ...base, eventId: 'x3', ts: at(210), kind: 'command', command: other, outcome: 'ok', exitCode: 0 });

  // Unrelated chain 2: still unresolved.
  events.push({
    ...base,
    eventId: 'x4',
    ts: at(300),
    kind: 'command',
    command: 'npm run typecheck',
    outcome: 'fail',
    exitCode: 2,
    errorSignature: 'error TS2345: Argument of type string is not assignable',
  });

  return events;
}

const LINT_CONFIG = `{
  "root": true,
  "rules": {}
}
`;

// ---------------------------------------------------------------------------
// 1. shadowed-config -- the file that obviously holds the wrong value is not
//    the file the effective value comes from. A second source is merged over
//    it by a loader nothing points at. Editing the obvious one is the most
//    attractive move in the workspace and is proven inert, which is what
//    gives this scenario a non-zero dead-end base rate without memory.
// ---------------------------------------------------------------------------

const RETENTION_FILES: Record<string, string> = {
  'check.js': `const { loadSettings } = require('./src/config/load.js');
const { effectiveRetention } = require('./src/retention.js');

const days = effectiveRetention(loadSettings(__dirname));
if (days !== 30) {
  console.error('retention must be 30 days, got ' + days);
  process.exit(1);
}
console.log('ok');
`,
  'config/defaults.json': `{
  "retentionDays": 7,
  "archive": true
}
`,
  'config/site.json': `{
  "retentionDays": 7,
  "region": "eu"
}
`,
  'src/config/load.js': `const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function loadSettings(root) {
  const dir = join(root, 'config');
  const merged = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    Object.assign(merged, JSON.parse(readFileSync(join(dir, name), 'utf8')));
  }
  return merged;
}

module.exports = { loadSettings };
`,
  'src/retention.js': `const MIN_RETENTION_DAYS = 1;

function effectiveRetention(settings) {
  return Math.max(MIN_RETENTION_DAYS, settings.retentionDays);
}

module.exports = { effectiveRetention, MIN_RETENTION_DAYS };
`,
  'src/archive.js': `const { effectiveRetention } = require('./retention.js');

function shouldArchive(settings, ageDays) {
  return settings.archive === true && ageDays > effectiveRetention(settings);
}

module.exports = { shouldArchive };
`,
  'src/prune.js': `function prune(entries, keep) {
  return entries.slice(0, keep);
}

module.exports = { prune };
`,
  'src/schedule.js': `const HOURLY_MS = 60 * 60 * 1000;

function nextRun(from) {
  return from + HOURLY_MS;
}

module.exports = { nextRun, HOURLY_MS };
`,
  'src/report.js': `function summarise(settings) {
  return 'region=' + settings.region;
}

module.exports = { summarise };
`,
  '.eslintrc.json': LINT_CONFIG,
  'docs/operations.md': `# Operations runbook

## Rotating a profile

The deployment profile is reviewed every quarter. The steps below describe the
review, not the values themselves.

1. Open the review ticket
2. Confirm the profile owner
3. Record the outcome
`,
  'docs/configuration.md': `# Configuration notes

Configuration is written as JSON. This document describes the review process
for changing it and does not state which values are in force at runtime.
`,
};

const RETENTION_DEAD_DEFAULTS: Edit = { file: 'config/defaults.json', from: '"retentionDays": 7', to: '"retentionDays": 30' };
const RETENTION_DEAD_COERCE: Edit = {
  file: 'src/retention.js',
  from: 'Math.max(MIN_RETENTION_DAYS, settings.retentionDays)',
  to: 'Math.max(MIN_RETENTION_DAYS, Number(settings.retentionDays))',
};
const RETENTION_FIX: Edit = { file: 'config/site.json', from: '"retentionDays": 7', to: '"retentionDays": 30' };

const RETENTION_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import', expect: 'fail', tag: 'day1-broken' },
  { message: 'docs: operations runbook', expect: 'fail' },
  {
    message: 'fix(config): raise the retention default\n\nFirst attempt at the failing check.',
    files: { 'config/defaults.json': applyEdit(RETENTION_FILES['config/defaults.json']!, RETENTION_DEAD_DEFAULTS) },
    expect: 'fail',
  },
  {
    message: 'revert: raising the default did not change the effective value\n\nThe check still fails the same way.',
    files: { 'config/defaults.json': RETENTION_FILES['config/defaults.json']! },
    expect: 'fail',
  },
  {
    message: 'fix(retention): coerce the configured value\n\nSecond attempt at the failing check.',
    files: { 'src/retention.js': applyEdit(RETENTION_FILES['src/retention.js']!, RETENTION_DEAD_COERCE) },
    expect: 'fail',
  },
  {
    message: 'revert: coercing the value changed nothing\n\nStill failing.',
    files: { 'src/retention.js': RETENTION_FILES['src/retention.js']! },
    expect: 'fail',
  },
  {
    message: 'fix(config): line up the profile retention with the default\n\nThis is what fixed the failing check.',
    files: { 'config/site.json': applyEdit(RETENTION_FILES['config/site.json']!, RETENTION_FIX) },
    expect: 'pass',
  },
  { message: 'docs: configuration notes', expect: 'pass' },
  {
    message: 'chore(config): restore the shipped profile',
    files: { 'config/site.json': RETENTION_FILES['config/site.json']! },
    expect: 'fail',
  },
];

export const SHADOWED_CONFIG: V2Scenario = {
  name: 'shadowed-config',
  command: 'node check.js',
  deadEnds: [RETENTION_DEAD_DEFAULTS, RETENTION_DEAD_COERCE],
  fix: RETENTION_FIX,
  dayOneGreen: RETENTION_FIX,
  noiseFiles: ['.eslintrc.json'],
  primaryEndpoint: true,
  rediscoveryRoute:
    'edit config/defaults.json, re-run, observe the effective value did not move, then either read src/config/load.js or grep the key across the tree and find the second source merged after it',
  task: TASK,
  history: RETENTION_HISTORY,
  build: (dir) => buildRepo(dir, RETENTION_FILES, RETENTION_HISTORY),
  events: (repoDir, now) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'config/defaults.json', outcome: 'fail', errorSignature: 'retention must be 30 days, got 7', at: 0 },
        { file: 'src/retention.js', outcome: 'fail', errorSignature: 'retention must be 30 days, got 7', at: 10 },
        { file: 'config/site.json', outcome: 'ok', at: 20 },
      ],
      'eval-v2-day-1-config',
      now,
    ),
};

// ---------------------------------------------------------------------------
// 2. reverted-window -- adversarial on purpose. What ended day 1 green was
//    backed out days later for breaking something else, and the path was
//    rewired onto its own size. A system that repeats "this is what fixed it"
//    without qualification sends the agent to a file that is now inert. Both
//    halves are in git for every arm.
// ---------------------------------------------------------------------------

const BUCKET_DAY1 = `const { windowSize } = require('./window.js');

function bucketise(items) {
  const size = windowSize();
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = { bucketise };
`;

const BUCKET_TODAY = `const { windowSize } = require('./window.js');
const { pageSize } = require('./paging.js');

function estimate(items) {
  return Math.ceil(items.length / windowSize());
}

function bucketise(items) {
  const size = pageSize();
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = { bucketise, estimate };
`;

const WINDOW_FILES: Record<string, string> = {
  'check.js': `const { bucketise } = require('./src/bucket.js');

const got = JSON.stringify(bucketise([1, 2, 3, 4, 5, 6]));
if (got !== '[[1,2,3],[4,5,6]]') {
  console.error('bad buckets: ' + got);
  process.exit(1);
}
console.log('ok');
`,
  'src/bucket.js': BUCKET_DAY1,
  'src/window.js': `function windowSize() {
  return 2;
}

module.exports = { windowSize };
`,
  'src/digest.js': `const { windowSize } = require('./window.js');

function digest(items) {
  return items.length + '/' + windowSize();
}

module.exports = { digest };
`,
  'src/emit.js': `function emit(rows) {
  return rows.map((r) => String(r)).join(',');
}

module.exports = { emit };
`,
  'config/sizes.json': `{
  "bucket": 2,
  "page": 2
}
`,
  '.eslintrc.json': LINT_CONFIG,
  'docs/bucketing.md': `# Bucketing notes

Items are handed out in groups. This note records who owns the grouping
decision; it does not state the group size used at runtime.
`,
  'docs/sizes.md': `# Size review

Sizes are reviewed alongside the quarterly capacity plan. The review does not
change values on its own.
`,
};

const PAGING_MODULE = `function pageSize() {
  return 3;
}

module.exports = { pageSize };
`;

const WINDOW_DEAD_SIZES: Edit = { file: 'config/sizes.json', from: '"bucket": 2', to: '"bucket": 3' };
const WINDOW_DEAD_SLICE: Edit = {
  file: 'src/bucket.js',
  from: 'out.push(items.slice(i, i + size));',
  to: 'out.push(items.slice(i, i + size).filter(Boolean));',
};
/** Day 1's answer: widen the shared window. Reverted since, and inert today. */
const WINDOW_DAY_ONE: Edit = { file: 'src/window.js', from: '  return 2;', to: '  return 3;' };
const WINDOW_FIX: Edit = { file: 'src/paging.js', from: '  return 2;', to: '  return 3;' };

const WINDOW_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import', expect: 'fail', tag: 'day1-broken' },
  { message: 'docs: bucketing notes', expect: 'fail' },
  {
    message: 'fix(config): line up the bucket size\n\nFirst attempt at the failing check.',
    files: { 'config/sizes.json': applyEdit(WINDOW_FILES['config/sizes.json']!, WINDOW_DEAD_SIZES) },
    expect: 'fail',
  },
  {
    message: 'revert: the grouping path does not read that file\n\nThe check still fails the same way.',
    files: { 'config/sizes.json': WINDOW_FILES['config/sizes.json']! },
    expect: 'fail',
  },
  {
    message: 'fix(bucket): drop empty slices\n\nSecond attempt at the failing check.',
    files: { 'src/bucket.js': applyEdit(BUCKET_DAY1, WINDOW_DEAD_SLICE) },
    expect: 'fail',
  },
  {
    message: 'revert: dropping empty slices changed nothing\n\nStill failing.',
    files: { 'src/bucket.js': BUCKET_DAY1 },
    expect: 'fail',
  },
  {
    message: 'fix(window): widen the shared window to three\n\nThe check is green again with this.',
    files: { 'src/window.js': applyEdit(WINDOW_FILES['src/window.js']!, WINDOW_DAY_ONE) },
    expect: 'pass',
  },
  { message: 'docs: size review', expect: 'pass' },
  {
    message: 'revert: widening the shared window broke the digest job\n\nBacking this out. The check fails again and needs a different answer.',
    files: { 'src/window.js': WINDOW_FILES['src/window.js']! },
    expect: 'fail',
  },
  {
    message: 'fix(paging): give the grouping path its own size\n\nThis is the one that held.',
    files: { 'src/paging.js': PAGING_MODULE, 'src/bucket.js': BUCKET_TODAY },
    expect: 'pass',
  },
  {
    message: 'refactor(paging): fold the size back to the shared default',
    files: { 'src/paging.js': PAGING_MODULE.replace('  return 3;', '  return 2;') },
    expect: 'fail',
  },
];

export const REVERTED_WINDOW: V2Scenario = {
  name: 'reverted-window',
  command: 'node check.js',
  deadEnds: [WINDOW_DEAD_SIZES, WINDOW_DEAD_SLICE],
  fix: WINDOW_FIX,
  dayOneGreen: WINDOW_DAY_ONE,
  staleTrap: WINDOW_DAY_ONE,
  noiseFiles: ['.eslintrc.json'],
  primaryEndpoint: true,
  rediscoveryRoute:
    'read src/bucket.js, see which of the two sizes the grouping path actually calls, and follow that import rather than the one the older module still uses',
  task: TASK,
  history: WINDOW_HISTORY,
  build: (dir) => buildRepo(dir, WINDOW_FILES, WINDOW_HISTORY),
  events: (repoDir, now) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'config/sizes.json', outcome: 'fail', errorSignature: 'bad buckets: [[1,2],[3,4],[5,6]]', at: 0 },
        { file: 'src/bucket.js', outcome: 'fail', errorSignature: 'bad buckets: [[1,2],[3,4],[5,6]]', at: 10 },
        { file: 'src/window.js', outcome: 'ok', at: 20 },
      ],
      'eval-v2-day-1-window',
      now,
    ),
};

// ---------------------------------------------------------------------------
// 3. unrelated-history -- the null case. Memory exists and is rich, and none
//    of it bears on the task. Nothing here should help; the question is only
//    whether delivery costs the ambient arm anything. Excluded from the
//    primary endpoint by construction: it seeds no dead end.
// ---------------------------------------------------------------------------

const TOTAL_FILES: Record<string, string> = {
  'check.js': `const { total } = require('./src/total.js');

const got = total([{ amount: 3 }, { amount: 4 }, { amount: 5 }]);
if (got !== 12) {
  console.error('bad total: ' + got);
  process.exit(1);
}
console.log('ok');
`,
  'src/total.js': `function total(rows) {
  return rows.map((r) => String(r.amount)).reduce((a, b) => a + b, '');
}

module.exports = { total };
`,
  'src/format.js': `const { suffixFor } = require('./locale.js');

function format(value, locale) {
  return String(value) + suffixFor(locale);
}

module.exports = { format };
`,
  'src/locale.js': `const SUFFIXES = { en: '', eu: ' EUR' };

function suffixFor(locale) {
  return SUFFIXES[locale] ?? '';
}

module.exports = { suffixFor, SUFFIXES };
`,
  'tools/report.js': `const { format } = require('../src/format.js');

process.stdout.write(format(42, process.argv[2] ?? 'en') + '\\n');
`,
  '.eslintrc.json': LINT_CONFIG,
  'docs/totals.md': `# Totals

Totals are produced for the monthly statement. This note describes who signs
the statement off.
`,
};

const TOTAL_FIX: Edit = {
  file: 'src/total.js',
  from: `rows.map((r) => String(r.amount)).reduce((a, b) => a + b, '')`,
  to: `rows.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0)`,
};

const TOTAL_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import', expect: 'fail', tag: 'day1-broken' },
  { message: 'docs: totals', expect: 'fail' },
  { message: 'fix(format): pad the locale suffix', expect: 'fail' },
  { message: 'chore(locale): add the eu profile', expect: 'fail' },
  { message: 'refactor(total): fold the row mapping', expect: 'fail' },
];

export const UNRELATED_HISTORY: V2Scenario = {
  name: 'unrelated-history',
  command: 'node check.js',
  deadEnds: [],
  fix: TOTAL_FIX,
  noiseFiles: ['src/format.js', 'src/locale.js', '.eslintrc.json'],
  primaryEndpoint: false,
  rediscoveryRoute: 'read src/total.js, which the failing output points at by value, and make the accumulation numeric',
  task: TASK,
  history: TOTAL_HISTORY,
  build: (dir) => buildRepo(dir, TOTAL_FILES, TOTAL_HISTORY),
  events: (repoDir, now) =>
    agentEvents(
      repoDir,
      'node tools/report.js eu',
      [
        { file: 'src/format.js', outcome: 'fail', errorSignature: 'TypeError: suffixFor is not a function', at: 0 },
        { file: 'src/locale.js', outcome: 'fail', errorSignature: 'TypeError: suffixFor is not a function', at: 10 },
        { file: 'src/format.js', outcome: 'ok', at: 20 },
      ],
      'eval-v2-day-1-report',
      now,
    ),
};

export const V2_SCENARIOS: readonly V2Scenario[] = [SHADOWED_CONFIG, REVERTED_WINDOW, UNRELATED_HISTORY];

/** Files a run cannot touch without repeating something the seeded history disproved. */
export const deadEndFiles = (s: V2Scenario): string[] => s.deadEnds.map((e) => e.file);
