import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactAgentEvent } from '../../src/agent/event.js';
import { MAX_DIGEST_CHARS, MAX_RECALL_CHARS } from '../../src/agent/recall.js';
import { EVAL_SECRET, UNRELATED_COMMANDS, V2_SCENARIOS, type V2Scenario } from './scenario.js';

/**
 * Delivery coverage, proved deterministically and before any model runs.
 *
 * A scenario is only worth a trial if the product can actually put its
 * intended memory in front of the model: the event shape has to be one the
 * collectors observe, the execution identity has to match, the chain has to
 * be eligible for recall, the distractor must not displace it, and the null
 * scenario must stay silent. A scenario that fails here is rejected rather
 * than worked around -- nothing in `src/` changes to make a benchmark pass.
 *
 * No model call anywhere in this file.
 *
 *   npm run build && npx tsx eval/ambient-v2/verify-delivery.ts
 */

const CLI = join(process.cwd(), 'dist/cli/index.js');

export interface DeliveryFixture {
  workspace: string;
  repoDir: string;
  nmHome: string;
  env: NodeJS.ProcessEnv;
}

function cli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  if (result.status !== 0) throw new Error(`nexusmem ${args.join(' ')} exited ${String(result.status)}: ${result.stderr ?? ''}`);
  return result.stdout ?? '';
}

/**
 * Every probe needs its own session id: recall explains the same failure only
 * once per session, so reusing one would suppress the next probe and read as
 * a broken match when nothing is broken.
 */
let probe = 0;
const nextSession = (): string => `v2-delivery-${(probe += 1)}`;

function recall(fixture: DeliveryFixture, payload: object): string {
  return (
    spawnSync(process.execPath, [CLI, 'agent', 'recall', '--trigger', 'failure'], {
      cwd: fixture.repoDir,
      env: fixture.env,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }).stdout ?? ''
  );
}

