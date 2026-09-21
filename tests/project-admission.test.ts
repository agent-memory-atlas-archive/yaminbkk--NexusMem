import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { recallFailure, recallSessionStart } from '../src/agent/recall.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { collectAvailableShellHistory, isUnderRoot } from '../src/shell/detect.js';
import { appendHookLogEntry } from '../src/shell/hook-log.js';
import { hookLogPath } from '../src/shell/paths.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * The project-admission boundary: which shell and agent events a sync of one
 * repository takes in as its own history.
 *
 * Every vector names its platform explicitly, so a Linux runner proves the
 * Windows rules and a Windows runner proves the POSIX ones. Paths are plain
 * strings: nothing here needs two case-distinct directories to exist, which a
 * case-insensitive filesystem could not create anyway.
 *
 * Before this fix the boundary folded case and turned every backslash into a
 * separator on every platform, so on Linux an event from `/home/dev/Repo` was
 * admitted into `/home/dev/repo`'s history -- a different directory, and
 * usually a different project.
 */

const under = (candidate: string, root: string, platform: NodeJS.Platform) => isUnderRoot(candidate, root, platform);

describe('isUnderRoot: POSIX', () => {
  const root = '/home/dev/repo';

  it('admits the root and anything below it', () => {
    expect(under('/home/dev/repo', root, 'linux')).toBe(true);
    expect(under('/home/dev/repo/src/a.ts', root, 'linux')).toBe(true);
    expect(under('/home/dev/repo/', root, 'linux')).toBe(true);
    expect(under('/home/dev/repo/src/a.ts', '/home/dev/repo/', 'linux')).toBe(true);
    expect(under('/home/dev/repo//src///a.ts', root, 'linux')).toBe(true);
  });

  it('does not admit a directory whose name differs only by case', () => {
    expect(under('/home/dev/Repo/src/a.ts', root, 'linux')).toBe(false);
    expect(under('/home/dev/Repo', root, 'linux')).toBe(false);
    expect(under('/home/dev/repo/src/a.ts', '/home/dev/Repo', 'linux')).toBe(false);
    // macOS volumes are usually case-insensitive, but that cannot be known
    // without asking the filesystem: an unknowable identity is not admitted.
    expect(under('/Users/dev/Repo/src/a.ts', '/Users/dev/repo', 'darwin')).toBe(false);
  });

  it('respects path components', () => {
    expect(under('/home/dev/repo2/src/a.ts', root, 'linux')).toBe(false);
    expect(under('/home/dev/repository', root, 'linux')).toBe(false);
    expect(under('/tmp/app2', '/tmp/app', 'linux')).toBe(false);
    expect(under('/tmp/application', '/tmp/app', 'linux')).toBe(false);
  });

  it('resolves dot-dot lexically, so traversal cannot escape the root', () => {
    expect(under('/home/dev/repo/src/../../other/x.ts', root, 'linux')).toBe(false);
    expect(under('/home/dev/repo/sub/../../repo2/x.ts', root, 'linux')).toBe(false);
    expect(under('/home/dev/repo/src/../lib/x.ts', root, 'linux')).toBe(true);
    expect(under('/home/dev/repo/./src/a.ts', root, 'linux')).toBe(true);
  });

  it('treats a backslash as an ordinary filename character, never a separator', () => {
    // `repo\x` is a file in /home/dev, beside the repository, not inside it.
    expect(under('/home/dev/repo\\x.ts', root, 'linux')).toBe(false);
    expect(under('/home/dev/repo\\..\\..\\etc', root, 'linux')).toBe(false);
  });

  it('does not treat a Windows-looking mount as case-insensitive', () => {
    expect(under('/mnt/c/Users/Dev/Repo/x', '/mnt/c/users/dev/repo', 'linux')).toBe(false);
    expect(under('/mnt/c/Users/Dev/Repo/x', '/mnt/c/Users/Dev/Repo', 'linux')).toBe(true);
  });

  it('never admits a relative path into an absolute root', () => {
    expect(under('src/a.ts', root, 'linux')).toBe(false);
    expect(under('', root, 'linux')).toBe(false);
  });

  it('keeps legitimate unusual names', () => {
    expect(under('/home/dev/my repo/a.ts', '/home/dev/my repo', 'linux')).toBe(true);
    expect(under('/home/dev/répo/a.ts', '/home/dev/répo', 'linux')).toBe(true);
    expect(under('/anything/at/all', '/', 'linux')).toBe(true);
  });
});

