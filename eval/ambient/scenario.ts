import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawAgentEvent } from '../../src/agent/event.js';

/**
 * The fixtures the ambient-memory eval runs against.
 *
 * Each one encodes the story the real tester said they would miss: a failure
 * was hit before, two approaches were tried and abandoned, a third fixed it,
 * and now something very like it is back.
 *
 * Every arm gets the same repository. Where an abandoned attempt is recorded
 * matters and differs per scenario -- in git for one, only in the agent's own
 * event log for the others -- but in every case the fix itself is reachable
 * from `git log`, so a baseline session is never deprived of the answer. What
 * differs between arms is whether anything puts it in front of the model
 * without being asked.
 *
 * Nothing here names memory, NexusMem, or the fix, in a filename, a task, or
 * a commit message.
 */

export interface Scenario {
  name: string;
  /** The command the agent is asked to fix, and which scoring re-runs. */
  command: string;
  /** The two files past attempts already proved do not fix this. Editing one is a repeated dead end. */
  deadEndA: string;
  deadEndB: string;
  /** The file that actually fixes it today. */
  fixFile: string;
  /** The file the day-1 session was green after editing. What memory can legitimately name. */
  day1FixFile: string;
  /**
   * A file the history points at that is the wrong answer now: an approach
   * that was later reverted, or a sibling that was fixed on the earlier day
   * and is already correct. Editing it is a memory-attributable detour.
   */
  staleFile?: string;
  task: string;
  build(dir: string): void;
  /** Day-1 agent attempts, before redaction, as the adapter would hand them over. */
  events(repoDir: string): RawAgentEvent[];
}

interface Commit {
  message: string;
  files?: Record<string, string>;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Eval',
  GIT_AUTHOR_EMAIL: 'eval@example.com',
  GIT_COMMITTER_NAME: 'Eval',
  GIT_COMMITTER_EMAIL: 'eval@example.com',
};

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, stdio: 'ignore' });
}

function write(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function buildRepo(dir: string, files: Record<string, string>, history: readonly Commit[]): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  // The fixture has to be byte-identical wherever the eval runs: with the
  // machine's autocrlf, a checkout of an earlier commit rewrites every file
  // with CRLF and the same scenario stops being the same scenario.
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.eol', 'lf');
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  for (const commit of history) {
    for (const [path, content] of Object.entries(commit.files ?? {})) write(dir, path, content);
    git(dir, 'add', '.');
    // --allow-empty: the distractor commits carry a message and no change, which is the point of them.
    git(dir, 'commit', '-q', '--allow-empty', '--no-verify', '-m', commit.message);
  }
}

/** One day-1 attempt: the file it edited, then the command's result. */
interface Attempt {
  file: string;
  outcome: 'ok' | 'fail';
  errorSignature?: string;
  /** Minutes after the start of day 1. */
  at: number;
}

/**
 * The event log the hook would have written on the day this was first worked
 * on, plus two failure chains that have nothing to do with it. The unrelated
 * ones are not padding: they are the only way to measure whether recall and
 * the session digest stay on topic, and one of them is deliberately left
 * unresolved so the digest has something irrelevant it could name.
 */
