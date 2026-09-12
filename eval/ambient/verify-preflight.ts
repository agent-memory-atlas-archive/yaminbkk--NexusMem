import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactAgentEvent } from '../../src/agent/event.js';
import { MAX_DIGEST_CHARS, MAX_RECALL_CHARS } from '../../src/agent/recall.js';
import { deadEndFiles, SCENARIOS, type Scenario } from './scenario.js';

/**
 * The deterministic gate Phase 5.1 §6 asks for: proves the Phase-5.1 fixes
 * (execution identity, exit-status recovery, the digest redesign) actually
 * reach a real Claude-Code-shaped payload through the real CLI, before any
 * `claude` process is spawned. No model call anywhere in this file.
 *
 * Eight checks per scenario:
 *   A. the historical A/B/C chain exists in the seeded database
 *   B. a real Claude-style `cd "<cwd>" && <command>` failure matches the
 *      historical bare command (the execution-identity fix)
 *   C. a Claude-style "hidden exit code" success is recognised as the
 *      failure it actually is, and a genuine success is not (the
 *      exit-status-recovery fix)
 *   D. the failure->fix chain is eligible for ambient recall once correlated
 *   E. an unrelated unresolved failure does not crowd the useful chain out
 *      of the session-start digest (the digest redesign)
 *   F. recall output actually names the A/B/C evidence, not just "something"
 *   G. both recall and the digest stay inside their token budgets
 *   H. the synthetic secret this file plants occurs zero times in any
 *      NexusMem-owned durable artifact
 *
 *   npm run build && npx tsx eval/ambient/verify-preflight.ts
 */

