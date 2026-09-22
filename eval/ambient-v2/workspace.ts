import { execFileSync } from 'node:child_process';
import { forwardSlashed } from '../ambient/paths.js';

/**
 * What a run changed in the working tree, for the trial record.
 *
 * `git diff --name-only HEAD` -- what 71b31f3 used -- sees only tracked
 * files, so a run that solved `shadowed-config` by adding a new config file
 * that sorts after the others left no trace in the record. `git status` with
 * every untracked file listed sees tracked changes, deletions and new files.
 *
 * NexusMem's own state, the installed hook settings and git's internals are
 * never a model's solution edit, and are excluded by prefix even though the
 * fixture's own ignore rules normally hide them already.
 */

const HARNESS_OWNED = ['.git/', '.nexusmem/', '.claude/'];

const owned = (path: string): boolean => path === '.git' || HARNESS_OWNED.some((prefix) => path.startsWith(prefix));

/**
 * Parses `git status --porcelain=v1 -z -uall`. Each entry is `XY path`; a
 * rename or copy is followed by one more NUL-terminated field, the path it
 * came from, which is consumed rather than read as an entry of its own. Both
 * sides of a rename are reported: the old path was changed away too.
 */
export function parseChangedFiles(porcelainZ: string, platform: NodeJS.Platform = process.platform): string[] {
  const fields = porcelainZ.split('\0');
  const out = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    out.add(forwardSlashed(entry.slice(3), platform));
    if (status.includes('R') || status.includes('C')) {
      const from = fields[i + 1];
      if (from) out.add(forwardSlashed(from, platform));
      i += 1;
    }
  }
  return [...out].filter((p) => !owned(p)).sort();
}

export function changedFiles(repoDir: string): string[] {
  return parseChangedFiles(
    execFileSync('git', ['-C', repoDir, 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8' }),
  );
}