function sessionStart(fixture: DeliveryFixture, sessionId = nextSession()): string {
  return (
    spawnSync(process.execPath, [CLI, 'agent', 'session-start'], {
      cwd: fixture.repoDir,
      env: fixture.env,
      input: JSON.stringify({ session_id: sessionId, cwd: fixture.repoDir, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
    }).stdout ?? ''
  );
}

const failurePayload = (fixture: DeliveryFixture, scenario: V2Scenario, command: string) => ({
  session_id: nextSession(),
  cwd: fixture.repoDir,
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: `toolu_${probe}`,
  error: `Exit code 1\n${scenario.command} failed`,
  duration_ms: 1,
});

/** Conventional `revert: ...` and git's own `Revert "..."`, matching the product rule. */
const REVERT_SUBJECT = /^revert(\([^)]*\))?[:!]|^revert\s+"/i;

/** Read out of the built repository rather than declared, so an expectation cannot drift. */
export function revertsDayOneFix(repoDir: string, scenario: V2Scenario): boolean {
  if (!scenario.dayOneGreen) return false;
  const log = execFileSync('git', ['-C', repoDir, 'log', '--format=%x00%s', '--name-only'], { encoding: 'utf8' });
  for (const entry of log.split('\0')) {
    if (!entry.trim()) continue;
    const [subject = '', ...rest] = entry.split(/\r?\n/);
    if (!REVERT_SUBJECT.test(subject.trim())) continue;
    if (rest.map((l) => l.trim()).filter(Boolean).includes(scenario.dayOneGreen.file)) return true;
  }
  return false;
}

/** A real repository, a real database and the day-1 events, all through the real CLI. */
export function buildDeliveryFixture(scenario: V2Scenario): DeliveryFixture {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-v2-delivery-')));
  const repoDir = join(workspace, 'app');
  const nmHome = join(workspace, 'nmhome');
  scenario.build(repoDir);
  mkdirSync(nmHome, { recursive: true });

  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  cli(['init', '-C', repoDir], { env });

  // Without this the sync scrapes the host's real shell history into the fixture.
  const configPath = join(repoDir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Through the same redaction the adapter applies, so what lands on disk is
  // what the hook would have written.
  const events = scenario.events(repoDir, Date.now()).map(redactAgentEvent);
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  cli(['sync', '-C', repoDir, '--no-embed', '--quiet'], { env });
  return { workspace, repoDir, nmHome, env };
}

const PRIOR_FAILURE = 'failed in this repository before';
const STALE_WORDING = 'no longer holds';

/**
 * Everything the harder eval needs the product to deliver, per scenario.
 * Returns the problems found; an empty array is the scenario passing.
 */
export function verifyDelivery(scenario: V2Scenario, fixture: DeliveryFixture): string[] {
  const problems: string[] = [];
  const { repoDir, nmHome, env } = fixture;

  // --- the synthetic secret reaches no durable artifact ----------------
  if (readFileSync(join(nmHome, 'agent-events.jsonl'), 'utf8').includes(EVAL_SECRET)) {
    problems.push('security: the raw fake credential reached the event log');
  }
  if (readFileSync(join(repoDir, '.nexusmem', 'memory.db')).includes(Buffer.from(EVAL_SECRET))) {
    problems.push('security: the raw fake credential reached the database');
  }

  const text = recall(fixture, failurePayload(fixture, scenario, scenario.command));
  const digest = sessionStart(fixture);

  if (!scenario.primaryEndpoint) {
    // The null case: nothing about this command was ever recorded, so the
    // product must not claim otherwise. A failure here is a product finding,
    // and the scenario would be rejected rather than the product changed.
    if (text.includes(PRIOR_FAILURE)) problems.push('null memory: recall claimed a prior failure for a command with no history');
    if (text.length > MAX_RECALL_CHARS) problems.push(`recall: text exceeded MAX_RECALL_CHARS (${text.length})`);
    if (digest.length > MAX_DIGEST_CHARS) problems.push(`digest: text exceeded MAX_DIGEST_CHARS (${digest.length})`);
    for (const t of [text, digest]) if (t.includes(EVAL_SECRET)) problems.push('security: the raw fake credential was echoed in CLI output');
    return problems;
  }

  // --- the seeded chain is reachable and named -------------------------
  if (!text.includes(PRIOR_FAILURE)) problems.push('recall: no prior failure was returned for the task command');
  const intended = [...scenario.deadEnds.map((e) => e.file), ...(scenario.dayOneGreen ? [scenario.dayOneGreen.file] : [])];
  for (const file of intended) {
    const leaf = file.split('/').pop()!;
    if (!text.includes(leaf) && !text.includes(file)) problems.push(`recall: ${file} is missing from the recalled history`);
  }
  if (!text.includes('fixed on')) problems.push('recall: the resolved failure->fix chain is not eligible for recall');
  if (text.length > MAX_RECALL_CHARS) problems.push(`recall: text exceeded MAX_RECALL_CHARS (${text.length})`);

  // --- the distractor does not displace the intended memory ------------
  for (const unrelated of UNRELATED_COMMANDS) {
    if (text.includes(unrelated)) problems.push(`recall: unrelated command "${unrelated}" leaked into the failure recall`);
  }

  // --- execution identity: the compounds Claude really emits match -----
  const compounds: Array<[string, string]> = [
    ['cd wrapper', `cd "${repoDir}" && ${scenario.command}`],
    ['trailing exit echo', `cd "${repoDir}" && ${scenario.command}; echo "exit: $?"`],
    ['ls prefix', `cd "${repoDir}" && ls && ${scenario.command}`],
    ['no cd, trailing exit echo', `${scenario.command}; echo "EXIT: $?"`],
  ];
  for (const [label, command] of compounds) {
    if (!recall(fixture, failurePayload(fixture, scenario, command)).includes(PRIOR_FAILURE)) {
      problems.push(`execHash: a real Claude compound (${label}) did not match its bare history`);
    }
  }
  const unsafe: Array<[string, string]> = [
    ['npm install prefix', `npm install && ${scenario.command}`],
    ['env-var export prefix', `export NODE_ENV=test && ${scenario.command}`],
    ['second real execution', `node build.js && ${scenario.command}`],
    ['piped into head', `${scenario.command} 2>&1 | head -100`],
  ];
  for (const [label, command] of unsafe) {
    if (recall(fixture, failurePayload(fixture, scenario, command)).includes(PRIOR_FAILURE)) {
      problems.push(`execHash: an unsafe compound (${label}) incorrectly matched the bare history`);
    }
  }

  // --- a hidden exit code is still a failure ---------------------------
  const hidden = recall(fixture, {
    session_id: nextSession(),
    cwd: repoDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: `${scenario.command}; echo "EXIT:$?"` },
    tool_response: { stdout: `${scenario.command} failed\nEXIT:1`, stderr: '', interrupted: false },
    tool_use_id: `toolu_${probe}`,
  });
  if (!hidden.includes(PRIOR_FAILURE)) problems.push('exit-status: a hidden non-zero exit code was not recognised as a failure');

  // --- duplicate delivery is suppressed within a session ---------------
  const session = nextSession();
  const once = recall(fixture, { ...failurePayload(fixture, scenario, scenario.command), session_id: session });
  const twice = recall(fixture, { ...failurePayload(fixture, scenario, scenario.command), session_id: session });
  if (!once.includes(PRIOR_FAILURE)) problems.push('dedup: the first delivery in a fresh session did not fire');
  if (twice.includes(PRIOR_FAILURE)) problems.push('dedup: the same failure was delivered twice in one session');

  // --- the digest carries the chain, undisplaced -----------------------
  const firstLine = scenario.command.split(/\r?\n/)[0]!;
  const fixLeaf = scenario.fix.file.split('/').pop()!;
  const dayOneLeaf = scenario.dayOneGreen?.file.split('/').pop() ?? fixLeaf;
  if (!digest.includes(firstLine) && !digest.includes(fixLeaf) && !digest.includes(dayOneLeaf)) {
    problems.push('digest: the session-start digest does not mention the resolved chain at all');
  }
  for (const unrelated of UNRELATED_COMMANDS) {
    if (digest.includes(unrelated) && digest.indexOf(unrelated) < digest.indexOf(firstLine)) {
      problems.push(`digest: an unrelated unresolved failure ("${unrelated}") was ranked ahead of the resolved chain`);
    }
  }
  if (digest.length > MAX_DIGEST_CHARS) problems.push(`digest: text exceeded MAX_DIGEST_CHARS (${digest.length})`);

  // --- stale state is represented, from the fixture's own git history ---
  const reverted = revertsDayOneFix(repoDir, scenario);
  const saysStale = (t: string) => t.includes(STALE_WORDING);
  if (reverted && !saysStale(text)) problems.push('stale: git reverted the day-1 fix, but recall still presents it as current');
  if (reverted && !saysStale(digest)) problems.push('stale: git reverted the day-1 fix, but the digest still presents it as current');
  if (!reverted && (saysStale(text) || saysStale(digest))) {
    problems.push('stale: a fix is labelled as no longer holding, but git contains no revert of it');
  }

  for (const t of [text, digest, hidden]) {
    if (t.includes(EVAL_SECRET)) problems.push('security: the raw fake credential was echoed in CLI output');
  }
  return problems;
}

/**
 * Removes a verification workspace. `agent session-start` spawns a detached
 * `sync --auto` with no handle to wait on, and on Windows it can still hold
 * the database open, so removal is retried and a leftover is reported rather
 * than failing the gate.
 */
export function removeFixture(fixture: DeliveryFixture): boolean {
  try {
    rmSync(fixture.workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delivery proved on a disposable twin of a trial, never on the trial itself.
 *
 * The audit behind this: probing an instance is not read-only. Every recall
 * that fires writes `agent-recall-state.json` under NEXUSMEM_HOME, and
 * `agent session-start` spawns a detached `sync --auto` that -- with no
 * `--no-embed` -- embeds every node whenever a local embedding server
 * answers, and moves the sync timestamps and project registry. At 71b31f3
 * all of that landed in the ambient trial's own state before the model
 * started. The twin is built by the same function from the same frozen
 * definition, gets the same hooks installed, and goes through the same
 * product path; only its state is thrown away afterwards.
 */
export function verifyOnTwin(scenario: V2Scenario): string[] {
  const twin = buildDeliveryFixture(scenario);
  try {
    cli(['agent', 'install', '--project', '-C', twin.repoDir], { env: twin.env });
    // eslint-disable-next-line no-control-regex
    const status = cli(['agent', 'status', '--project', '-C', twin.repoDir], { env: twin.env }).replace(/\x1b\[[0-9;]*m/g, '');
    const problems: string[] = [];
    if (!/installed\s+yes/.test(status)) problems.push('install: agent status does not report the hooks as installed');
    if (/do not exist here/.test(status)) problems.push('install: the installed hook points at paths this machine does not have');
    if (/capture\s+degraded/.test(status)) problems.push('capture: health is degraded, so events are being dropped');
    problems.push(...verifyDelivery(scenario, twin));
    return problems;
  } finally {
    if (!removeFixture(twin)) process.stderr.write(`(verification twin left behind: ${twin.workspace})\n`);
  }
}

if (process.argv[1]?.split(/[\\/]/).pop() === 'verify-delivery.ts') {
  let failed = false;
  for (const scenario of V2_SCENARIOS) {
    const problems = verifyOnTwin(scenario);
    process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name}\n`);
    for (const problem of problems) process.stdout.write(`       ${problem}\n`);
    failed ||= problems.length > 0;
  }
  process.stdout.write(failed ? '\ndelivery is NOT covered -- reject or repair the scenario\n' : '\nall scenarios deliver\n');
  process.exit(failed ? 1 : 0);
}