function agentEvents(repoDir: string, command: string, attempts: readonly Attempt[], sessionId: string): RawAgentEvent[] {
  const daysAgo = 7;
  const at = (minutes: number) => new Date(Date.now() - (daysAgo * 24 * 60 - minutes) * 60_000).toISOString();
  const base = { agent: 'claude-code', sessionId, cwd: repoDir, durationMs: 1500 };

  const events: RawAgentEvent[] = [];
  let n = 0;
  for (const attempt of attempts) {
    n += 1;
    events.push({ ...base, eventId: `e${n}a`, ts: at(attempt.at), kind: 'edit', filePath: join(repoDir, attempt.file), outcome: 'ok', exitCode: null });
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

  // Unrelated chain 1: failed, then fixed. Must never be recalled for the
  // command above. It carries a fake credential so the eval's pre-flight has
  // something real to assert the redaction path against.
  const other = 'npm run lint --token=ghp_evalF4keToken0123456789abcd';
  events.push({ ...base, eventId: 'x1', ts: at(200), kind: 'edit', filePath: join(repoDir, '.eslintrc.json'), outcome: 'ok', exitCode: null });
  events.push({
    ...base,
    eventId: 'x2',
    ts: at(201),
    kind: 'command',
    command: other,
    outcome: 'fail',
    exitCode: 1,
    errorSignature: 'Parsing error: Unexpected token',
  });
  events.push({ ...base, eventId: 'x3', ts: at(210), kind: 'command', command: other, outcome: 'ok', exitCode: 0 });

  // Unrelated chain 2: still unresolved, so the session digest has something off-topic it could name.
  const stillBroken = 'npm run typecheck';
  events.push({
    ...base,
    eventId: 'x4',
    ts: at(300),
    kind: 'command',
    command: stillBroken,
    outcome: 'fail',
    exitCode: 2,
    errorSignature: 'error TS2345: Argument of type string is not assignable',
  });

  return events;
}

// ---------------------------------------------------------------------------
// 1. retry-regression -- both abandoned attempts are in git, as commits with
//    their reverts. The most generous baseline there is: `git log` carries
//    every fact memory has.
// ---------------------------------------------------------------------------

const RETRY_FILES: Record<string, string> = {
  'check.js': `const { parseConfig } = require('./src/parse.js');
const { withRetry } = require('./src/retry.js');
const { log } = require('./src/logging.js');

const raw = { retry_count: 3, timeout_ms: 250, endpoint: 'https://example.invalid' };
const config = parseConfig(raw);

log('starting with ' + config.retryCount + ' retries');
withRetry(config, () => true);
console.log('ok');
`,
  // The bug: parse.js reads a key the config does not have, so retryCount is
  // undefined and retry.js throws on .toFixed. Exactly the shape that was
  // fixed once before and has regressed.
  'src/parse.js': `function parseConfig(raw) {
  return {
    retryCount: raw.retries,
    timeoutMs: raw.timeout_ms,
    endpoint: raw.endpoint,
  };
}

module.exports = { parseConfig };
`,
  'src/retry.js': `function withRetry(config, fn) {
  const budget = config.retryCount.toFixed(0);
  for (let attempt = 0; attempt < Number(budget); attempt += 1) {
    if (fn()) return true;
  }
  return false;
}

module.exports = { withRetry };
`,
  'src/logging.js': `function log(message) {
  process.stdout.write('[app] ' + message + '\\n');
}

module.exports = { log };
`,
  'docs/runbook.md': `# Runbook

## Deployment steps

Follow these steps in order. Each of the steps below has been reviewed.

1. Build the bundle
2. Parse the release notes
3. Ship it
`,
  'docs/parsing.md': `# Parsing notes

The parse steps here are unrelated to runtime config parsing; they describe
how release notes are parsed for the changelog.
`,
};

const RETRY_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import' },
  { message: 'docs: describe the deployment steps' },
  {
    message: 'fix(retry): raise the retry budget so the check stops failing\n\nFirst attempt at the failing check.',
    files: { 'src/retry.js': RETRY_FILES['src/retry.js']!.replace('attempt < Number(budget)', 'attempt < Number(budget) + 2') },
  },
  {
    message: 'revert: raising the retry budget did not fix the failing check\n\nThe check still fails the same way.',
    files: { 'src/retry.js': RETRY_FILES['src/retry.js']! },
  },
  {
    message: 'fix(logging): guard the log call blamed for the failing check\n\nSecond attempt at the failing check.',
    files: { 'src/logging.js': `function log(message) {\n  try {\n    process.stdout.write('[app] ' + message + '\\n');\n  } catch {}\n}\n\nmodule.exports = { log };\n` },
  },
  {
    message: 'revert: guarding the log call only hid the failing check\n\nStill failing.',
    files: { 'src/logging.js': RETRY_FILES['src/logging.js']! },
  },
  {
    message: 'fix(parse): read retry_count, the key the config actually uses\n\nThis is what fixed the failing check.',
    files: { 'src/parse.js': RETRY_FILES['src/parse.js']!.replace('raw.retries', 'raw.retry_count') },
  },
  { message: 'docs: note the parse steps used for release notes' },
  // The regression: the fix is undone again, which is where the agent comes in.
  {
    message: 'refactor(parse): simplify config mapping',
    files: { 'src/parse.js': RETRY_FILES['src/parse.js']! },
  },
];

export const RETRY_REGRESSION: Scenario = {
  name: 'retry-regression',
  command: 'node check.js',
  deadEndA: 'src/retry.js',
  deadEndB: 'src/logging.js',
  fixFile: 'src/parse.js',
  day1FixFile: 'src/parse.js',
  task: '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.',
  build: (dir) => buildRepo(dir, RETRY_FILES, RETRY_HISTORY),
  events: (repoDir) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'src/retry.js', outcome: 'fail', errorSignature: "TypeError: Cannot read properties of undefined (reading 'toFixed')", at: 0 },
        { file: 'src/logging.js', outcome: 'fail', errorSignature: "TypeError: Cannot read properties of undefined (reading 'toFixed')", at: 10 },
        { file: 'src/parse.js', outcome: 'ok', at: 20 },
      ],
      'eval-day-1',
    ),
};

