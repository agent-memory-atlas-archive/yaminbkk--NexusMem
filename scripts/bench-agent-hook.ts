import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { hrtime } from 'node:process';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseHookPayloadDetailed } from '../src/adapters/claude-code/payload.js';
import { appendAgentEvent } from '../src/agent/record.js';

/**
 * Measures what the agent hook actually costs, before anyone optimizes it.
 *
 * The hook runs once per tool call, in front of the agent, so the number that
 * matters is wall time from spawn to exit -- not the time our own code spends.
 * Those are reported separately: an interpreter that takes 40ms to start is
 * not a redaction problem, and knowing which is which is the whole point.
 *
 *   npm run build && npx tsx scripts/bench-agent-hook.ts [samples]
 *
 * Prints a table; writes nothing to the repository.
 */

const HOOK = resolve('dist/cli/agent-hook.js');
const SAMPLES = Number(process.argv[2] ?? 40);
const MICRO_ITERATIONS = 2000;

const bashFailure = (errorChars = 60) => ({
  session_id: 'bench',
  cwd: process.cwd(),
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'npm test -- --runInBand', description: 'run the tests' },
  tool_use_id: 'toolu_bench_fail',
  error: `Exit code 1\n${'AssertionError: expected 1 to be 2. '.repeat(Math.ceil(errorChars / 38)).slice(0, errorChars)}`,
  is_interrupt: false,
  duration_ms: 1200,
});

const PAYLOADS: Array<{ name: string; payload: object }> = [
  {
    name: 'SessionStart (dropped by capture)',
    payload: { session_id: 'bench', cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'startup' },
  },
  {
    name: 'Edit (PostToolUse)',
    payload: {
      session_id: 'bench',
      cwd: process.cwd(),
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(process.cwd(), 'src/agent/recall.ts'), old_string: 'a'.repeat(400), new_string: 'b'.repeat(400) },
      tool_use_id: 'toolu_bench_edit',
      duration_ms: 4,
    },
  },
  {
    name: 'Bash success',
    payload: {
      session_id: 'bench',
      cwd: process.cwd(),
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'run the tests' },
      tool_response: { stdout: 'ok\n'.repeat(50), stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      tool_use_id: 'toolu_bench_ok',
      duration_ms: 900,
    },
  },
  { name: 'Bash failure', payload: bashFailure() },
  { name: 'Bash failure, 256 KB error', payload: bashFailure(256 * 1024) },
];

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return Number.NaN;
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)]!;
}

const fmt = (ms: number): string => (Number.isNaN(ms) ? '-' : `${ms.toFixed(1)}ms`);

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const p99 = sorted.length >= 100 ? fmt(percentile(sorted, 99)) : 'n<100';
  process.stdout.write(
    `${label.padEnd(34)} n=${String(sorted.length).padStart(4)}  median ${fmt(percentile(sorted, 50)).padStart(8)}  p95 ${fmt(
      percentile(sorted, 95),
    ).padStart(8)}  p99 ${p99.padStart(8)}\n`,
  );
}

function runHook(payload: object, logPath: string): Promise<number> {
  const started = hrtime.bigint();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK, '--log', logPath], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('error', fail);
    child.on('close', () => done(Number(hrtime.bigint() - started) / 1e6));
  });
}

/** Interpreter startup alone, so the hook's own work can be read as the difference. */
function runEmptyNode(): Promise<number> {
  const started = hrtime.bigint();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', () => done(Number(hrtime.bigint() - started) / 1e6));
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'nexusmem-bench-'));
  const logPath = join(dir, 'agent-events.jsonl');
  const now = new Date().toISOString();

  process.stdout.write(
    `\nagent-hook benchmark\n  ${platform()} ${release()} ${arch()}, ${cpus().length} cores, node ${process.version}\n` +
      `  ${SAMPLES} spawns per payload, ${MICRO_ITERATIONS} in-process iterations\n\n`,
  );

  try {
    process.stdout.write('end to end (spawn -> exit), which is what the agent waits for\n');
    const baseline: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) baseline.push(await runEmptyNode());
    report('node -e 0 (startup floor)', baseline);

    for (const { name, payload } of PAYLOADS) {
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) samples.push(await runHook(payload, logPath));
      report(name, samples);
    }

    process.stdout.write('\nin process, per event (excludes interpreter startup)\n');
    for (const { name, payload } of PAYLOADS) {
      const raw = JSON.stringify(payload);
      const parseSamples: number[] = [];
      for (let i = 0; i < MICRO_ITERATIONS; i += 1) {
        const started = hrtime.bigint();
        parseHookPayloadDetailed(raw, now);
        parseSamples.push(Number(hrtime.bigint() - started) / 1e6);
      }
      report(`parse + redact: ${name}`, parseSamples);
    }

    const parsed = parseHookPayloadDetailed(JSON.stringify(PAYLOADS[3]!.payload), now);
    if (parsed.ok) {
      const appendSamples: number[] = [];
      for (let i = 0; i < MICRO_ITERATIONS / 4; i += 1) {
        const started = hrtime.bigint();
        await appendAgentEvent(parsed.event, logPath);
        appendSamples.push(Number(hrtime.bigint() - started) / 1e6);
      }
      report('append one line', appendSamples);
    }
    process.stdout.write('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
