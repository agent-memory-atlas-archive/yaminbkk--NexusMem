import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { applyEdit, type Edit } from './fixture.js';
import { UNRELATED_COMMANDS, V2_SCENARIOS, type V2Scenario } from './scenario.js';

/**
 * Proves each harder-eval fixture is internally truthful before any model runs
 * against it. A scenario whose "already failed" approach would in fact have
 * worked, or whose task text names the answer, produces numbers that mean
 * nothing.
 *
 *   npx tsx eval/ambient-v2/verify-fixtures.ts
 */

export function passes(dir: string, command: string): boolean {
  const [exe, ...rest] = command.split(' ');
  return spawnSync(exe!, rest, { cwd: dir, encoding: 'utf8' }).status === 0;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** Applies an edit to the working tree, runs the check, then restores the file. */
export function passesWith(dir: string, command: string, edit: Edit): boolean {
  const path = join(dir, edit.file);
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, applyEdit(before, edit), 'utf8');
  try {
    return passes(dir, command);
  } finally {
    writeFileSync(path, before, 'utf8');
  }
}

/** Every commit, checked out and re-run against the expectation it declares. */
function historyIsTruthful(dir: string, scenario: V2Scenario): { problems: string[]; day1: string | null } {
  const hashes = git(dir, 'log', '--reverse', '--format=%H').trim().split('\n');
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  const problems: string[] = [];
  let day1: string | null = null;

  if (hashes.length !== scenario.history.length) {
    problems.push(`history has ${hashes.length} commits but ${scenario.history.length} expectations`);
    return { problems, day1 };
  }

  hashes.forEach((hash, i) => {
    const commit = scenario.history[i]!;
    if (commit.tag === 'day1-broken') day1 = hash;
    git(dir, 'checkout', '-q', hash);
    const green = passes(dir, scenario.command);
    if (green !== (commit.expect === 'pass')) {
      problems.push(
        `${hash.slice(0, 7)} declares ${commit.expect} but the check ${green ? 'passes' : 'fails'}: ${commit.message.split('\n')[0]}`,
      );
    }
  });
  git(dir, 'checkout', '-q', head);
  return { problems, day1 };
}

/** The task, the scenario name and the tree must not hand the answer over. */
function leakage(dir: string, scenario: V2Scenario): string[] {
  const problems: string[] = [];
  const answer = scenario.fix.file.split('/').pop()!.replace(/\.(js|json)$/, '');
  for (const [where, text] of [
    ['the task text', scenario.task],
    ['the scenario name', scenario.name],
  ] as const) {
    if (text.toLowerCase().includes(answer.toLowerCase())) problems.push(`${where} contains "${answer}", the file to change`);
    if (/nexusmem|memory|recall|previous attempt|failed before/i.test(text)) problems.push(`${where} mentions the benchmark mechanism`);
  }
  if (scenario.task.includes(scenario.fix.to)) problems.push('the task text contains the change itself');

  for (const edit of scenario.deadEnds) {
    try {
      statSync(join(dir, edit.file));
    } catch {
      problems.push(`${edit.file} does not exist, so it cannot be a dead end`);
    }
  }

  const subjects = git(dir, 'log', '--format=%s').trim().split('\n');
  const touchingFix = git(dir, 'log', '--format=%h', '--', scenario.fix.file).trim().split('\n').filter(Boolean);
  if (subjects.length - touchingFix.length < 3) problems.push('fewer than three commits that do not touch the file to change');

  const docs = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'));
  if (docs.length === 0) problems.push('no documentation distractor');
  return problems;
}

