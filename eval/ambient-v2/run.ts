import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactAgentEvent } from '../../src/agent/event.js';
import { repoRelative } from '../ambient/paths.js';
import { fingerprints, productFingerprints, REPEATS } from './fingerprint.js';
import { checkArmSetup, checkCleanStart, checkDistinctWorkspaces, checkFreshWorkspace, type TrialPaths } from './isolation.js';
import { planTrials, SEED, type PlannedTrial } from './order.js';
import { V2_SCENARIOS, type V2Scenario } from './scenario.js';
import { ARMS, scoreTrial, summariseArm, type Arm, type Injection, type TrialRecord, type TrialScore } from './scorer.js';
import { logicalState, stateDiff } from './state.js';
import { verifyOnTwin } from './verify-delivery.js';
import { changedFiles } from './workspace.js';

/**
 * Orchestration for the harder ambient-memory experiment.
 *
 * Three arms against the same repository and the same sentence:
 *
 *   control   git history only, no NexusMem at all
 *   mcp       NexusMem reachable as MCP tools, never mentioned in the prompt
 *   ambient   NexusMem's own hooks installed, nothing reachable by hand
 *
 * `--dry-run` performs every step except the model call: it builds each
 * isolated workspace, seeds each history, configures each arm, installs the
 * hooks where they belong, proves delivery, writes the trial manifest, runs a
 * record through the scorer and cleans up. It ends by printing the number of
 * model calls it made, which is zero.
 *
 * A real run additionally requires NEXUSMEM_EVAL_V2_AUTHORIZE=1, so trials
 * cannot start from a mistyped argument.
 *
 *   npm run build && npx tsx eval/ambient-v2/run.ts --dry-run [outDir]
 */

const CLI = resolve('dist/cli/index.js');
const MAX_TURNS = 25;
/** Pinned so every arm and repeat is the same model. */
const MODEL = process.env.EVAL_MODEL ?? 'sonnet';

/** Incremented in exactly one place. A dry run must end with this at zero. */
let modelCalls = 0;

function cli(args: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`nexusmem ${args.join(' ')} exited ${String(result.status)}: ${result.stderr ?? ''}`);
  return result.stdout ?? '';
}