// ---------------------------------------------------------------------------
// 2. lost-writes -- the abandoned attempts exist ONLY in the agent's event
//    log, which is the realistic case: an agent that edits a file, runs the
//    check, sees it fail and reverts leaves nothing in git. The fix is still
//    in git, as the commit that fixed the same mistake in a sibling module,
//    so the baseline can find the answer; it just cannot know what was tried.
//    Day 7 is the same mistake in a different file, not the same file again.
// ---------------------------------------------------------------------------

const READER_BUGGY = `const { persist } = require('./io.js');

class ReadBuffer {
  constructor(sources) {
    this.sources = sources;
  }

  async load() {
    let read = 0;
    this.sources.forEach(async (source) => {
      await persist(source);
      read += 1;
    });
    return read;
  }
}

module.exports = { ReadBuffer };
`;

const READER_FIXED = READER_BUGGY.replace(
  `    this.sources.forEach(async (source) => {
      await persist(source);
      read += 1;
    });`,
  `    for (const source of this.sources) {
      await persist(source);
      read += 1;
    }`,
);

const WRITES_FILES: Record<string, string> = {
  'check.js': `const { WriteBuffer } = require('./src/writer.js');

(async () => {
  const buffer = new WriteBuffer(['alpha', 'beta', 'gamma']);
  const written = await buffer.commit();
  if (written !== 3) {
    console.error('expected 3 records committed, got ' + written);
    process.exit(1);
  }
  console.log('ok');
})();
`,
  'src/io.js': `async function persist(record) {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return record.length;
}

module.exports = { persist };
`,
  // The bug: an async callback handed to forEach is never waited on, so the
  // counter is read before any of them has run. Same mistake reader.js had.
  'src/writer.js': `const { persist } = require('./io.js');

class WriteBuffer {
  constructor(records) {
    this.records = records;
  }

  async commit() {
    let written = 0;
    this.records.forEach(async (record) => {
      await persist(record);
      written += 1;
    });
    return written;
  }
}

module.exports = { WriteBuffer };
`,
  // Starts with the same mistake; the fix commit below is what corrects it.
  'src/reader.js': READER_BUGGY,
  'src/timeouts.js': `const FLUSH_TIMEOUT_MS = 250;
const CONNECT_TIMEOUT_MS = 1000;

module.exports = { FLUSH_TIMEOUT_MS, CONNECT_TIMEOUT_MS };
`,
  'src/retrypolicy.js': `function shouldRetry(attempt) {
  return attempt < 3;
}

module.exports = { shouldRetry };
`,
  'docs/writer-style.md': `# Writer style guide

Naming, comment style and file layout for anything under src/. Nothing here
describes runtime behaviour.
`,
};

const WRITES_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import' },
  { message: 'docs: writer style guide' },
  { message: 'perf(timeouts): raise the flush timeout for slow disks' },
  {
    message:
      'fix(reader): await each source in a loop\n\nforEach with an async callback returns before any callback has run, so the\ncounter was read as 0 while the work was still in flight.',
    files: { 'src/reader.js': READER_FIXED },
  },
  { message: 'chore(retrypolicy): keep the attempt ceiling at three' },
  { message: 'docs: writer style guide, second pass' },
];

export const LOST_WRITES: Scenario = {
  name: 'lost-writes',
  command: 'node check.js',
  deadEndA: 'src/timeouts.js',
  deadEndB: 'src/retrypolicy.js',
  fixFile: 'src/writer.js',
  day1FixFile: 'src/reader.js',
  // reader.js is already correct; editing it is following the memory to the wrong file.
  staleFile: 'src/reader.js',
  task: '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.',
  build: (dir) => buildRepo(dir, WRITES_FILES, WRITES_HISTORY),
  events: (repoDir) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'src/timeouts.js', outcome: 'fail', errorSignature: 'expected 3 records committed, got 0', at: 0 },
        { file: 'src/retrypolicy.js', outcome: 'fail', errorSignature: 'expected 3 records committed, got 0', at: 10 },
        { file: 'src/reader.js', outcome: 'ok', at: 20 },
      ],
      'eval-day-1-writes',
    ),
};

// ---------------------------------------------------------------------------
// 3. stale-fix -- adversarial on purpose. What fixed this once was reverted
//    days later for breaking something else, and a different file carries the
//    real fix. Memory knows the first answer and not the revert, so a system
//    that repeats "this is what fixed it" without qualification should send
//    the agent to the wrong file. Both halves are in git for every arm.
// ---------------------------------------------------------------------------

