import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { redactAgentEvent } from '../src/agent/event.js';
import { SCENARIOS, type Scenario } from '../eval/ambient/scenario.js';

/**
 * Does ambient memory change what the agent does?
 *
 * Three arms against the same repository and the same task:
 *
 *   baseline  git history only, no NexusMem at all
 *   mcp       NexusMem reachable as MCP tools, never mentioned in the prompt
 *   ambient   NexusMem's own hooks installed, nothing reachable by hand
 *
 * The fix is reachable from `git log` in every scenario, so the baseline is
 * never deprived of the answer -- only of anything that puts it in front of
 * the model. The task never mentions memory, and every arm is isolated from
 * this machine's own MCP servers and settings.
 *
 * Scoring is mechanical and read from the session transcript: which files were
 * edited and in what order, how many tool calls, how many of them failed, when
 * the fix was reached, and what NexusMem put into the context. Model behaviour
 * is variable, so this is a measurement, not a test.
 *
 *   npm run build && npx tsx scripts/eval-ambient.ts [repeats] [outDir]
 */

const CLI = resolve('dist/cli/index.js');
const ARMS = ['baseline', 'mcp', 'ambient'] as const;
type Arm = (typeof ARMS)[number];

const REPEATS = Number(process.argv[2] ?? 3);
const OUT_DIR = realpath(resolve(process.argv[3] ?? join(process.env.TEMP ?? '/tmp', 'nexusmem-eval-ambient')));

/**
 * The fixture's own path has to be the one git will report. On Windows `TEMP`
 * is an 8.3 short path (C:\Users\USER-0~1\...) while git resolves the long
 * form, so an event recorded against the short one is filtered out of its own
 * repository and the ambient arm silently measures an empty database.
 */
function realpath(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir);
}
const MAX_TURNS = 25;
/** Pinned so every arm and repeat is the same model. */
const MODEL = process.env.EVAL_MODEL ?? 'sonnet';
/** Fake, and never a real credential shape anyone could mistake for one. */
const EVAL_SECRET = 'ghp_evalF4keToken0123456789abcd';
/** Commands in the fixture that have nothing to do with the task. Recalling one is noise. */
const UNRELATED_COMMANDS = ['npm run lint', 'npm run typecheck'];

interface RunResult {
  scenario: string;
  arm: Arm;
  repeat: number;
  ok: boolean;
  error?: string;
  /** Set when the deterministic pre-flight failed: model behaviour is then not what was measured. */
  systemFailure?: string;

  // behaviour
  repeatedDeadEndA: boolean;
  repeatedDeadEndB: boolean;
  editedStaleFile: boolean;
  editedFixFile: boolean;
  commandPassesAfter: boolean;
  firstEditedFile: string | null;
  firstEditWasDeadEnd: boolean;
  /** Tool calls made before the first edit of the file that actually fixes it. */
  toolCallsBeforeFix: number | null;
  msToFix: number | null;

  // cost
  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;