describe('isUnderRoot: Windows', () => {
  const root = 'C:\\Users\\Dev\\Repo';

  it('folds case, because the volume does', () => {
    expect(under('c:\\users\\dev\\repo\\src\\a.ts', root, 'win32')).toBe(true);
    expect(under('C:\\USERS\\DEV\\REPO', root, 'win32')).toBe(true);
  });

  it('accepts either separator for the same native path', () => {
    expect(under('C:/Users/Dev/Repo/src/a.ts', root, 'win32')).toBe(true);
    expect(under('C:\\Users\\Dev\\Repo\\src\\a.ts', 'C:/Users/Dev/Repo/', 'win32')).toBe(true);
    expect(under('C:\\Users\\Dev\\Repo\\', root, 'win32')).toBe(true);
  });

  it('respects path components', () => {
    expect(under('C:\\Users\\Dev\\Repo2\\src\\a.ts', root, 'win32')).toBe(false);
    expect(under('C:\\Users\\Dev\\Repository', root, 'win32')).toBe(false);
    expect(under('D:\\Users\\Dev\\Repo\\a.ts', root, 'win32')).toBe(false);
  });

  it('resolves dot-dot lexically', () => {
    expect(under('C:\\Users\\Dev\\Repo\\src\\..\\..\\Other\\x', root, 'win32')).toBe(false);
    expect(under('C:\\repo\\src\\..\\file', 'C:\\repo', 'win32')).toBe(true);
  });

  it('handles a drive root and a UNC share', () => {
    expect(under('c:\\x\\y', 'C:\\', 'win32')).toBe(true);
    expect(under('D:\\x', 'C:\\', 'win32')).toBe(false);
    expect(under('\\\\server\\share\\Repo\\x', '\\\\Server\\Share\\repo', 'win32')).toBe(true);
    expect(under('\\\\server\\share\\Repo2\\x', '\\\\server\\share\\Repo', 'win32')).toBe(false);
    expect(under('\\\\other\\share\\Repo\\x', '\\\\server\\share\\Repo', 'win32')).toBe(false);
  });

  it('does not admit Git Bash or WSL spellings, which it never did', () => {
    expect(under('/c/Users/Dev/Repo/a.ts', root, 'win32')).toBe(false);
    expect(under('/mnt/c/Users/Dev/Repo/a.ts', root, 'win32')).toBe(false);
  });

  it('keeps legitimate unusual names', () => {
    expect(under('C:\\Users\\Dev\\My Repo\\a.ts', 'C:\\Users\\Dev\\My Repo', 'win32')).toBe(true);
    expect(under('C:\\Users\\Dev\\Répo\\a.ts', 'C:\\Users\\Dev\\Répo', 'win32')).toBe(true);
  });
});

// --- the collectors that use it ------------------------------------------

let seq = 0;
const agentEvent = (over: Partial<AgentEvent>): AgentEvent =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `e-${(seq += 1)}`,
    ts: '2026-09-20T09:00:00.000Z',
    kind: 'command',
    command: 'npm test',
    outcome: 'fail',
    exitCode: 1,
    durationMs: 10,
    ...over,
  } as AgentEvent);

