import { RESOLVED_BY_RETRY } from '../correlate/failure-fix.js';
import type { MemoryStore } from '../store/store.js';

/**
 * Looks up what already happened the last time this exact command failed in
 * this repository, and renders it for an agent to read.
 *
 * Deliberately narrow. It matches on `commandHash` -- the hash of the raw
 * command, so two redacted commands that render the same text can never be
 * confused -- and returns nothing at all when there is no match. Silence is
 * the default, and no model, embedding or network call is on this path.
 */

/** ~300 tokens. An injection that grows past this stops being cheap enough to be automatic. */
export const MAX_RECALL_CHARS = 1200;
const MAX_PAST_FAILURES = 3;

interface NodeRow {
  id: string;
  ts: string;
  meta: string;
  paths: string | null;
}

export interface FailureRecall {
  text: string;
  /** How many past failures backed this, for the eval and for `--json`. */
  matched: number;
  resolved: boolean;
}

const SELECT_BY_HASH = `
  SELECT n.id, n.ts, n.meta,
         (SELECT group_concat(f.path) FROM node_files f WHERE f.node_id = n.id) AS paths
  FROM nodes n
  WHERE n.project_id = ?
    AND n.kind = 'shell_command'
    AND json_extract(n.meta, '$.commandHash') = ?
    AND json_extract(n.meta, '$.exitCode') IS NOT NULL
    AND json_extract(n.meta, '$.exitCode') != 0
  ORDER BY n.ts DESC
  LIMIT ?`;

const SELECT_BY_ID = `
  SELECT n.id, n.ts, n.meta,
         (SELECT group_concat(f.path) FROM node_files f WHERE f.node_id = n.id) AS paths
  FROM nodes n WHERE n.id = ?`;

const day = (ts: string): string => ts.slice(0, 10);
const files = (row: NodeRow): string => (row.paths ? row.paths.split(',').join(', ') : '');

function describeAttempt(row: NodeRow): string {
  const changed = files(row);
  return changed ? `${day(row.ts)}: failed after editing ${changed}` : `${day(row.ts)}: failed`;
}

/**
 * `commandHash` comes from the failing command the agent just ran. The node
 * for that run is not in the database yet -- it is ingested by the next sync --
 * so what comes back is genuinely the past, not the present failure.
 */
export function recallFailure(store: MemoryStore, projectId: string, commandHash: string): FailureRecall | null {
  const db = store.raw;
  const past = db.prepare(SELECT_BY_HASH).all(projectId, commandHash, MAX_PAST_FAILURES) as NodeRow[];
  if (past.length === 0) return null;

  const lines: string[] = [];
  let resolved = false;

  // Newest first is what the agent needs: the most recent attempt is the one it is about to repeat.
  for (const row of past) {
    lines.push(`- ${describeAttempt(row)}`);
  }

  for (const row of past) {
    const [fixId] = store.getLinkedNodeIds(row.id, RESOLVED_BY_RETRY);
    if (!fixId) continue;
    const fix = db.prepare(SELECT_BY_ID).get(fixId) as NodeRow | undefined;
    if (!fix) continue;
    const changed = files(fix);
    lines.push(changed ? `- fixed on ${day(fix.ts)} after editing ${changed}` : `- fixed on ${day(fix.ts)}`);
    resolved = true;
    break;
  }

  if (!resolved) lines.push('- no fix for it was ever recorded here');

  const header = `NexusMem: this exact command has failed in this repository before (${past.length} time(s)).`;
  const footer = resolved
    ? 'Check what changed in that fix before retrying the same approach.'
    : 'Previous attempts did not resolve it, so a different approach is likely needed.';

  return { text: [header, ...lines, footer].join('\n').slice(0, MAX_RECALL_CHARS), matched: past.length, resolved };
}