  // what NexusMem contributed
  injections: number;
  injectedChars: number;
  /** Injections naming an unrelated command and not the task's own. */
  irrelevantInjections: number;
  /** Did the failure recall -- the feature the tester said they would miss -- actually fire? */
  recallFired: boolean;
  /** Did the session-start digest fire? */
  digestFired: boolean;
  nexusMemToolCalls: number;
  noticedNexusMem: boolean;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** A NexusMem database holding day 1: two abandoned attempts, the fix, and two unrelated chains. */
function seedMemory(scenario: Scenario, repoDir: string, nmHome: string): void {
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  mkdirSync(nmHome, { recursive: true });
  run(process.execPath, [CLI, 'init', '-C', repoDir], { env });

  // Without this the sync scrapes this machine's real shell history into the fixture.
  const configPath = join(repoDir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Through the same redaction the adapter applies, so what lands on disk is
  // what the hook would have written -- including for the one event carrying
  // a fake credential.
  const events = scenario.events(repoDir).map(redactAgentEvent);
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  run(process.execPath, [CLI, 'sync', '-C', repoDir, '--no-embed', '--quiet'], { env });
}

/**
 * §6: separate a system failure from model behaviour. If capture, correlation
 * or recall is broken, an ambient run measures nothing about the product.
 */
function preflightAmbient(scenario: Scenario, repoDir: string, nmHome: string): string | null {
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  const logPath = join(nmHome, 'agent-events.jsonl');
  const log = readFileSync(logPath, 'utf8');

  if (log.includes(EVAL_SECRET)) return 'security: the raw fake credential reached the event log';
  const dbPath = join(repoDir, '.nexusmem', 'memory.db');
  if (readFileSync(dbPath).includes(Buffer.from(EVAL_SECRET))) return 'security: the raw fake credential reached the database';

  const payload = JSON.stringify({
    session_id: 'preflight',
    cwd: repoDir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: scenario.command },
    tool_use_id: 'toolu_preflight',
    error: 'Exit code 1\npreflight',
    duration_ms: 1,
  });
  const recall = spawnSync(process.execPath, [CLI, 'agent', 'recall', '--trigger', 'failure'], {
    cwd: repoDir,
    env,
    input: payload,
    encoding: 'utf8',
  });
  const text = recall.stdout ?? '';
  if (!text.includes('failed in this repository before')) return 'recall: no prior failure was returned for the task command';
  // Both abandoned attempts and whatever day 1 ended green on have to be
  // reachable, or the arm is credited with information it never had. Note that
  // is day 1's answer, which in two scenarios is no longer today's.
  for (const file of [scenario.deadEndA, scenario.deadEndB, scenario.day1FixFile]) {
    const leaf = file.split('/').pop()!;
    if (!text.includes(leaf) && !text.includes(file)) return `recall: ${file} is missing from the recalled history`;
  }
  for (const unrelated of UNRELATED_COMMANDS) {
    if (text.includes(unrelated)) return `recall: unrelated command "${unrelated}" leaked into the failure recall`;
  }
  return null;
}

/**
 * The task goes in on stdin, never as an argument: a prompt passed through a
 * Windows shell shim is concatenated rather than escaped, which silently
 * mangles it -- the first run of this eval scored three arms of a garbled
 * prompt before that showed up.
 */
function claudeArgs(arm: Arm, repoDir: string, runDir: string): string[] {
  // Every arm is isolated from whatever MCP servers and settings this machine
  // has configured, so only the intended one reaches NexusMem.
  const emptyMcp = join(runDir, 'mcp-empty.json');
  writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
  const emptySettings = join(runDir, 'settings-empty.json');
  writeFileSync(emptySettings, JSON.stringify({}));

  const args = [
    '-p',
    '--model',
    MODEL,
    '--allowedTools',
    'Bash',
    'Edit',
    'Write',
    'Read',
    'Glob',
    'Grep',
    'mcp__nexusmem__search_memory',
    'mcp__nexusmem__get_status',
    'mcp__nexusmem__list_recent_memory',
    '--max-turns',
    String(MAX_TURNS),
    '--output-format',
    'json',
    '--strict-mcp-config',
  ];

  if (arm === 'mcp') {
    const mcpConfig = join(runDir, 'mcp-nexusmem.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { nexusmem: { command: process.execPath, args: [CLI, 'mcp'] } } }),
    );
    args.push('--mcp-config', mcpConfig);
  } else {
    args.push('--mcp-config', emptyMcp);
  }

  // Symmetric on purpose: every arm is handed a settings file, so only its
  // contents differ, not whether one was passed at all.
  args.push('--settings', arm === 'ambient' ? join(repoDir, '.claude', 'settings.local.json') : emptySettings);
  return args;
}

interface Transcript {
  toolCalls: number;
  failedToolCalls: number;
  /** Repo-relative, in the order they were first edited. */
  editedFiles: string[];
  /** Tool-call index (1-based) at which each file was first edited. */
  editIndex: Map<string, number>;
  /** Milliseconds from the first entry to the first edit of each file. */
  editMs: Map<string, number>;
  injections: string[];
  nexusMemToolCalls: number;
  noticedNexusMem: boolean;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EMPTY_TRANSCRIPT: Transcript = {
  toolCalls: 0,
  failedToolCalls: 0,
  editedFiles: [],
  editIndex: new Map(),
  editMs: new Map(),
  injections: [],
  nexusMemToolCalls: 0,
  noticedNexusMem: false,
};

function transcriptPath(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const path = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Reads the session transcript for what the model actually did and was shown. */
function readTranscript(path: string, repoDir: string): Transcript {
  const t: Transcript = { ...EMPTY_TRANSCRIPT, editedFiles: [], editIndex: new Map(), editMs: new Map(), injections: [] };
  let startedAt: number | null = null;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
      attachment?: { type?: string; hookName?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = entry.timestamp ? Date.parse(entry.timestamp) : null;
    if (at !== null && startedAt === null) startedAt = at;

    // A hook's output does not arrive as a message block: Claude Code records
    // it as an attachment carrying the hook's name and its stdout. Reading
    // only message content misses every injection there is.
    const hook = entry.attachment;
    if (hook?.type?.startsWith('hook') && typeof hook.content === 'string' && hook.content.includes('NexusMem:')) {
      t.injections.push(hook.content);
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        t.toolCalls += 1;
        const name = String(block.name ?? '');
        if (name.startsWith('mcp__nexusmem__')) t.nexusMemToolCalls += 1;
        if (EDIT_TOOLS.has(name)) {
          const filePath = String((block.input as Record<string, unknown> | undefined)?.file_path ?? '');
          if (filePath) {
            const rel = relative(repoDir, filePath).split('\\').join('/');
            if (!t.editIndex.has(rel)) {
              t.editedFiles.push(rel);
              t.editIndex.set(rel, t.toolCalls);
              if (at !== null && startedAt !== null) t.editMs.set(rel, at - startedAt);
            }
          }
        }
      } else if (block.type === 'tool_result') {
        if (block.is_error === true) t.failedToolCalls += 1;
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        // Injections arrive as user-role text; anything the assistant says
        // about NexusMem is the model noticing, not the hook speaking.
        if (text.includes('NexusMem:')) {
          if (entry.message?.role === 'assistant') t.noticedNexusMem = true;
          else for (const match of text.matchAll(/NexusMem:[\s\S]{0,1500}/g)) t.injections.push(match[0]);
        } else if (entry.message?.role === 'assistant' && /nexusmem/i.test(text)) {
          t.noticedNexusMem = true;
        }
      }
    }
  }
  return t;
}

function scoreRepo(repoDir: string, scenario: Scenario): { commandPasses: boolean } {
  const [exe, ...rest] = scenario.command.split(' ');
  return { commandPasses: spawnSync(exe!, rest, { cwd: repoDir, encoding: 'utf8' }).status === 0 };
}

async function runOnce(scenario: Scenario, arm: Arm, repeat: number): Promise<RunResult> {
  const runDir = join(OUT_DIR, scenario.name, arm, String(repeat));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const repoDir = join(runDir, 'repo');
  const nmHome = join(runDir, 'nmhome');

  scenario.build(repoDir);
  if (arm !== 'baseline') seedMemory(scenario, repoDir, nmHome);

  const empty: RunResult = {
    scenario: scenario.name,
    arm,
    repeat,
    ok: false,
    repeatedDeadEndA: false,
    repeatedDeadEndB: false,
    editedStaleFile: false,
    editedFixFile: false,
    commandPassesAfter: false,
    firstEditedFile: null,
    firstEditWasDeadEnd: false,
    toolCallsBeforeFix: null,
    msToFix: null,
    toolCalls: 0,
    failedToolCalls: 0,
    turns: 0,
    costUsd: 0,
    durationMs: 0,
    injections: 0,
    injectedChars: 0,
    irrelevantInjections: 0,
    recallFired: false,
    digestFired: false,
    nexusMemToolCalls: 0,
    noticedNexusMem: false,
  };

  if (arm === 'ambient') {
    run(process.execPath, [CLI, 'agent', 'install', '--project', '-C', repoDir], { env: { ...process.env, NEXUSMEM_HOME: nmHome } });
    const problem = preflightAmbient(scenario, repoDir, nmHome);
    if (problem) return { ...empty, ok: false, systemFailure: problem };
  }

  const started = Date.now();
  const result = spawnSync('claude', claudeArgs(arm, repoDir, runDir), {
    cwd: repoDir,
    env: { ...process.env, NEXUSMEM_HOME: nmHome },
    encoding: 'utf8',
    input: scenario.task,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });

  let parsed: { session_id?: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number; is_error?: boolean } | null = null;
  try {
    parsed = JSON.parse(result.stdout ?? '');
  } catch {
    return { ...empty, ok: false, durationMs: Date.now() - started, error: (result.stderr ?? result.stdout ?? '').slice(0, 300) };
  }

  const path = parsed?.session_id ? transcriptPath(parsed.session_id) : null;
  const t = path ? readTranscript(path, repoDir) : EMPTY_TRANSCRIPT;
  if (path) writeFileSync(join(runDir, 'transcript.jsonl'), readFileSync(path)); // kept for the qualitative read

  const { commandPasses } = scoreRepo(repoDir, scenario);
  const injectedChars = t.injections.reduce((sum, i) => sum + i.length, 0);

  return {
    ...empty,
    ok: parsed?.is_error !== true,
    repeatedDeadEndA: t.editIndex.has(scenario.deadEndA),
    repeatedDeadEndB: t.editIndex.has(scenario.deadEndB),
    editedStaleFile: scenario.staleFile ? t.editIndex.has(scenario.staleFile) : false,
    editedFixFile: t.editIndex.has(scenario.fixFile),
    commandPassesAfter: commandPasses,
    firstEditedFile: t.editedFiles[0] ?? null,
    firstEditWasDeadEnd: t.editedFiles[0] === scenario.deadEndA || t.editedFiles[0] === scenario.deadEndB,
    toolCallsBeforeFix: t.editIndex.get(scenario.fixFile) ?? null,
    msToFix: t.editMs.get(scenario.fixFile) ?? null,
    toolCalls: t.toolCalls,
    failedToolCalls: t.failedToolCalls,
    turns: parsed?.num_turns ?? 0,
    costUsd: parsed?.total_cost_usd ?? 0,
    durationMs: parsed?.duration_ms ?? Date.now() - started,
    injections: t.injections.length,
    injectedChars,
    irrelevantInjections: t.injections.filter(
      (i) => UNRELATED_COMMANDS.some((c) => i.includes(c)) && !i.includes(scenario.command),
    ).length,
    recallFired: t.injections.some((i) => i.includes('failed in this repository before')),
    digestFired: t.injections.some((i) => i.includes('with no recorded fix')),
    nexusMemToolCalls: t.nexusMemToolCalls,
    noticedNexusMem: t.noticedNexusMem,
  };
}

function summarize(results: readonly RunResult[]): string {
  const lines: string[] = [];
  for (const scenario of SCENARIOS) {
    lines.push('', scenario.name);
    for (const arm of ARMS) {
      const runs = results.filter((r) => r.scenario === scenario.name && r.arm === arm);
      if (runs.length === 0) continue;
      const n = runs.length;
      const rate = (p: (r: RunResult) => boolean) => `${runs.filter(p).length}/${n}`;
      const mean = (pick: (r: RunResult) => number) => runs.reduce((s, r) => s + pick(r), 0) / n;
      const meanOf = (pick: (r: RunResult) => number | null) => {
        const vals = runs.map(pick).filter((v): v is number => v !== null);
        return vals.length === 0 ? '  -- ' : (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1).padStart(5);
      };
      lines.push(
        [
          `  ${arm.padEnd(9)}`,
          `fixed ${rate((r) => r.commandPassesAfter).padEnd(4)}`,
          `deadA ${rate((r) => r.repeatedDeadEndA).padEnd(4)}`,
          `deadB ${rate((r) => r.repeatedDeadEndB).padEnd(4)}`,
          `stale ${rate((r) => r.editedStaleFile).padEnd(4)}`,
          `1st-edit-dead ${rate((r) => r.firstEditWasDeadEnd).padEnd(4)}`,
          `calls ${mean((r) => r.toolCalls).toFixed(1).padStart(5)}`,
          `failed ${mean((r) => r.failedToolCalls).toFixed(1).padStart(4)}`,
          `to-fix ${meanOf((r) => r.toolCallsBeforeFix)}`,
          `inj ${mean((r) => r.injectedChars).toFixed(0).padStart(5)}ch`,
          `recall ${rate((r) => r.recallFired).padEnd(4)}`,
          `digest ${rate((r) => r.digestFired).padEnd(4)}`,
          `noise ${mean((r) => r.irrelevantInjections).toFixed(1)}`,
          `noticed ${rate((r) => r.noticedNexusMem).padEnd(4)}`,
          `$${mean((r) => r.costUsd).toFixed(3)}`,
        ].join('  '),
      );
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
  const only = process.env.EVAL_SCENARIO;
  const scenarios = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  const results: RunResult[] = [];

  mkdirSync(OUT_DIR, { recursive: true });
  process.stdout.write(
    `\nambient-memory eval: ${scenarios.length} scenario(s), ${REPEATS} run(s) per arm, model ${MODEL}\n  out: ${OUT_DIR}\n\n`,
  );
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const arm of ARMS) {
        process.stdout.write(`  ${scenario.name.padEnd(18)} ${arm.padEnd(9)} #${repeat} ... `);
        const result = await runOnce(scenario, arm, repeat);
        results.push(result);
        writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
        process.stdout.write(
          result.systemFailure
            ? `SYSTEM FAILURE: ${result.systemFailure}\n`
            : `${result.ok ? '' : 'ERROR '}fixed=${result.commandPassesAfter} deadA=${result.repeatedDeadEndA} deadB=${result.repeatedDeadEndB} stale=${result.editedStaleFile} calls=${result.toolCalls} inj=${result.injectedChars}\n`,
        );
      }
    }
  }

  process.stdout.write(`\n${summarize(results)}\n\nraw: ${join(OUT_DIR, 'results.json')}\n\n`);
}

await main();
