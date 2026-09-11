import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildScenarioRepo, RETRY_REGRESSION, type Scenario, seedAgentEvents } from '../eval/ambient/scenario.js';

/**
 * Does ambient memory change what the agent does?
 *
 * Three arms against the same repository and the same task:
 *
 *   baseline  git history only, no NexusMem at all
 *   mcp       NexusMem reachable as MCP tools, never mentioned in the prompt
 *   ambient   NexusMem's own hooks installed
 *
 * The history that records both abandoned attempts is in git for every arm,
 * so the baseline is not deprived of the information -- only of anything that
 * puts it in front of the model. The task never mentions memory.
 *
 * Scoring is mechanical: which files were edited, whether the command passes
 * afterwards, how many tool calls it took, and how many characters NexusMem
 * injected. Model behaviour is variable, so this is a measurement, not a test.
 *
 *   npm run build && npx tsx scripts/eval-ambient.ts [repeats] [outDir]
 */

const CLI = resolve('dist/cli/index.js');
const ARMS = ['baseline', 'mcp', 'ambient'] as const;
type Arm = (typeof ARMS)[number];

const REPEATS = Number(process.argv[2] ?? 2);
const OUT_DIR = resolve(process.argv[3] ?? join(process.env.TEMP ?? '/tmp', 'nexusmem-eval-ambient'));
const MAX_TURNS = 25;

interface RunResult {
  arm: Arm;
  repeat: number;
  ok: boolean;
  /** Did the agent touch a file a previous attempt already proved is not the cause? */
  repeatedDeadEnd: boolean;
  editedFixFile: boolean;
  commandPassesAfter: boolean;
  toolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Characters NexusMem put into the model's context. 0 for arms that cannot. */
  injectedChars: number;
  nexusMemToolCalls: number;
  error?: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** A NexusMem database holding day 1: two failed attempts and the fix. */
function seedMemory(repoDir: string, nmHome: string): void {
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  mkdirSync(nmHome, { recursive: true });
  run(process.execPath, [CLI, 'init', '-C', repoDir], { env });

  // Without this the sync scrapes this machine's real shell history into the fixture.
  const configPath = join(repoDir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const events = seedAgentEvents(repoDir);
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  run(process.execPath, [CLI, 'sync', '-C', repoDir, '--no-embed', '--quiet'], { env });
}

/**
 * The task goes in on stdin, never as an argument: a prompt passed through a
 * Windows shell shim is concatenated rather than escaped, which silently
 * mangles it -- the first run of this eval scored three arms of a garbled
 * prompt before that showed up.
 */
function claudeArgs(arm: Arm, repoDir: string, runDir: string): string[] {
  // Every arm is isolated from whatever MCP servers this machine has configured,
  // so only the mcp arm can reach NexusMem that way.
  const emptyMcp = join(runDir, 'mcp-empty.json');
  writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));

