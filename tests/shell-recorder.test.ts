import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/ids.js';
import * as bashHook from '../src/hooks/bash.js';
import { hookStatus, installHook } from '../src/hooks/install.js';
import * as psHook from '../src/hooks/powershell.js';
import * as zshHook from '../src/hooks/zsh.js';
import { readHookLog } from '../src/shell/hook-log.js';
import { recordShellEvent, toHookLogLine } from '../src/shell/recorder.js';

/**
 * The raw command must never be durably written to a NexusMem-owned file:
 * hooks hand it to the recorder over stdin, and the recorder persists only the
 * redacted line. These tests pin that for the recorder itself, its failure and
 * crash paths, and each real shell available on the machine running them.
 */

const RECORDER = resolve('dist/cli/recorder.js'); // built by tests/global-setup.ts
const SECRET = 'rec-s3cret-VALUE';
const RAW = `export DB_PASSWORD=${SECRET}`;
const RAW_HASH = sha256Hex(RAW).slice(0, 12);
const event = (command = RAW) => JSON.stringify({ ts: '2026-09-10T03:00:00.000Z', cwd: 'D:/repo', exitCode: 0, durationMs: 7, command });

function filesContaining(dir: string, needle = SECRET): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...filesContaining(path, needle));
    else if (readFileSync(path).includes(needle)) hits.push(path);
  }
  return hits;
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for the recorder');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let home: string;
let tmp: string;
let logPath: string;
let childEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-recorder-')));
  tmp = join(home, 'tmp');
  mkdirSync(tmp);
  logPath = join(home, 'nm', 'shell-history.jsonl');
  // Any temp file a child might create lands here, inside the tree every test scans.
  childEnv = { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('toHookLogLine / recordShellEvent', () => {
  it('hashes the raw command, then persists only the redacted command', async () => {
    const line = JSON.parse(toHookLogLine(event(), 'bash-hook')!);
    expect(line).toEqual({
      ts: '2026-09-10T03:00:00.000Z',
      cwd: 'D:/repo',
      exitCode: 0,
      durationMs: 7,
      command: 'export DB_PASSWORD: [redacted]',
      shell: 'bash-hook',
      commandHash: RAW_HASH,
    });

    expect(await recordShellEvent(event(), logPath, 'pwsh-hook')).toBe(true);
    const { entries } = await readHookLog(logPath, 0);
    expect(entries).toEqual([expect.objectContaining({ command: 'export DB_PASSWORD: [redacted]', commandHash: RAW_HASH, shell: 'pwsh-hook' })]);
    expect(filesContaining(home)).toEqual([]);
  });

  it('tolerates the BOM Windows PowerShell appends when it closes a redirected stdin (found live)', () => {
    const BOM = String.fromCharCode(0xfeff);
    for (const raw of [`${event()}${BOM}`, `${BOM}${event()}`, `${event()}\r\n`]) {
      expect(JSON.parse(toHookLogLine(raw, 'pwsh-hook')!)).toMatchObject({ command: 'export DB_PASSWORD: [redacted]', commandHash: RAW_HASH });
    }
  });

  it.each([
    ['malformed JSON', `{"command":"${RAW}"`, 'bash-hook'],
    ['unknown shell', event(), 'fish-hook'],
    ['missing command', JSON.stringify({ ts: 't', cwd: 'c' }), 'bash-hook'],
    ['blank command', event('   '), 'bash-hook'],
  ])('drops %s instead of writing anything', async (_label, raw, shell) => {
    expect(toHookLogLine(raw, shell)).toBeNull();
    expect(await recordShellEvent(raw, logPath, shell)).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('recorder process: success, failure and crash boundaries', () => {
  function run(input: string, args: string[], opts: { killAfterMs?: number } = {}) {
    const child = spawn(process.execPath, [RECORDER, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    // The recorder exits early on an oversized event, so writing the rest can EPIPE; that is the expected drop.
    child.stdin.on('error', () => {});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.write(input);
    if (opts.killAfterMs === undefined) child.stdin.end();
    else setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
      child.on('close', (code) => done({ code, stdout, stderr })),
    );
  }

  it('writes the redacted line and nothing else, anywhere', async () => {
    const r = await run(event(), ['--log', logPath, '--shell', 'bash-hook']);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readFileSync(logPath, 'utf8')).toContain('export DB_PASSWORD: [redacted]');
    expect(filesContaining(home)).toEqual([]);
  });

  it('accepts an event with the trailing BOM Windows PowerShell 5.1 writes when it closes the pipe', async () => {
    const r = await run(`${event()}${String.fromCharCode(0xfeff)}`, ['--log', logPath, '--shell', 'pwsh-hook']);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readFileSync(logPath, 'utf8')).toContain('export DB_PASSWORD: [redacted]');
    expect(filesContaining(home)).toEqual([]);
  });

  it('crash boundary: killed after receiving the raw command, before persisting it, leaves no trace', async () => {
    // stdin is left open, so the recorder holds the raw bytes in memory but has not written yet.
    const r = await run(event(), ['--log', logPath, '--shell', 'bash-hook'], { killAfterMs: 500 });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(logPath)).toBe(false);
    expect(filesContaining(home)).toEqual([]);
  });

  it('never echoes a malformed event -- a JSON.parse error message would quote the raw command', async () => {
    const r = await run(`{"command":"${RAW}"`, ['--log', logPath, '--shell', 'bash-hook']);
    expect(r).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(filesContaining(home)).toEqual([]);
  });

  it('fails silently, with no fallback write, when the log cannot be written', async () => {
    const blocker = join(home, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const r = await run(event(), ['--log', join(blocker, 'shell-history.jsonl'), '--shell', 'bash-hook']);
    expect(r).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(filesContaining(home)).toEqual([]);
  });

  it('drops an oversized event without writing', async () => {
    const r = await run(event(`${RAW} ${'x'.repeat(1_100_000)}`), ['--log', logPath, '--shell', 'bash-hook']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('installed hook blocks', () => {
  const recorder = { node: process.execPath, script: RECORDER };

  it('no hook writes the log file itself -- every shell hands the event to the recorder', () => {
    const ps = psHook.renderHookSnippet('C:/log.jsonl', recorder);
    expect(ps).not.toContain('Add-Content');
    expect(ps).toContain('[System.Diagnostics.Process]::Start($__ssd_psi)');
    for (const [snippet, shell] of [
      [bashHook.renderHookSnippet('/log.jsonl', recorder), 'bash-hook'],
      [zshHook.renderHookSnippet('/log.jsonl', recorder), 'zsh-hook'],
    ] as const) {
      expect(snippet).not.toMatch(/>>\s*"\$__nxm_log_path"/);
      expect(snippet).toContain(`"$__nxm_node" "$__nxm_recorder" --log "$__nxm_log_path" --shell ${shell}`);
    }
  });

  it('hook status flags a pre-recorder block as outdated until it is reinstalled', async () => {
    const profilePath = join(home, 'profile.ps1');
    const legacyBlock = [
      '# >>> nexusmem shell hook >>>',
      "$global:__ssd_log_path = 'C:/log.jsonl'",
      'function global:prompt { Add-Content -LiteralPath $global:__ssd_log_path -Value "raw" }',
      '# <<< nexusmem shell hook <<<',
      '',
    ].join('\r\n');
    writeFileSync(profilePath, legacyBlock);
    const target = { shell: 'pwsh' as const, profilePath, logPath };

    expect(await hookStatus(target)).toEqual({ installed: true, upToDate: false });
    await installHook(target);
    expect(await hookStatus(target)).toEqual({ installed: true, upToDate: true });
  });
});

/** Shell capture end to end: each real shell's hook, through the built recorder, into a real log. */
describe('real shell capture', () => {
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const hasCommand = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
  const wslReady = process.platform === 'win32' && hasCommand('wsl', ['-e', 'sh', '-c', 'command -v bash && command -v node']);
  const nativeBash = process.platform !== 'win32' && hasCommand('bash', ['-c', 'true']);
  const nativeZsh = process.platform !== 'win32' && hasCommand('zsh', ['-c', 'true']);
  const toWsl = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');

  async function expectRecorded(shell: string, command = RAW, redacted = 'export DB_PASSWORD: [redacted]') {
    await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').trim().length > 0);
    const { entries } = await readHookLog(logPath, 0);
    expect(entries).toEqual([expect.objectContaining({ command: redacted, shell, commandHash: sha256Hex(command).slice(0, 12) })]);
    expect(filesContaining(home)).toEqual([]);
  }

  it.skipIf(process.platform !== 'win32')('Windows PowerShell: the prompt hook passes the command to the recorder, which writes it redacted', async () => {
    const command = `$env:DB_PASSWORD='${SECRET}' # ทดสอบ`;
    const profile = join(home, 'profile.ps1');
    writeFileSync(profile, psHook.renderHookSnippet(logPath, { node: process.execPath, script: RECORDER }));
    // -Command sessions keep no history, so seed the entry an interactive prompt() would see after
    // this command ran. Add-History needs bare DateTimes: (Get-Date) inside @{} is PSObject-wrapped.
    const script = [
      `. '${profile}'`,
      `[pscustomobject]@{ CommandLine = '${command.replace(/'/g, "''")}'; ExecutionStatus = 'Completed'; StartExecutionTime = [datetime]::Now.AddSeconds(-1); EndExecutionTime = [datetime]::Now } | Add-History`,
      '$null = prompt',
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    await expectRecorded('pwsh-hook', command, `$env:DB_PASSWORD: [redacted] # ทดสอบ`);
  }, 30_000);

  it.skipIf(process.platform !== 'win32' || !existsSync(GIT_BASH))('Git Bash: the DEBUG trap + precmd pass the command to the recorder', async () => {
    const profile = join(home, 'hook.bash');
    writeFileSync(profile, bashHook.renderHookSnippet(logPath, { node: process.execPath, script: RECORDER }));
    const r = spawnSync(GIT_BASH, ['-c', `source '${profile.replace(/\\/g, '/')}'\n${RAW}\n__nxm_precmd`], { env: childEnv, encoding: 'utf8' });
    expect(r.status).toBe(0);
    await expectRecorded('bash-hook');
  }, 30_000);

  it.skipIf(!wslReady)('WSL bash with a Linux node: the same hook and recorder', async () => {
    const profile = join(home, 'hook.bash');
    writeFileSync(profile, bashHook.renderHookSnippet(toWsl(logPath), { node: 'node', script: toWsl(RECORDER) }));
    const r = spawnSync('wsl', ['-e', 'bash', '-c', `source '${toWsl(profile)}'\n${RAW}\n__nxm_precmd\nsleep 3`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    await expectRecorded('bash-hook');
  }, 60_000);

  it.skipIf(!nativeBash)('bash: the DEBUG trap + precmd pass the command to the recorder', async () => {
    const profile = join(home, 'hook.bash');
    writeFileSync(profile, bashHook.renderHookSnippet(logPath, { node: process.execPath, script: RECORDER }));
    const r = spawnSync('bash', ['-c', `source '${profile}'\n${RAW}\n__nxm_precmd`], { env: childEnv, encoding: 'utf8' });
    expect(r.status).toBe(0);
    await expectRecorded('bash-hook');
  }, 30_000);

  it.skipIf(!nativeZsh)('zsh: preexec + precmd pass the command to the recorder', async () => {
    const profile = join(home, 'hook.zsh');
    writeFileSync(profile, zshHook.renderHookSnippet(logPath, { node: process.execPath, script: RECORDER }));
    const r = spawnSync('zsh', ['-c', `source '${profile}'\n__nxm_preexec '${RAW}'\n__nxm_precmd`], { env: childEnv, encoding: 'utf8' });
    expect(r.status).toBe(0);
    await expectRecorded('zsh-hook');
  }, 30_000);
});