describe('agent-event collector admission', () => {
  const root = '/synthetic/repo';
  const collect = (events: AgentEvent[], platform: NodeJS.Platform, repoRoot = root) =>
    collectAgentEvents(events, 'proj-b', { repoRoot, platform });

  it('takes a command whose cwd is this project, on POSIX', () => {
    expect(collect([agentEvent({ cwd: root })], 'linux')).toHaveLength(1);
  });

  it('rejects a command from a case-distinct sibling, a prefix collision, or elsewhere', () => {
    expect(collect([agentEvent({ cwd: '/synthetic/Repo' })], 'linux')).toEqual([]);
    expect(collect([agentEvent({ cwd: '/synthetic/repo2' })], 'linux')).toEqual([]);
    expect(collect([agentEvent({ cwd: '/elsewhere' })], 'linux')).toEqual([]);
  });

  it('attaches only edits inside this project to the command that follows', () => {
    const [node] = collect(
      [
        agentEvent({ kind: 'edit', cwd: root, filePath: '/synthetic/Repo/src/leak.ts', outcome: 'ok', exitCode: null }),
        agentEvent({ kind: 'edit', cwd: root, filePath: '/synthetic/repo2/src/leak.ts', outcome: 'ok', exitCode: null }),
        agentEvent({ kind: 'edit', cwd: root, filePath: '/synthetic/repo/src/own.ts', outcome: 'ok', exitCode: null }),
        agentEvent({ cwd: root }),
      ],
      'linux',
    );
    expect(node!.files.map((f) => f.path)).toEqual(['src/own.ts']);
  });

  it('takes a case variant of this project on Windows', () => {
    const winRoot = 'C:\\Work\\Repo';
    const [node] = collect(
      [
        agentEvent({ kind: 'edit', cwd: winRoot, filePath: 'c:/work/repo/src/a.ts', outcome: 'ok', exitCode: null }),
        agentEvent({ cwd: 'c:\\work\\repo' }),
      ],
      'win32',
      winRoot,
    );
    expect(node).toBeDefined();
    expect(node!.files).toHaveLength(1);
    expect(collect([agentEvent({ cwd: 'C:\\Work\\Repo2' })], 'win32', winRoot)).toEqual([]);
  });
});

describe('shell hook-log admission', () => {
  const root = '/synthetic/repo';
  const entry = (cwd: string, command: string) => ({ ts: '2026-09-20T09:00:00.000Z', cwd, exitCode: 1, durationMs: 5, command, shell: 'bash-hook' as const });

  beforeEach(async () => {
    rmSync(hookLogPath(), { force: true });
    await appendHookLogEntry(hookLogPath(), entry('/synthetic/repo', 'make own'));
    await appendHookLogEntry(hookLogPath(), entry('/synthetic/repo/sub', 'make own-sub'));
    await appendHookLogEntry(hookLogPath(), entry('/synthetic/Repo', 'make leak-case'));
    await appendHookLogEntry(hookLogPath(), entry('/synthetic/repo2', 'make leak-prefix'));
    await appendHookLogEntry(hookLogPath(), entry('/elsewhere', 'make leak-outside'));
  });

  afterEach(() => rmSync(hookLogPath(), { force: true }));

  const hookCommands = async (platform: NodeJS.Platform) => {
    const results = await collectAvailableShellHistory({ repoRoot: root, platform, tailLines: 0 });
    return results.find((r) => r.name === 'pwsh-hook')!.entries.map((e) => e.command).sort();
  };

  it('takes only this project on POSIX', async () => {
    expect(await hookCommands('linux')).toEqual(['make own', 'make own-sub']);
  });
});

// --- end to end: a rejected event never becomes the other project's memory -

describe('cross-project leakage', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-admission-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps project A out of project B when their paths differ only by case (POSIX)', () => {
    const projectA = '/synthetic/Repo';
    const projectB = '/synthetic/repo';
    const leaked = agentEvent({ cwd: projectA, command: 'npm run release-a', ts: '2026-09-20T09:00:00.000Z' });
    const own = agentEvent({ cwd: projectB, command: 'npm test', ts: '2026-09-20T09:05:00.000Z' });

    store.upsertNodes(
      collectAgentEvents(
        [agentEvent({ kind: 'edit', cwd: projectA, filePath: `${projectA}/secret-plan.ts`, outcome: 'ok', exitCode: null }), leaked, own],
        'proj-b',
        { repoRoot: projectB, platform: 'linux' },
      ),
    );

    const rows = store.raw.prepare("SELECT title, body FROM nodes WHERE project_id = 'proj-b'").all() as Array<{ title: string; body: string }>;
    expect(rows.some((r) => r.title.includes('npm test'))).toBe(true);
    expect(rows.some((r) => `${r.title}\n${r.body}`.includes('release-a'))).toBe(false);
    expect(rows.some((r) => `${r.title}\n${r.body}`.includes('secret-plan'))).toBe(false);

    expect(recallFailure(store, 'proj-b', leaked.execHash!)).toBeNull();
    const digest = recallSessionStart(store, 'proj-b', new Date('2026-09-21T00:00:00.000Z'));
    expect(digest?.text ?? '').not.toContain('release-a');
  });
});