/** A NexusMem database holding the seeded history, through the real CLI. */
function seedMemory(scenario: V2Scenario, paths: TrialPaths): void {
  const env = { ...process.env, NEXUSMEM_HOME: paths.nmHome };
  mkdirSync(paths.nmHome, { recursive: true });
  cli(['init', '-C', paths.repoDir], env);

  // Without this the sync scrapes the host's real shell history into the fixture.
  const configPath = join(paths.repoDir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const events = scenario.events(paths.repoDir, Date.now()).map(redactAgentEvent);
  writeFileSync(join(paths.nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  cli(['sync', '-C', paths.repoDir, '--no-embed', '--quiet'], env);
}

/** The mcp arm has to be a real product test: a dead server would make it a second control. */
function preflightMcp(paths: TrialPaths): string | null {
  const rpc = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n');
  const server = spawnSync(process.execPath, [CLI, 'mcp'], {
    cwd: paths.repoDir,
    env: { ...process.env, NEXUSMEM_HOME: paths.nmHome },
    input: `${rpc}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = server.stdout ?? '';
  if (!out.includes('"tools"')) return `mcp: the server returned no tool list\n${(server.stderr ?? '').slice(0, 200)}`;
  for (const tool of ['search_memory', 'list_recent_memory', 'get_status']) {
    if (!out.includes(`"${tool}"`)) return `mcp: ${tool} is not offered by the server`;
  }
  return null;
}

/**
 * The task goes in on stdin, never as an argument: a prompt passed through a
 * Windows shell shim is concatenated rather than escaped.
 *
 * Every arm is isolated from whatever MCP servers and settings the host has
 * configured, and every arm is handed a settings file, so only its contents
 * differ and not whether one was passed at all.
 */
function claudeArgs(arm: Arm, paths: TrialPaths, runDir: string): string[] {
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
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { nexusmem: { command: process.execPath, args: [CLI, 'mcp'] } } }));
    args.push('--mcp-config', mcpConfig);
  } else {
    args.push('--mcp-config', emptyMcp);
  }
  args.push('--settings', arm === 'ambient' ? join(paths.repoDir, '.claude', 'settings.local.json') : emptySettings);
  return args;
}

interface Transcript {
  toolCalls: number;
  failedToolCalls: number;
  editedFiles: string[];
  editIndex: Record<string, number>;
  injections: Injection[];
  nexusMemToolCalls: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function transcriptPath(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const path = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * A hook's output does not arrive as one shape. SessionStart prints plain
 * text, which Claude Code records in the attachment's `content`; tool-event
 * recall prints a JSON envelope, and Claude Code leaves `content` empty for
 * that shape and puts the raw stdout in `stdout`. Both are read here.
 */
function hookInjection(hook: { type?: string; content?: unknown; stdout?: unknown }): string | null {
  if (!hook.type?.startsWith('hook')) return null;
  const { content } = hook;
  if (typeof content === 'string' && content.includes('NexusMem:')) return content;
  if (Array.isArray(content) && content.every((c) => typeof c === 'string')) {
    const joined = (content as string[]).join('\n');
    if (joined.includes('NexusMem:')) return joined;
  }
  if (typeof hook.stdout === 'string') {
    try {
      const parsed = JSON.parse(hook.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const ctx = parsed.hookSpecificOutput?.additionalContext;
      if (typeof ctx === 'string' && ctx.includes('NexusMem:')) return ctx;
    } catch {
      // Not JSON: SessionStart's plain-text form is already handled above.
    }
  }
  return null;
}

/** What the model actually did and was shown, with the tool-call position of each. */
export function readTranscript(path: string, repoDir: string): Transcript {
  const t: Transcript = { toolCalls: 0, failedToolCalls: 0, editedFiles: [], editIndex: {}, injections: [], nexusMemToolCalls: 0 };

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: {
      message?: { role?: string; content?: unknown };
      attachment?: { type?: string; content?: unknown; stdout?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.attachment) {
      const text = hookInjection(entry.attachment);
      // The index is the tool-call count so far: an injection delivered here
      // was in front of the model before the next tool call it made.
      if (text) t.injections.push({ index: t.toolCalls, text });
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
            const rel = repoRelative(repoDir, filePath);
            if (!(rel in t.editIndex)) {
              t.editedFiles.push(rel);
              t.editIndex[rel] = t.toolCalls;
            }
          }
        }
      } else if (block.type === 'tool_result') {
        if (block.is_error === true) t.failedToolCalls += 1;
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        // Injections arrive as user-role text; what the assistant says about
        // NexusMem is the model noticing, not the hook speaking.
        if (entry.message?.role !== 'assistant' && text.includes('NexusMem:')) {
          for (const match of text.matchAll(/NexusMem:[\s\S]{0,1500}/g)) t.injections.push({ index: t.toolCalls, text: match[0] });
        }
      }
    }
  }
  return t;
}

function scoreRepo(repoDir: string, scenario: V2Scenario): { commandPasses: boolean; changed: string[] } {
  const [exe, ...rest] = scenario.command.split(' ');
  return { commandPasses: spawnSync(exe!, rest, { cwd: repoDir, encoding: 'utf8' }).status === 0, changed: changedFiles(repoDir) };
}

/** The arm's own setup on the trial instance: seeded memory, and hooks for ambient. Nothing else. */
export function setUpArm(arm: Arm, scenario: V2Scenario, paths: TrialPaths): void {
  if (arm !== 'control') seedMemory(scenario, paths);
  if (arm === 'ambient') cli(['agent', 'install', '--project', '-C', paths.repoDir], { ...process.env, NEXUSMEM_HOME: paths.nmHome });
}

/**
 * The deterministic pre-flight, run between arm setup and model launch, with
 * the trial's logical state captured on both sides of it. Delivery is proved
 * on a disposable twin (`verifyOnTwin`); the MCP server is spoken to on the
 * trial's own instance, and the diff below is what shows that doing so leaves
 * nothing behind. Any difference at all is a system failure: the model must
 * start from the seeded experiment state, not from a state a verifier wrote.
 */
export function preflightArm(
  arm: Arm,
  scenario: V2Scenario,
  paths: TrialPaths,
  proveDelivery: (scenario: V2Scenario, paths: TrialPaths) => string[] = (s) => verifyOnTwin(s),
): string[] {
  const before = logicalState(paths.repoDir, paths.nmHome);
  const problems: string[] = [];
  if (arm === 'ambient') problems.push(...proveDelivery(scenario, paths).map((p) => `delivery: ${p}`));
  if (arm === 'mcp') {
    const mcp = preflightMcp(paths);
    if (mcp) problems.push(mcp);
  }
  const leaked = stateDiff(before, logicalState(paths.repoDir, paths.nmHome));
  if (leaked.length > 0) problems.push(`pre-flight changed the trial's own state: ${leaked.join('; ')}`);
  return problems;
}

const emptyRecord = (trial: PlannedTrial): TrialRecord => ({
  scenario: trial.scenario,
  arm: trial.arm,
  repeat: trial.repeat,
  order: trial.order,
  editedFiles: [],
  editIndex: {},
  finalChangedFiles: [],
  commandPassesAfter: false,
  toolCalls: 0,
  failedToolCalls: 0,
  turns: 0,
  costUsd: 0,
  durationMs: 0,
  injections: [],
  nexusMemToolCalls: 0,
});

/** The only place a model is ever called. */
function callModel(arm: Arm, scenario: V2Scenario, paths: TrialPaths, runDir: string): { stdout: string; durationMs: number } {
  modelCalls += 1;
  const started = Date.now();
  const result = spawnSync('claude', claudeArgs(arm, paths, runDir), {
    cwd: paths.repoDir,
    env: { ...process.env, NEXUSMEM_HOME: paths.nmHome },
    encoding: 'utf8',
    input: scenario.task,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', durationMs: Date.now() - started };
}

function runTrial(trial: PlannedTrial, outDir: string, dryRun: boolean): { record: TrialRecord; workspace: string } {
  const scenario = V2_SCENARIOS.find((s) => s.name === trial.scenario)!;
  const runDir = join(outDir, 'trials', String(trial.order).padStart(3, '0'));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  // Neutral: the model sees its own working directory in every shell command
  // it writes, so the path must not spell out the scenario or the arm.
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'workspace-')));
  const paths: TrialPaths = { workspace, repoDir: join(workspace, 'app'), nmHome: join(workspace, 'nmhome') };
  writeFileSync(join(runDir, 'workspace.txt'), workspace);

  const fail = (why: string): { record: TrialRecord; workspace: string } => ({
    record: { ...emptyRecord(trial), systemFailure: why },
    workspace,
  });

  // The workspace was just made by mkdtemp, so it existed before only if
  // something else is writing into the same name.
  let problems = checkFreshWorkspace(paths, false);
  if (problems.length > 0) return fail(problems.join('; '));

  scenario.build(paths.repoDir);
  problems = checkCleanStart(paths);
  if (problems.length > 0) return fail(problems.join('; '));

  setUpArm(trial.arm, scenario, paths);
  problems = preflightArm(trial.arm, scenario, paths);
  if (problems.length > 0) return fail(problems.join('; '));

  problems = checkArmSetup(trial.arm, paths);
  if (problems.length > 0) return fail(problems.join('; '));

  if (dryRun) {
    // Everything above is what a real trial does. What a real trial does next
    // is the one thing a dry run must not: call the model.
    writeFileSync(join(runDir, 'dry-run.json'), JSON.stringify({ ...trial, workspace }, null, 2));
    return { record: emptyRecord(trial), workspace };
  }

  const { stdout, durationMs } = callModel(trial.arm, scenario, paths, runDir);
  let parsed: { session_id?: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number; is_error?: boolean } | null = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { record: { ...emptyRecord(trial), error: stdout.slice(0, 300), durationMs }, workspace };
  }

  const path = parsed?.session_id ? transcriptPath(parsed.session_id) : null;
  const t = path ? readTranscript(path, paths.repoDir) : null;
  if (path) writeFileSync(join(runDir, 'transcript.jsonl'), readFileSync(path));
  if (!t) return { record: { ...emptyRecord(trial), error: 'no transcript was written for this session', durationMs }, workspace };

  const { commandPasses, changed } = scoreRepo(paths.repoDir, scenario);
  return {
    record: {
      ...emptyRecord(trial),
      editedFiles: t.editedFiles,
      editIndex: t.editIndex,
      finalChangedFiles: changed,
      commandPassesAfter: commandPasses,
      toolCalls: t.toolCalls,
      failedToolCalls: t.failedToolCalls,
      turns: parsed?.num_turns ?? 0,
      costUsd: parsed?.total_cost_usd ?? 0,
      durationMs: parsed?.duration_ms ?? durationMs,
      injections: t.injections,
      nexusMemToolCalls: t.nexusMemToolCalls,
      ...(parsed?.is_error === true ? { error: 'the session ended in an error state' } : {}),
    },
    workspace,
  };
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && process.env.NEXUSMEM_EVAL_V2_AUTHORIZE !== '1') {
    throw new Error('refusing to run model trials: pass --dry-run, or set NEXUSMEM_EVAL_V2_AUTHORIZE=1 to authorise a real run');
  }
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);

  const outDir = resolve(process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) ?? join(tmpdir(), 'nexusmem-eval-v2'));
  mkdirSync(join(outDir, 'trials'), { recursive: true });

  const plan = planTrials(V2_SCENARIOS.map((s) => s.name), REPEATS);
  const prints = fingerprints();
  const product = productFingerprints(resolve('.'));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ seed: SEED, repeats: REPEATS, model: MODEL, maxTurns: MAX_TURNS, fingerprints: prints, product, trials: plan }, null, 2));

  process.stdout.write(
    `\nharder ambient-memory eval${dryRun ? ' (DRY RUN)' : ''}: ${V2_SCENARIOS.length} scenarios x ${REPEATS} repeats x ${ARMS.length} arms = ${plan.length} trials\n` +
      `  design fingerprint: ${prints.design}\n  product: source ${product.source ?? 'missing'}, build ${product.build ?? 'missing'}\n  out: ${outDir}\n\n`,
  );

  const records: TrialRecord[] = [];
  const scores: TrialScore[] = [];
  const workspaces: string[] = [];

  for (const trial of plan) {
    process.stdout.write(`  ${String(trial.order).padStart(3, '0')} ${trial.scenario.padEnd(18)} ${trial.arm.padEnd(8)} #${trial.repeat} ... `);
    const { record, workspace } = runTrial(trial, outDir, dryRun);
    workspaces.push(workspace);
    records.push(record);
    scores.push(scoreTrial(record, V2_SCENARIOS.find((s) => s.name === trial.scenario)!));
    writeFileSync(join(outDir, 'records.json'), JSON.stringify(records, null, 2));
    writeFileSync(join(outDir, 'scores.json'), JSON.stringify(scores, null, 2));
    process.stdout.write(record.systemFailure ? `SYSTEM FAILURE: ${record.systemFailure}\n` : dryRun ? 'ready\n' : `dead-end=${String(scores.at(-1)!.repeatedDeadEnd)} fixed=${record.commandPassesAfter}\n`);
    // Best-effort: a temp directory a just-exited child still holds open must
    // not fail the run.
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* left for the operating system to reap */
    }
  }

  const shared = checkDistinctWorkspaces(workspaces);
  for (const problem of shared) process.stdout.write(`  ISOLATION: ${problem}\n`);

  process.stdout.write('\n');
  if (!dryRun) {
    for (const arm of ARMS) {
      const s = summariseArm(arm, scores);
      process.stdout.write(
        `  ${arm.padEnd(8)} dead-end ${s.repeatedDeadEnd[0]}/${s.repeatedDeadEnd[1]}  fixed ${s.taskSuccess[0]}/${s.taskSuccess[1]}  stale ${s.staleEdit[0]}/${s.staleEdit[1]}  noise ${s.followedIrrelevantMemory[0]}/${s.followedIrrelevantMemory[1]}  useful ${s.usefulMemoryDelivery[0]}/${s.usefulMemoryDelivery[1]}  mcp-calls ${s.proactiveMcpCalls}  $${s.totalCostUsd.toFixed(2)}  (${s.excluded} excluded)\n`,
      );
    }
  }
  const systemFailures = records.filter((r) => r.systemFailure).length;
  process.stdout.write(`\n  trials prepared     ${records.length}\n  system failures     ${systemFailures}\n  isolation problems  ${shared.length}\n  MODEL CALL COUNT    ${modelCalls}\n\n  manifest: ${join(outDir, 'manifest.json')}\n\n`);
  if (dryRun && modelCalls !== 0) throw new Error(`a dry run made ${modelCalls} model call(s)`);
  process.exit(systemFailures > 0 || shared.length > 0 ? 1 : 0);
}

if (process.argv[1]?.split(/[\\/]/).pop() === 'run.ts') main();