const CLI = join(process.cwd(), 'dist/cli/index.js');
const SECRET = 'ghp_preflightF4keToken0123456789abcd';
const UNRELATED_COMMAND = 'npm run lint';

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  if (result.status !== 0 && !opts.input) {
    throw new Error(`nexusmem ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout ?? '';
}

function recall(payload: object, cwd: string, env: NodeJS.ProcessEnv): string {
  return spawnSync(process.execPath, [CLI, 'agent', 'recall', '--trigger', 'failure'], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }).stdout ?? '';
}

function sessionStart(cwd: string, env: NodeJS.ProcessEnv): string {
  return spawnSync(process.execPath, [CLI, 'agent', 'session-start'], {
    cwd,
    env,
    input: JSON.stringify({ session_id: 'preflight-start', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
  }).stdout ?? '';
}

interface Fixture {
  dir: string;
  nmHome: string;
}

/** A real repository, a real NexusMem database, and the day-1 events -- all through the real CLI. */
function buildFixture(scenario: Scenario): Fixture {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-preflight-')));
  const dir = join(workspace, 'app');
  const nmHome = join(workspace, 'nmhome');
  scenario.build(dir);
  mkdirSync(nmHome, { recursive: true });

  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  run(['init', '-C', dir], { env });

  // Without this the sync scrapes this machine's real shell history into the fixture.
  const configPath = join(dir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const events = scenario.events(dir).map(redactAgentEvent);
  // One event carries the synthetic secret, through the same redaction path
  // the real hook applies, so H has something real to check.
  events.push(
    redactAgentEvent({
      agent: 'claude-code',
      sessionId: 'preflight-secret',
      eventId: 'secret-1',
      ts: new Date().toISOString(),
      cwd: dir,
      kind: 'command',
      command: `${UNRELATED_COMMAND} --token=${SECRET}`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    }),
  );
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  run(['sync', '-C', dir, '--no-embed', '--quiet'], { env });
  return { dir, nmHome };
}

/**
 * Every probe below needs its own `session_id`. `agent recall` explains the
 * same failure only once per session (`shouldInject`/`markInjected`) -- real
 * and correct product behaviour, but it means reusing a session id across
 * two of these checks silently suppresses the second one and makes it look
 * like a match failed when it did not.
 */
let nextSessionId = 0;
const session = () => `preflight-${(nextSessionId += 1)}`;

function failurePayload(scenario: Scenario, dir: string, command: string): object {
  return {
    session_id: session(),
    cwd: dir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: `toolu_preflight_${nextSessionId}`,
    error: `Exit code 1\n${scenario.command} failed`,
    duration_ms: 5,
  };
}

function hiddenExitPayload(dir: string, command: string, stdout: string): object {
  return {
    session_id: session(),
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
    tool_use_id: `toolu_preflight_${nextSessionId}`,
  };
}

function verify(scenario: Scenario): string[] {
  const problems: string[] = [];
  const { dir, nmHome } = buildFixture(scenario);
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };

  try {
    // --- A: the historical A/B/C chain exists ---------------------------
    const bareRecall = recall(failurePayload(scenario, dir, scenario.command), dir, env);
    if (!bareRecall.includes('failed in this repository before')) problems.push('A: no historical failure found for the bare command');
    for (const [label, edit] of [
      ['A', scenario.attemptA],
      ['B', scenario.attemptB],
    ] as const) {
      const leaf = edit.file.split('/').pop()!;
      if (!bareRecall.includes(leaf) && !bareRecall.includes(edit.file)) problems.push(`A: approach ${label} (${edit.file}) is missing from recall`);
    }

    // --- B: a Claude-style cd-wrapped command matches the same history --
    const wrapped = recall(failurePayload(scenario, dir, `cd "${dir}" && ${scenario.command}`), dir, env);
    if (!wrapped.includes('failed in this repository before')) problems.push('B: a "cd <cwd> && <command>" wrapped failure did not match its bare history');
    const differentDir = recall(failurePayload(scenario, dir, `cd /somewhere/unrelated && ${scenario.command}`), dir, env);
    if (differentDir !== '') problems.push('B: a cd to an unrelated directory incorrectly matched');

    // --- C: a Claude-style hidden-exit-code outcome is recognised -------
    const hiddenFail = recall(hiddenExitPayload(dir, scenario.command, `${scenario.command} failed\nEXIT:1`), dir, env);
    if (!hiddenFail.includes('failed in this repository before')) problems.push('C: a hidden non-zero exit code ("; echo EXIT:1") was not recognised as a failure');

    const hiddenOk = recall(hiddenExitPayload(dir, scenario.command, 'ok\nEXIT:0'), dir, env);
    if (hiddenOk !== '') problems.push('C: a genuine "EXIT:0" was incorrectly treated as a failure');

    // --- D + F: the fix is eligible for ambient recall, and named -------
    const fixLeaf = scenario.fix.file.split('/').pop()!;
    // `attemptC` is what day 1 actually ended green on; only two scenarios
    // still have that be today's `fix` (`retry-regression`, `stale-fix` do
    // not -- their day-1 answer is what makes them adversarial).
    const day1Leaf = scenario.attemptC.file.split('/').pop()!;
    if (bareRecall.includes('fixed on')) {
      if (!bareRecall.includes(day1Leaf) && !bareRecall.includes(fixLeaf)) problems.push('D/F: recall claims a fix but does not name the file it touched');
    } else {
      problems.push('D: no fix chain was eligible for recall even though day 1 ended green');
    }

    // --- E: an unrelated unresolved failure does not crowd it out -------
    const digest = sessionStart(dir, env);
    if (!digest.includes(scenario.command.split(/\r?\n/)[0]!) && !digest.includes(fixLeaf) && !digest.includes(day1Leaf)) {
      problems.push('E: the session-start digest does not mention the resolved chain at all');
    }
    if (digest.includes(UNRELATED_COMMAND) && digest.indexOf(UNRELATED_COMMAND) < digest.indexOf(scenario.command)) {
      problems.push('E: an unrelated unresolved failure was ranked ahead of the resolved chain');
    }

    // --- G: token budget -------------------------------------------------
    if (bareRecall.length > 0) {
      const injected = (JSON.parse(bareRecall) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext;
      if (injected && injected.length > MAX_RECALL_CHARS) problems.push(`G: recall text exceeded MAX_RECALL_CHARS (${injected.length})`);
    }
    if (digest.length > MAX_DIGEST_CHARS) problems.push(`G: session-start digest exceeded MAX_DIGEST_CHARS (${digest.length})`);

    // --- H: no raw synthetic secret persists anywhere durable ------------
    const dbBytes = readFileSync(join(dir, '.nexusmem', 'memory.db'));
    if (dbBytes.includes(Buffer.from(SECRET))) problems.push('H: the raw synthetic secret is present in the database file');
    const eventLog = readFileSync(join(nmHome, 'agent-events.jsonl'), 'utf8');
    if (eventLog.includes(SECRET)) problems.push('H: the raw synthetic secret is present in the agent event log');
    for (const text of [bareRecall, wrapped, differentDir, hiddenFail, hiddenOk, digest]) {
      if (text.includes(SECRET)) problems.push('H: the raw synthetic secret was echoed in CLI output');
    }
    if (deadEndFiles(scenario).some((f) => !f)) problems.push('internal: a scenario declared an empty dead-end file');
  } finally {
    // Best-effort: a lingering handle on Windows must not hide real check results.
    try {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    } catch {
      /* leaked temp dir, not a preflight failure */
    }
  }
  return problems;
}

let failed = false;
for (const scenario of SCENARIOS) {
  const problems = verify(scenario);
  process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name}\n`);
  for (const problem of problems) process.stdout.write(`       ${problem}\n`);
  failed ||= problems.length > 0;
}
process.stdout.write(failed ? '\npreflight FAILED -- do not run the model eval\n' : '\npreflight passed -- safe to run the model eval\n');
process.exit(failed ? 1 : 0);
