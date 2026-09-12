import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, type Scenario } from './scenario.js';

/**
 * Checks the eval fixtures say what they claim, before any model runs against
 * them. A scenario whose check already passes, or whose "fix" does not fix it,
 * would produce numbers that mean nothing.
 *
 * Four claims per scenario:
 *   1. the command fails in the state the agent is handed
 *   2. applying the fix file's known correction makes it pass
 *   3. every commit whose message claims the check is green really is green
 *   4. the stale answer, where there is one, does not fix it today
 *
 *   npx tsx eval/ambient/verify-fixtures.ts
 */

/** How each scenario's fix file is corrected, and what the day-1 answer would do today. */
const CORRECTIONS: Record<string, { fix: [string, string]; stale?: [string, string] }> = {
  'retry-regression': { fix: ['raw.retries', 'raw.retry_count'] },
  'lost-writes': {
    fix: [
      `    this.records.forEach(async (record) => {
      await persist(record);
      written += 1;
    });`,
      `    for (const record of this.records) {
      await persist(record);
      written += 1;
    }`,
    ],
    // reader.js is already correct, so the day-1 answer is a no-op edit today.
    stale: ['for (const source of this.sources) {', 'for (const source of this.sources) {'],
  },
  'stale-fix': {
    fix: [`fields.join(',')`, `fields.join(';')`],
    stale: [
      `function fieldSeparator() {
  return ',';
}`,
      `function fieldSeparator() {
  return ';';
}`,
    ],
  },
};

function passes(dir: string, command: string): boolean {
  const [exe, ...rest] = command.split(' ');
  return spawnSync(exe!, rest, { cwd: dir, encoding: 'utf8' }).status === 0;
}

function apply(dir: string, file: string, [from, to]: [string, string]): void {
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  if (!before.includes(from)) throw new Error(`${file}: correction anchor not found`);
  writeFileSync(path, before.replace(from, to), 'utf8');
}

/** Every commit whose message says the check is green: check it out and run it. Returns [problems, checked]. */
function greenCommitsAreGreen(dir: string, scenario: Scenario): [string[], number] {
  const log = execFileSync('git', ['-C', dir, 'log', '--reverse', '--format=%H%x1f%s%x1f%b%x1e'], { encoding: 'utf8' });
  const problems: string[] = [];
  let checked = 0;
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  for (const entry of log.split('\x1e')) {
    const [hash, subject, body] = entry.trim().split('\x1f');
    if (!hash || !subject) continue;
    const claimsGreen = /is green|check passes|the one that held|what fixed/i.test(`${subject}\n${body ?? ''}`);
    const claimsRed = /fails again|still fails|did not fix|only hid/i.test(`${subject}\n${body ?? ''}`);
    if (!claimsGreen && !claimsRed) continue;

    execFileSync('git', ['-C', dir, 'checkout', '-q', hash]);
    checked += 1;
    const green = passes(dir, scenario.command);
    if (claimsGreen && !green) problems.push(`${hash.slice(0, 7)} claims green but the check fails: ${subject}`);
    if (claimsRed && green) problems.push(`${hash.slice(0, 7)} claims red but the check passes: ${subject}`);
  }
  execFileSync('git', ['-C', dir, 'checkout', '-q', head]);
  return [problems, checked];
}

function verify(scenario: Scenario): { problems: string[]; commitsChecked: number } {
  const problems: string[] = [];
  let commitsChecked = 0;
  const dir = mkdtempSync(join(tmpdir(), `nexusmem-fixture-${scenario.name}-`));
  try {
    scenario.build(dir);

    if (passes(dir, scenario.command)) problems.push('the command already passes in the state the agent is handed');
    const [historyProblems, checked] = greenCommitsAreGreen(dir, scenario);
    problems.push(...historyProblems);
    commitsChecked = checked;

    const correction = CORRECTIONS[scenario.name];
    if (!correction) {
      problems.push('no correction recorded for this scenario');
      return { problems, commitsChecked };
    }

    // The stale answer must not be a way to pass, or the trap is not a trap.
    if (correction.stale && scenario.staleFile) {
      apply(dir, scenario.staleFile, correction.stale);
      if (passes(dir, scenario.command)) problems.push(`applying the day-1 answer to ${scenario.staleFile} still fixes it today`);
      execFileSync('git', ['-C', dir, 'checkout', '-q', '--', scenario.staleFile]);
    }

    apply(dir, scenario.fixFile, correction.fix);
    if (!passes(dir, scenario.command)) problems.push(`correcting ${scenario.fixFile} does not make the command pass`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { problems, commitsChecked };
}

let failed = false;
for (const scenario of SCENARIOS) {
  const { problems, commitsChecked } = verify(scenario);
  process.stdout.write(
    `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name.padEnd(18)} ${commitsChecked} history claim(s) re-run\n`,
  );
  for (const problem of problems) process.stdout.write(`       ${problem}\n`);
  failed ||= problems.length > 0;
}
process.exit(failed ? 1 : 0);
