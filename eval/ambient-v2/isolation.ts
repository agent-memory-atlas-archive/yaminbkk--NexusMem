import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { Arm } from './scorer.js';

/**
 * Trial isolation, asserted rather than assumed.
 *
 * Nothing a trial does may reach another one: not a file edit, not git state,
 * not a NexusMem database, not an installed hook. The checks below run inside
 * the orchestration itself, on every trial including dry runs, and a failure
 * is a system failure rather than a result.
 */

export interface TrialPaths {
  workspace: string;
  repoDir: string;
  nmHome: string;
}

/**
 * Path identity for the harness's own paths. Every path compared here is one
 * the harness made itself -- `mkdtemp`, then `realpathSync.native`, then
 * `join` -- so only native paths of the running host ever appear; this is
 * not a comparator for paths an agent or a hook reports.
 *
 * Windows folds case because its filesystems do by default: `C:\Temp\Repo`
 * and `c:\temp\repo` are one directory. POSIX is compared exactly: `/tmp/Repo`
 * and `/tmp/repo` are two. `platform` is a parameter so both rules can be
 * tested from either host.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return win32.resolve(path).toLowerCase();
  return posix.resolve(path);
}

/** Containment on whole path components: `/tmp/app2` is not under `/tmp/app`. */
export function isWithin(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const separator = platform === 'win32' ? win32.sep : posix.sep;
  const p = pathKey(parent, platform);
  const c = pathKey(child, platform);
  return c === p || c.startsWith(p.endsWith(separator) ? p : p + separator);
}

/** Before anything is built: the workspace must be new, and everything must live inside it. */
export function checkFreshWorkspace(paths: TrialPaths, existedBefore: boolean): string[] {
  const problems: string[] = [];
  if (existedBefore) problems.push(`workspace ${paths.workspace} already existed, so it may carry another trial's state`);
  if (!isWithin(paths.workspace, paths.repoDir)) problems.push('the repository is not inside the trial workspace');
  if (!isWithin(paths.workspace, paths.nmHome)) problems.push('NEXUSMEM_HOME is not inside the trial workspace');
  return problems;
}

/** After the fixture is built and before the model runs: a clean tree, and nothing left over. */
export function checkCleanStart(paths: TrialPaths): string[] {
  const problems: string[] = [];
  const status = execFileSync('git', ['-C', paths.repoDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (status) problems.push(`the freshly built repository is already dirty:\n${status}`);
  return problems;
}

/**
 * Arm setup, checked from the filesystem rather than from what the runner
 * intended. A control trial that inherited an installed hook would look like
 * ambient with no memory and read as a null result.
 */
export function checkArmSetup(arm: Arm, paths: TrialPaths): string[] {
  const problems: string[] = [];
  const settings = join(paths.repoDir, '.claude', 'settings.local.json');
  const memory = join(paths.repoDir, '.nexusmem');
  const events = join(paths.nmHome, 'agent-events.jsonl');

  if (arm === 'control') {
    if (existsSync(memory)) problems.push('a control trial has a NexusMem project directory');
    if (existsSync(settings)) problems.push('a control trial has Claude Code hook settings');
    if (existsSync(events)) problems.push('a control trial has a seeded event log');
    return problems;
  }

  if (!existsSync(memory)) problems.push(`a ${arm} trial has no NexusMem project directory`);
  if (!existsSync(events)) problems.push(`a ${arm} trial has no seeded event log`);
  if (arm === 'mcp' && existsSync(settings)) problems.push('an mcp trial has hook settings installed, so it would also inject ambiently');
  if (arm === 'ambient' && !existsSync(settings)) problems.push('an ambient trial has no hook settings, so nothing would be injected');
  return problems;
}

/** Across the whole run: no two trials may share a workspace. */
export function checkDistinctWorkspaces(workspaces: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const workspace of workspaces) {
    const key = pathKey(workspace, platform);
    if (seen.has(key)) problems.push(`workspace reused between trials: ${workspace}`);
    seen.add(key);
  }
  return problems;
}