  const args = [
    '-p',
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

  if (arm === 'ambient') args.push('--settings', join(repoDir, '.claude', 'settings.local.json'));
  return args;
}

/** Reads the session transcript for what the model actually did and was shown. */
function readTranscript(sessionId: string): { toolCalls: number; injectedChars: number; nexusMemToolCalls: number } {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return { toolCalls: 0, injectedChars: 0, nexusMemToolCalls: 0 };

  for (const slug of readdirSync(root)) {
    const path = join(root, slug, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;

    let toolCalls = 0;
    let injectedChars = 0;
    let nexusMemToolCalls = 0;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      toolCalls += (line.match(/"type":"tool_use"/g) ?? []).length;
      nexusMemToolCalls += (line.match(/"name":"mcp__nexusmem__/g) ?? []).length;
      // What NexusMem put in front of the model, hook injections included.
      for (const match of line.matchAll(/NexusMem: [^"\\]{0,1200}/g)) injectedChars += match[0].length;
    }
    return { toolCalls, injectedChars, nexusMemToolCalls };
  }
  return { toolCalls: 0, injectedChars: 0, nexusMemToolCalls: 0 };
}

function scoreRepo(repoDir: string, scenario: Scenario): { edited: string[]; commandPasses: boolean } {
  const edited = run('git', ['-C', repoDir, 'diff', '--name-only', 'HEAD'])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const [exe, ...rest] = scenario.command.split(' ');
  const check = spawnSync(exe!, rest, { cwd: repoDir, encoding: 'utf8' });
  return { edited, commandPasses: check.status === 0 };
}

async function runOnce(scenario: Scenario, arm: Arm, repeat: number): Promise<RunResult> {
  const runDir = join(OUT_DIR, scenario.name, arm, String(repeat));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const repoDir = join(runDir, 'repo');
  const nmHome = join(runDir, 'nmhome');

  buildScenarioRepo(repoDir);
  if (arm !== 'baseline') seedMemory(repoDir, nmHome);
  if (arm === 'ambient') {
    run(process.execPath, [CLI, 'agent', 'install', '--project', '-C', repoDir], { env: { ...process.env, NEXUSMEM_HOME: nmHome } });
  }

  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  const started = Date.now();
  const result = spawnSync('claude', claudeArgs(arm, repoDir, runDir), {
    cwd: repoDir,
    env,
    encoding: 'utf8',
    input: scenario.task,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });

  const base = { arm, repeat, toolCalls: 0, turns: 0, costUsd: 0, durationMs: Date.now() - started, injectedChars: 0, nexusMemToolCalls: 0 };
  let parsed: { session_id?: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number; is_error?: boolean } | null = null;
  try {
    parsed = JSON.parse(result.stdout ?? '');
  } catch {
    return { ...base, ok: false, repeatedDeadEnd: false, editedFixFile: false, commandPassesAfter: false, error: (result.stderr ?? '').slice(0, 300) };
  }

  const transcript = parsed?.session_id ? readTranscript(parsed.session_id) : { toolCalls: 0, injectedChars: 0, nexusMemToolCalls: 0 };
  const { edited, commandPasses } = scoreRepo(repoDir, scenario);

  return {
    ...base,
    ...transcript,
    ok: parsed?.is_error !== true,
    repeatedDeadEnd: edited.some((file) => scenario.deadEndFiles.includes(file)),
    editedFixFile: edited.includes(scenario.fixFile),
    commandPassesAfter: commandPasses,
    turns: parsed?.num_turns ?? 0,
    costUsd: parsed?.total_cost_usd ?? 0,
    durationMs: parsed?.duration_ms ?? Date.now() - started,
  };
}

function summarize(results: readonly RunResult[]): string {
  const rows = ARMS.map((arm) => {
    const runs = results.filter((r) => r.arm === arm);
    const n = runs.length || 1;
    const rate = (predicate: (r: RunResult) => boolean) => `${runs.filter(predicate).length}/${runs.length}`;
    const mean = (pick: (r: RunResult) => number) => runs.reduce((sum, r) => sum + pick(r), 0) / n;
    return [
      arm.padEnd(9),
      `dead end ${rate((r) => r.repeatedDeadEnd).padEnd(5)}`,
      `fixed ${rate((r) => r.commandPassesAfter).padEnd(5)}`,
      `fix file ${rate((r) => r.editedFixFile).padEnd(5)}`,
      `tools ${mean((r) => r.toolCalls).toFixed(1).padStart(5)}`,
      `turns ${mean((r) => r.turns).toFixed(1).padStart(5)}`,
      `injected ${mean((r) => r.injectedChars).toFixed(0).padStart(5)} chars`,
      `nexusmem calls ${mean((r) => r.nexusMemToolCalls).toFixed(1)}`,
      `$${mean((r) => r.costUsd).toFixed(3)}`,
    ].join('  ');
  });
  return rows.join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
  const scenario = RETRY_REGRESSION;
  const results: RunResult[] = [];

  process.stdout.write(`\nambient-memory eval: ${scenario.name}, ${REPEATS} run(s) per arm\n  out: ${OUT_DIR}\n\n`);
  for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
    for (const arm of ARMS) {
      process.stdout.write(`  ${arm} #${repeat} ... `);
      const result = await runOnce(scenario, arm, repeat);
      results.push(result);
      process.stdout.write(
        `${result.ok ? '' : 'ERROR '}dead-end=${result.repeatedDeadEnd} fixed=${result.commandPassesAfter} tools=${result.toolCalls} injected=${result.injectedChars}\n`,
      );
    }
  }

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${summarize(results)}\n\nraw: ${join(OUT_DIR, 'results.json')}\n\n`);
}

await main();