const STALE_FILES: Record<string, string> = {
  'check.js': `const { encodeRecord } = require('./src/encode.js');

const out = encodeRecord({ id: 7, tags: ['a', 'b'] });
if (out !== 'id=7;tags=a,b') {
  console.error('bad encoding: ' + out);
  process.exit(1);
}
console.log('ok');
`,
  // The bug: fields are joined with the same character that separates tags.
  // At this point in history the separator still comes from serialize.js.
  'src/encode.js': `const { serializeTags, fieldSeparator } = require('./serialize.js');

function encodeRecord(record) {
  const fields = ['id=' + record.id, 'tags=' + serializeTags(record.tags)];
  return fields.join(fieldSeparator());
}

module.exports = { encodeRecord };
`,
  'src/serialize.js': `function serializeTags(tags) {
  return tags.join(',');
}

function fieldSeparator() {
  return ',';
}

module.exports = { serializeTags, fieldSeparator };
`,
  'src/cache.js': `const entries = new Map();

function remember(key, value) {
  entries.set(key, value);
  return value;
}

module.exports = { remember };
`,
  'src/clock.js': `function now() {
  return Date.now();
}

module.exports = { now };
`,
  'docs/format.md': `# Record format

Records are a list of fields. The tag list inside a field is its own list.
Both are written as text; the document does not say which characters are used.
`,
};

/** The day-1 answer: change the separator serialize.js hands out. Genuinely green at the time. */
const STALE_SERIALIZE_SEMICOLON = STALE_FILES['src/serialize.js']!.replace(
  `function fieldSeparator() {
  return ',';
}`,
  `function fieldSeparator() {
  return ';';
}`,
);

/** The answer that held: encode.js stops asking serialize.js and states the separator itself. */
const STALE_ENCODE_FIXED = `const { serializeTags } = require('./serialize.js');

function encodeRecord(record) {
  const fields = ['id=' + record.id, 'tags=' + serializeTags(record.tags)];
  return fields.join(';');
}

module.exports = { encodeRecord };
`;

/**
 * The state the agent finds. `fieldSeparator` is still exported and no longer
 * called by anything, so the day-1 answer can still be applied and will now
 * change nothing at all.
 */
const STALE_ENCODE_REGRESSED = STALE_ENCODE_FIXED.replace("fields.join(';')", "fields.join(',')");

const STALE_HISTORY: readonly Commit[] = [
  { message: 'chore: initial import' },
  { message: 'docs: describe the record format' },
  {
    message: 'fix(serialize): hand out ";" as the field separator so the check passes\n\nThe check is green again with this.',
    files: { 'src/serialize.js': STALE_SERIALIZE_SEMICOLON },
  },
  { message: 'chore(cache): drop an unused entry helper' },
  {
    message:
      'revert: changing the shared separator broke unicode payloads\n\nBacking this out. The check fails again and needs a different answer.',
    files: { 'src/serialize.js': STALE_FILES['src/serialize.js']! },
  },
  {
    message: 'fix(encode): state the field separator here instead of sharing one\n\nThis is the one that held.',
    files: { 'src/encode.js': STALE_ENCODE_FIXED },
  },
  { message: 'style(serialize): tidy the key ordering' },
  // The regression: field assembly is rewritten and loses the separator again.
  {
    message: 'refactor(encode): tidy field assembly',
    files: { 'src/encode.js': STALE_ENCODE_REGRESSED },
  },
];

export const STALE_FIX: Scenario = {
  name: 'stale-fix',
  command: 'node check.js',
  deadEndA: 'src/cache.js',
  deadEndB: 'src/clock.js',
  fixFile: 'src/encode.js',
  day1FixFile: 'src/serialize.js',
  staleFile: 'src/serialize.js',
  task: '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.',
  build: (dir) => buildRepo(dir, STALE_FILES, STALE_HISTORY),
  events: (repoDir) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'src/cache.js', outcome: 'fail', errorSignature: 'bad encoding: id=7,tags=a,b', at: 0 },
        { file: 'src/clock.js', outcome: 'fail', errorSignature: 'bad encoding: id=7,tags=a,b', at: 10 },
        { file: 'src/serialize.js', outcome: 'ok', at: 20 },
      ],
      'eval-day-1-stale',
    ),
};

export const SCENARIOS: readonly Scenario[] = [RETRY_REGRESSION, LOST_WRITES, STALE_FIX];

/** Kept for `tests/agent-retrieval-quality.test.ts`, which asserts against this fixture's history. */
export function buildScenarioRepo(dir: string): void {
  RETRY_REGRESSION.build(dir);
}
