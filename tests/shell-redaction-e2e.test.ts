import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { listRecentMemory, searchMemory } from '../src/mcp/tools.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * A secret typed at a shell prompt must be gone before it is persisted, not
 * just before it is displayed: this walks real bash history through `sync`
 * into the store, the FTS index, and both MCP read tools.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const ENV_KEYS = ['HISTFILE_BASH', 'HISTFILE', 'APPDATA', 'NEXUSMEM_HOME'] as const;

let dir: string;
let homeDir: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-shell-redact-'));
  homeDir = mkdtempSync(join(tmpdir(), 'nexusmem-shell-redact-home-'));
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');

  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Only this fixture's history is visible -- never the real machine's.
  process.env.HISTFILE_BASH = join(homeDir, 'bash_history');
  process.env.HISTFILE = join(homeDir, 'zsh_history_unused');
  process.env.APPDATA = join(homeDir, 'AppData_unused');
  process.env.NEXUSMEM_HOME = join(homeDir, '.nexusmem-home');

  writeFileSync(
    join(homeDir, 'bash_history'),
    '#1700000000\nexport PASSWORD=my-secret\n#1700000100\nexport DB_PASSWORD=my-secret\n#1700000200\nDB_PASSWORD="my-secret" psql -h db\n',
  );

  await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
  await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) process.env[k] = prevEnv[k];
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('shell secret redaction, end to end', () => {
  it('persists no secret in any nodes column or in the FTS index', () => {
    const store = MemoryStore.open(resolveWorkspace(dir).dbPath);
    try {
      const rows = store.raw.prepare(`SELECT * FROM nodes WHERE kind = 'shell_command'`).all();
      expect(rows).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain('my-secret');

      const ftsHits = store.raw.prepare(`SELECT COUNT(*) AS c FROM nodes_fts WHERE nodes_fts MATCH 'secret'`).get() as { c: number };
      expect(ftsHits.c).toBe(0);
    } finally {
      store.close();
    }
  });

  it('returns the redacted command, never the secret, through MCP search_memory and list_recent_memory', async () => {
    const search = await searchMemory({ projectRoot: dir, query: 'export DB_PASSWORD psql', noVector: true });
    expect(search.text).toContain('DB_PASSWORD: [redacted]');
    expect(search.text).not.toContain('my-secret');

    const recent = await listRecentMemory({ projectRoot: dir, limit: 50 });
    expect(recent.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(recent)).not.toContain('my-secret');
  });
});
