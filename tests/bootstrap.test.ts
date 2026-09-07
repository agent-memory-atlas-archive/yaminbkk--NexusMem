import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { collectShellHistory } from '../src/collectors/shell-history.js';
import { correlateFailures } from '../src/correlate/failure-fix.js';
import { makeProjectId } from '../src/core/project.js';
import { readRepoInfo } from '../src/git/repo.js';
import { parsePsReadLineHistory } from '../src/shell/parse-psreadline.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function initRepo(dir: string): void {
  gitFixture(dir, ['init', '-q', '-b', 'main']);
  gitFixture(dir, ['config', 'user.email', 'test@example.com']);
  gitFixture(dir, ['config', 'user.name', 'Test User']);
}

function commit(dir: string, message: string, date: string): void {
  gitFixture(dir, ['add', '.']);
  gitFixture(dir, ['commit', '-q', '-m', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('historical bootstrap', () => {
  it('backfills old commits, diffs and docs idempotently and retrieves them immediately', async () => {
    const dir = tempDir('nexusmem-bootstrap-');
    initRepo(dir);
    writeFileSync(join(dir, 'README.md'), '# Architecture\n\nThe amber cache exists because cold reads are expensive.\n');
    writeFileSync(join(dir, 'cache.ts'), 'export const cache = "amber";\n');
    commit(dir, 'feat: add amber cache', '2020-01-02T03:04:05Z');

    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: () => {} });

    const repo = await readRepoInfo(dir);
    const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });
    const store = MemoryStore.open(join(dir, '.nexusmem', 'memory.db'));
    try {
      const firstCount = store.stats(projectId).total;
      expect(firstCount).toBeGreaterThanOrEqual(3);

      const hits = store.search(projectId, 'amber cache', 20);
      expect(hits.some((hit) => hit.kind === 'git_commit' && hit.captureMode === 'backfilled')).toBe(true);
      expect(hits.some((hit) => hit.kind === 'doc_section' && hit.provenance === 'authored' && hit.captureMode === 'backfilled')).toBe(true);
      expect(hits.some((hit) => hit.kind === 'code_diff' && hit.captureMode === 'backfilled')).toBe(true);

      await runSync({ cwd: dir, full: true, rebuild: false, quiet: true, noEmbed: true, out: () => {} });
      expect(store.stats(projectId).total).toBe(firstCount);
    } finally {
      store.close();
    }
  });

  it('distinguishes a post-install commit from backfilled history', async () => {
    const dir = tempDir('nexusmem-observed-');
    initRepo(dir);
    writeFileSync(join(dir, 'history.txt'), 'old\n');
    commit(dir, 'feat: historical foundation', '2020-01-01T00:00:00Z');
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    writeFileSync(join(dir, 'history.txt'), 'old\nnew\n');
    commit(dir, 'fix: observed repair', '2030-01-01T00:00:00Z');
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: () => {} });

    const store = MemoryStore.open(join(dir, '.nexusmem', 'memory.db'));
    try {
      const rows = store.raw
        .prepare("SELECT title, capture_mode AS captureMode FROM nodes WHERE kind = 'git_commit' ORDER BY title")
        .all() as Array<{ title: string; captureMode: string }>;
      expect(Object.fromEntries(rows.map((row) => [row.title, row.captureMode]))).toEqual({
        'feat: historical foundation': 'backfilled',
        'fix: observed repair': 'observed',
      });
    } finally {
      store.close();
    }
  });

  it('preserves null metadata for partial historical shell entries and creates no failure links', () => {
    const dir = tempDir('nexusmem-shell-bootstrap-');
    const store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertProject({ id: 'project', root: dir, originUrl: null });
    const entries = parsePsReadLineHistory('npm test\nnpm test\n', Date.now());
    const nodes = collectShellHistory(entries, 'project', { recordedAt: '2026-09-07T00:00:00Z' });
    store.upsertNodes(nodes);
    try {
      const rows = store.raw
        .prepare("SELECT source_ts AS sourceTs, capture_mode AS captureMode, meta FROM nodes ORDER BY id")
        .all() as Array<{ sourceTs: string | null; captureMode: string; meta: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.sourceTs === null && row.captureMode === 'backfilled')).toBe(true);
      for (const row of rows) {
        const meta = JSON.parse(row.meta) as Record<string, unknown>;
        expect(meta).toMatchObject({ cwd: null, exitCode: null, durationMs: null, sourceTimestamp: null });
      }
      expect(correlateFailures(store, 'project').failuresExamined).toBe(0);
      expect((store.raw.prepare('SELECT COUNT(*) AS n FROM node_links').get() as { n: number }).n).toBe(0);
    } finally {
      store.close();
    }
  });

  it('handles an empty repository without inventing history', async () => {
    const dir = tempDir('nexusmem-empty-bootstrap-');
    initRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: () => {} });
    const store = MemoryStore.open(join(dir, '.nexusmem', 'memory.db'));
    try {
      expect((store.raw.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(0);
    } finally {
      store.close();
    }
  });
});