/** The seeded log must carry what the scenario claims, and no more. */
function eventsAreIntended(dir: string, scenario: V2Scenario): string[] {
  const problems: string[] = [];
  const events = scenario.events(dir, Date.UTC(2026, 0, 2));
  const edited = events.filter((e) => e.kind === 'edit').map((e) => relative(dir, e.filePath ?? '').split('\\').join('/'));
  for (const edit of scenario.deadEnds) {
    if (!edited.includes(edit.file)) problems.push(`the day-1 log never records the dead end ${edit.file}`);
  }
  if (scenario.dayOneGreen && !edited.includes(scenario.dayOneGreen.file)) {
    problems.push(`the day-1 log never records what day 1 ended green on (${scenario.dayOneGreen.file})`);
  }

  const commands = events.filter((e) => e.kind === 'command');
  const own = commands.filter((e) => e.command === scenario.command);
  if (scenario.primaryEndpoint) {
    if (own.filter((e) => e.outcome === 'fail').length < 2) problems.push('the day-1 log records fewer than two failures of the task command');
    if (own.filter((e) => e.outcome === 'ok').length < 1) problems.push('the day-1 log records no successful run of the task command');
  } else if (own.length > 0) {
    problems.push('the null-memory scenario seeds history for its own command, so its memory is not irrelevant');
  }

  const unrelated = commands.filter((e) => UNRELATED_COMMANDS.some((c) => (e.command ?? '').startsWith(c)));
  if (unrelated.length === 0) problems.push('no unrelated failure chain, so retrieval noise cannot be measured');
  if (!unrelated.some((e) => e.outcome === 'fail' && !commands.some((o) => o.command === e.command && o.outcome === 'ok'))) {
    problems.push('no unrelated chain left unresolved, so the session digest has nothing off-topic it could name');
  }
  for (const file of scenario.noiseFiles) {
    try {
      statSync(join(dir, file));
    } catch {
      problems.push(`${file} is named as noise but does not exist in the workspace`);
    }
  }
  return problems;
}

export function verifyScenario(scenario: V2Scenario): string[] {
  const problems: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'nexusmem-v2-fixture-'));
  try {
    scenario.build(dir);

    if (passes(dir, scenario.command)) problems.push('the command already passes in the state the agent is handed');
    const { problems: historyProblems, day1 } = historyIsTruthful(dir, scenario);
    problems.push(...historyProblems);

    if (day1 === null) problems.push('no commit is tagged as the day-1 broken state');
    else {
      const head = git(dir, 'rev-parse', 'HEAD').trim();
      git(dir, 'checkout', '-q', day1);
      if (passes(dir, scenario.command)) problems.push('the day-1 state does not fail');
      for (const edit of scenario.deadEnds) {
        if (passesWith(dir, scenario.command, edit)) problems.push(`${edit.file} fixed the check on day 1, so it was not a dead end`);
      }
      if (scenario.dayOneGreen && !passesWith(dir, scenario.command, scenario.dayOneGreen)) {
        problems.push(`${scenario.dayOneGreen.file} does not fix the check on day 1, so day 1 never ended green`);
      }
      git(dir, 'checkout', '-q', head);
    }

    // Today: repeating either dead end has to be worthless now as well.
    for (const edit of scenario.deadEnds) {
      if (passesWith(dir, scenario.command, edit)) problems.push(`${edit.file} fixes the check today, so repeating it is not a dead end`);
    }
    if (scenario.staleTrap && passesWith(dir, scenario.command, scenario.staleTrap)) {
      problems.push(`the day-1 answer applied to ${scenario.staleTrap.file} still fixes it today, so the trap is not a trap`);
    }
    if (!passesWith(dir, scenario.command, scenario.fix)) problems.push(`${scenario.fix.file}: the recorded fix does not make the command pass`);

    problems.push(...leakage(dir, scenario));
    problems.push(...eventsAreIntended(dir, scenario));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('\\').join('/').split('/').pop()!)) {
  let failed = false;
  for (const scenario of V2_SCENARIOS) {
    const problems = verifyScenario(scenario);
    process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name.padEnd(20)} ${scenario.history.length} commits re-run\n`);
    for (const problem of problems) process.stdout.write(`       ${problem}\n`);
    failed ||= problems.length > 0;
  }
  process.stdout.write(failed ? '\nfixtures are NOT sound -- do not run the eval\n' : '\nall fixtures sound\n');
  process.exit(failed ? 1 : 0);
}
