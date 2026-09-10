import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectShellHistory } from '../src/collectors/shell-history.js';
import { sha256Hex } from '../src/core/ids.js';
import { collectAvailableShellHistory } from '../src/shell/detect.js';
import { sanitizeHookLog } from '../src/shell/hook-log.js';
import { hookLogPath } from '../src/shell/paths.js';

/**
 * The installed shell hooks append every command raw to one shared JSONL log;
 * sanitizeHookLog is what keeps a typed secret from staying there.
 */

const REPO = 'D:/work/repo';
const line = (command: string, ts = '2026-09-10T01:00:00.000Z') =>
  JSON.stringify({ ts, cwd: REPO, exitCode: 0, durationMs: 5, command });

const ENV_KEYS = ['HISTFILE_BASH', 'HISTFILE', 'APPDATA', 'NEXUSMEM_HOME'] as const;
let home: string;
let logPath: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexusmem-hook-sanitize-'));
  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Only the fixture log is visible -- never this machine's real history or hook log.
  process.env.HISTFILE_BASH = join(home, 'no_bash');
  process.env.HISTFILE = join(home, 'no_zsh');
  process.env.APPDATA = join(home, 'no_appdata');
  process.env.NEXUSMEM_HOME = join(home, 'nm');
  logPath = join(home, 'shell-history.jsonl');
});

afterEach(() => {
  for (const k of ENV_KEYS) process.env[k] = prevEnv[k];
  rmSync(home, { recursive: true, force: true });
});

describe('sanitizeHookLog', () => {
  it('redacts secret-bearing commands and keeps line count, order, CRLF and every other line byte-for-byte', async () => {
    const lines = [
      line('npm test'),
      line('export DB_PASSWORD=my-secret'),
      line('psql postgres://app:my-secret@db/app'),
      '{"ts": "torn-without-secret',
      line('git status'),
    ];
    // PowerShell's Add-Content writes CRLF.
    writeFileSync(logPath, `${lines.join('\r\n')}\r\n`);

    const result = await sanitizeHookLog(logPath);

    expect(result.linesChanged).toBe(2);
    const after = readFileSync(logPath, 'utf8');
    expect(after).not.toContain('my-secret');
    const afterLines = after.split('\r\n');
    expect(afterLines).toHaveLength(lines.length + 1);
    expect(afterLines[0]).toBe(lines[0]);
    expect(afterLines[3]).toBe(lines[3]);
    expect(afterLines[4]).toBe(lines[4]);
    expect(JSON.parse(afterLines[1]!)).toMatchObject({
      command: 'export DB_PASSWORD: [redacted]',
      commandHash: sha256Hex('export DB_PASSWORD=my-secret').slice(0, 12),
      cwd: REPO,
      exitCode: 0,
    });
  });

  it('redacts a torn line that still holds a secret', async () => {
    writeFileSync(logPath, `${line('ls')}\n{"ts":"x","cwd":"c","command":"export API_TOKEN=my-secret\n`);
    await sanitizeHookLog(logPath);
    expect(readFileSync(logPath, 'utf8')).not.toContain('my-secret');
  });

  it('is idempotent: a second run changes nothing and leaves the file byte-identical', async () => {
    writeFileSync(logPath, `${line('export DB_PASSWORD=my-secret')}\n${line('npm test')}\n`);
    await sanitizeHookLog(logPath);
    const once = readFileSync(logPath);

    expect(await sanitizeHookLog(logPath)).toEqual({ linesChanged: 0 });
    expect(readFileSync(logPath).equals(once)).toBe(true);
  });

  it('dryRun counts without writing', async () => {
    const raw = `${line('export DB_PASSWORD=my-secret')}\n`;
    writeFileSync(logPath, raw);
    expect(await sanitizeHookLog(logPath, { dryRun: true })).toEqual({ linesChanged: 1 });
    expect(readFileSync(logPath, 'utf8')).toBe(raw);
  });

  it('is a no-op for a missing log and leaves no temp file behind', async () => {
    expect(await sanitizeHookLog(logPath)).toEqual({ linesChanged: 0 });
    expect(existsSync(logPath)).toBe(false);
  });

  it('keeps shell node ids and meta.commandHash identical before and after the log is sanitized', async () => {
    const path = hookLogPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [line('export DB_PASSWORD=my-secret', '2026-09-10T01:00:00.000Z'), line('curl -u admin:my-secret https://x', '2026-09-10T01:00:01.000Z')].join('\n') +
        '\n',
      { flag: 'w' },
    );

    const read = async () => {
      const results = await collectAvailableShellHistory({ repoRoot: REPO });
      const hook = results.find((r) => r.name === 'pwsh-hook')!;
      return collectShellHistory(hook.entries, 'proj1');
    };

    const before = await read();
    await sanitizeHookLog(path);
    expect(readFileSync(path, 'utf8')).not.toContain('my-secret');
    const after = await read();

    expect(after.map((n) => n.id)).toEqual(before.map((n) => n.id));
    expect(after.map((n) => n.meta.commandHash)).toEqual(before.map((n) => n.meta.commandHash));
    expect(after.map((n) => n.meta.commandHash)).toEqual([
      sha256Hex('export DB_PASSWORD=my-secret').slice(0, 12),
      sha256Hex('curl -u admin:my-secret https://x').slice(0, 12),
    ]);
    expect(JSON.stringify(after)).not.toContain('my-secret');
  });
});
