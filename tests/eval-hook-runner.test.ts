import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InstalledSettings, runInstalledHooks } from '../eval/ambient/hook-runner.js';

/**
 * A hook that never finished successfully must never read as the silence an
 * EXIT:0 or dedup probe is looking for: `wait` with no PID returns 0 whatever
 * its children did, which made check O able to pass on a crashed hook.
 */

const RECALL_OUTPUT = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"NexusMem: ..."}}';
const EVENT = 'PostToolUse';

let dir: string;
const node = `"${process.execPath.split('\\').join('/')}"`;
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return `${node} "${path.split('\\').join('/')}"`;
};
/** Named so the runner finds it the way it finds the real one. */
const asRecall = (command: string) => `${command} agent recall --trigger failure`;

const settingsFor = (...commands: string[]): InstalledSettings => ({
  hooks: { [EVENT]: [{ matcher: 'Bash', hooks: commands.map((command) => ({ command })) }] },
});
const run = (settings: InstalledSettings, timeoutMs?: number) =>
  runInstalledHooks(settings, EVENT, { session_id: 's', tool_use_id: 't' }, process.env, timeoutMs ? { timeoutMs } : {});

let ok: string;
let fail: string;
let recallOk: string;
let recallFail: string;
let hang: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-hook-runner-'));
  ok = script('ok.cjs', 'process.exit(0);\n');
  fail = script('fail.cjs', 'process.exit(3);\n');
  recallOk = asRecall(script('recall-ok.cjs', `process.stdout.write(${JSON.stringify(RECALL_OUTPUT)});\n`));
  recallFail = asRecall(script('recall-fail.cjs', 'process.exit(4);\n'));
  hang = asRecall(script('hang.cjs', 'setTimeout(() => {}, 60_000);\n'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('runInstalledHooks', () => {
  it('returns what the recall hook printed when every hook succeeds', () => {
    expect(run(settingsFor(ok, recallOk))).toEqual({ recall: RECALL_OUTPUT });
  });

  it('accepts a single successful recall hook', () => {
    expect(run(settingsFor(recallOk))).toEqual({ recall: RECALL_OUTPUT });
  });

  it('reports an empty recall as an empty string, not as a failure', () => {
    const silent = asRecall(script('silent.cjs', 'process.exit(0);\n'));
    expect(run(settingsFor(ok, silent))).toEqual({ recall: '' });
  });

  it.each([
    ['the failing hook runs first', () => settingsFor(fail, recallOk)],
    ['the failing hook runs last', () => settingsFor(ok, recallFail)],
    ['the recall hook itself fails', () => settingsFor(recallFail)],
    ['every hook fails', () => settingsFor(fail, recallFail)],
  ])('fails closed when %s', (_label, build) => {
    const result = run(build());
    expect(typeof result).toBe('string');
    expect(result).toContain('did not finish successfully');
  });

  it('fails closed when no hooks are installed on the event', () => {
    expect(run({ hooks: { [EVENT]: [] } })).toBe(`no hooks are installed on ${EVENT}`);
  });

  it('fails closed when hooks are installed but none of them is recall', () => {
    expect(run(settingsFor(ok))).toBe(`no recall hook is installed on ${EVENT}`);
  });

  it('fails closed when a hook never finishes, rather than hanging the probe', () => {
    const result = run(settingsFor(hang), 2_000);
    expect(typeof result).toBe('string');
    expect(result).toContain('did not finish successfully');
  });
});
