import { RESOLVED_BY_RETRY } from '../correlate/failure-fix.js';
import type { MemoryStore } from '../store/store.js';

/**
 * Looks up what already happened the last time this exact command failed in
 * this repository, and renders it for an agent to read.
 *
 * Deliberately narrow. It matches on `execHash` -- the hash of the raw
 * command with only a same-cwd `cd` prefix stripped (see
 * `canonicalizeCommand` in `agent/event.ts`), so two redacted commands that
 * render the same text can never be confused, and a live `cd "<cwd>" && npm
 * test` still finds a historical bare `npm test` -- and returns nothing at
 * all when there is no match. Silence is the default, and no model,
 * embedding or network call is on this path.
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
    AND json_extract(n.meta, '$.execHash') = ?
    AND json_extract(n.meta, '$.exitCode') IS NOT NULL
    AND json_extract(n.meta, '$.exitCode') != 0
  ORDER BY n.ts DESC
  LIMIT ?`;

/** Recent failures, newest first; the caller drops the ones something already resolved. */
const SELECT_RECENT_FAILURES = `
  SELECT n.id, n.ts, n.meta, NULL AS paths
  FROM nodes n
  WHERE n.project_id = ?
    AND n.kind = 'shell_command'
    AND json_extract(n.meta, '$.exitCode') IS NOT NULL
    AND json_extract(n.meta, '$.exitCode') != 0
    AND n.ts >= ?
  ORDER BY n.ts DESC
  LIMIT 40`;

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
 * `execHash` comes from the failing command the agent just ran. The node
 * for that run is not in the database yet -- it is ingested by the next sync --
 * so what comes back is genuinely the past, not the present failure.
 */
export function recallFailure(store: MemoryStore, projectId: string, execHash: string): FailureRecall | null {
  const db = store.raw;
  const past = db.prepare(SELECT_BY_HASH).all(projectId, execHash, MAX_PAST_FAILURES) as NodeRow[];
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

/** ~150 tokens. A session opener has to be cheap enough that nobody would turn it off. */
export const MAX_DIGEST_CHARS = 600;
const DIGEST_WINDOW_DAYS = 14;
const MAX_DIGEST_COMMANDS = 3;

export interface SessionDigest {
  text: string;
  /** Counts by state, for the eval and for `--json`. */
  resolved: number;
  stale: number;
  unresolved: number;
}

type CommandState = 'resolved' | 'stale' | 'unresolved';

interface CommandSummary {
  command: string;
  /** This command's most recent failure in the window. */
  newestTs: string;
  state: CommandState;
  /** When state is 'resolved' or 'stale': when the (possibly no-longer-holding) fix landed. */
  fixTs?: string;
}

/** Resolved chains are shown first regardless of recency -- see the doc comment below. */
const STATE_PRIORITY: Record<CommandState, number> = { resolved: 0, stale: 1, unresolved: 2 };

/**
 * What is worth knowing when a session opens.
 *
 * This used to mean only "commands that failed here recently and that
 * nothing has fixed" -- which excluded the single most useful thing NexusMem
 * can say, "this failed before, and here is what fixed it", for the sole
 * reason that it *was* fixed. A resolved failure->fix chain is the most
 * actionable memory there is, so it is now listed ahead of an unrelated
 * failure with no known answer, even when the latter is more recent.
 *
 * Per command, only the MOST RECENT occurrence in the window decides the
 * state: if it has a recorded fix, the chain is 'resolved'; if it does not
 * but an OLDER occurrence of the exact same command did, that fix has since
 * stopped holding -- said as 'stale', not silently dropped and not repeated
 * as if it still applied; otherwise it is plain 'unresolved'.
 *
 * Returns null only when there is truly nothing in the window -- a
 * repository whose only history is fully resolved chains now gets a digest,
 * not silence, which is the deliberate behaviour change here.
 */
export function recallSessionStart(store: MemoryStore, projectId: string, now = new Date()): SessionDigest | null {
  const since = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = store.raw.prepare(SELECT_RECENT_FAILURES).all(projectId, since) as NodeRow[];

  // Rows arrive newest-first (the query orders by ts DESC); grouping
  // preserves that, so each group's first entry is that command's most
  // recent failure in the window.
  const byCommand = new Map<string, NodeRow[]>();
  for (const row of rows) {
    const command = (JSON.parse(row.meta) as { command?: string }).command?.split(/\r?\n/)[0]?.trim();
    if (!command) continue;
    const group = byCommand.get(command);
    if (group) group.push(row);
    else byCommand.set(command, [row]);
  }
  if (byCommand.size === 0) return null;

  const summaries: CommandSummary[] = [];
  for (const [command, [newest, ...older]] of byCommand) {
    const [newestFixId] = store.getLinkedNodeIds(newest!.id, RESOLVED_BY_RETRY);
    if (newestFixId) {
      const fix = store.raw.prepare(SELECT_BY_ID).get(newestFixId) as NodeRow | undefined;
      summaries.push({ command, newestTs: newest!.ts, state: 'resolved', fixTs: fix?.ts });
      continue;
    }
    const staleFixId = older.map((row) => store.getLinkedNodeIds(row.id, RESOLVED_BY_RETRY)[0]).find((id): id is string => id !== undefined);
    if (staleFixId) {
      const fix = store.raw.prepare(SELECT_BY_ID).get(staleFixId) as NodeRow | undefined;
      summaries.push({ command, newestTs: newest!.ts, state: 'stale', fixTs: fix?.ts });
    } else {
      summaries.push({ command, newestTs: newest!.ts, state: 'unresolved' });
    }
  }

  summaries.sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || (b.newestTs < a.newestTs ? -1 : 1));

  const listed = summaries.slice(0, MAX_DIGEST_COMMANDS);
  const lines = listed.map((s) => {
    if (s.state === 'resolved') return `- ${s.command} (failed here before, fixed ${day(s.fixTs!)})`;
    if (s.state === 'stale') {
      return `- ${s.command} (fixed ${day(s.fixTs!)}, but failed again ${day(s.newestTs)} -- that fix no longer holds)`;
    }
    return `- ${s.command} failed ${day(s.newestTs)} with no recorded fix`;
  });
  const more = summaries.length > listed.length ? ` and ${summaries.length - listed.length} other(s)` : '';

  const counts = { resolved: 0, stale: 0, unresolved: 0 };
  for (const s of summaries) counts[s.state] += 1;

  return {
    text: [
      `NexusMem: ${summaries.length} relevant command(s) from the last ${DIGEST_WINDOW_DAYS} days${more}:`,
      ...lines,
      'This history is searchable with the nexusmem MCP tools if one of them comes up.',
    ]
      .join('\n')
      .slice(0, MAX_DIGEST_CHARS),
    ...counts,
  };
}
