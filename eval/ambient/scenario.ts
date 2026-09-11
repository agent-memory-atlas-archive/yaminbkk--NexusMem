import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../src/core/ids.js';

/**
 * The fixture the ambient-memory eval runs against.
 *
 * The story it encodes is the one the real tester said they would miss: a
 * failure was hit before, two approaches were tried and abandoned, a third
 * fixed it, and now the same failure is back.
 *
 * Every arm gets the same repository, including the git history that records
 * both abandoned attempts. A baseline session can read that history with
 * `git log`, so memory is not being handed an advantage the baseline lacks --
 * the question the eval asks is whether the agent *uses* it without being
 * told to look.
 */

export interface Scenario {
  name: string;
  /** The command the agent is asked to fix, and which scoring re-runs. */
  command: string;
  /** Files a past attempt already proved do not fix this. Editing one is a repeated dead end. */
  deadEndFiles: string[];
  /** The file that actually fixes it. */
  fixFile: string;
  task: string;
}

export const RETRY_REGRESSION: Scenario = {
  name: 'retry-regression',
  command: 'node check.js',
  deadEndFiles: ['src/retry.js', 'src/logging.js'],
  fixFile: 'src/parse.js',
  task: '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.',
};

const FILES: Record<string, string> = {
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

interface Commit {
  message: string;
  files?: Record<string, string>;
}

/**
 * History a normal session can read. The two abandoned attempts are recorded
 * as commits, which is the fair baseline: the information exists in the repo,
 * just not in a form anything surfaces on its own.
 */
const HISTORY: Commit[] = [
  { message: 'chore: initial import' },
  { message: 'docs: describe the deployment steps' },
  {
    message: 'fix(retry): raise the retry budget so the check stops failing\n\nFirst attempt at the failing check.',
    files: { 'src/retry.js': FILES['src/retry.js']!.replace('attempt < Number(budget)', 'attempt < Number(budget) + 2') },
  },
  {
    message: 'revert: raising the retry budget did not fix the failing check\n\nThe check still fails the same way.',
    files: { 'src/retry.js': FILES['src/retry.js']! },
  },
  {
    message: 'fix(logging): guard the log call blamed for the failing check\n\nSecond attempt at the failing check.',
    files: { 'src/logging.js': `function log(message) {\n  try {\n    process.stdout.write('[app] ' + message + '\\n');\n  } catch {}\n}\n\nmodule.exports = { log };\n` },
  },
  {
    message: 'revert: guarding the log call only hid the failing check\n\nStill failing.',
    files: { 'src/logging.js': FILES['src/logging.js']! },
  },
  {
    message: 'fix(parse): read retry_count, the key the config actually uses\n\nThis is what fixed the failing check.',
    files: { 'src/parse.js': FILES['src/parse.js']!.replace('raw.retries', 'raw.retry_count') },
  },
  { message: 'docs: note the parse steps used for release notes' },
  // The regression: the fix is undone again, which is where the agent comes in.
  {
    message: 'refactor(parse): simplify config mapping',
    files: { 'src/parse.js': FILES['src/parse.js']! },
  },
];

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

/** Builds the repository, with the history above, ending in the regressed state. */
export function buildScenarioRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');

  for (const [path, content] of Object.entries(FILES)) write(dir, path, content);

  for (const commit of HISTORY) {
    for (const [path, content] of Object.entries(commit.files ?? {})) write(dir, path, content);
    git(dir, 'add', '.');
    // --allow-empty: the distractor commits carry a message and no change, which is the point of them.
    git(dir, 'commit', '-q', '--allow-empty', '-m', commit.message);
  }
}

/**
 * The agent attempts NexusMem would have captured on the day this was first
 * fixed: two runs that failed after editing a file that was not the cause,
 * then the run that passed after editing the file that was.
 */
export function seedAgentEvents(repoDir: string, minutesAgoBase = 60 * 24 * 7): object[] {
  const at = (offset: number) => new Date(Date.now() - (minutesAgoBase - offset) * 60_000).toISOString();
  const base = { agent: 'claude-code', sessionId: 'eval-day-1', cwd: repoDir, durationMs: 1500 };

  return [
    { ...base, eventId: 'e1', ts: at(0), kind: 'edit', filePath: join(repoDir, 'src/retry.js'), outcome: 'ok', exitCode: null },
    {
      ...base,
      eventId: 'e2',
      ts: at(1),
      kind: 'command',
      command: RETRY_REGRESSION.command,
      commandHash: sha256Hex(RETRY_REGRESSION.command).slice(0, 12),
      outcome: 'fail',
      exitCode: 1,
      errorSignature: "TypeError: Cannot read properties of undefined (reading 'toFixed')",
    },
    { ...base, eventId: 'e3', ts: at(10), kind: 'edit', filePath: join(repoDir, 'src/logging.js'), outcome: 'ok', exitCode: null },
    {
      ...base,
      eventId: 'e4',
      ts: at(11),
      kind: 'command',
      command: RETRY_REGRESSION.command,
      commandHash: sha256Hex(RETRY_REGRESSION.command).slice(0, 12),
      outcome: 'fail',
      exitCode: 1,
      errorSignature: "TypeError: Cannot read properties of undefined (reading 'toFixed')",
    },
    { ...base, eventId: 'e5', ts: at(20), kind: 'edit', filePath: join(repoDir, 'src/parse.js'), outcome: 'ok', exitCode: null },
    {
      ...base,
      eventId: 'e6',
      ts: at(21),
      kind: 'command',
      command: RETRY_REGRESSION.command,
      commandHash: sha256Hex(RETRY_REGRESSION.command).slice(0, 12),
      outcome: 'ok',
      exitCode: 0,
    },
  ];
}
