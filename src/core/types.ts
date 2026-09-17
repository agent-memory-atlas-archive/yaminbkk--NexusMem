/**
 * The canonical shape of everything NexusMem remembers.
 *
 * Every collector (git, shell, diffs, notes) normalises into a MemoryNode so
 * that storage, ranking and context-packing never need to know where a fact
 * came from.
 */

export type NodeKind =
  | 'git_commit'
  | 'shell_command'
  | 'code_diff'
  | 'note'
  | 'conversation_turn'
  | 'doc_section'
  | 'session_summary'
  | 'github_thread';

/**
 * Trust tier, highest first: `observed` (the event itself), `authored` (a
 * human's own written claim), `recorded` (verbatim discourse about events),
 * `derived` (a model's distillation). Set per-collector at ingest time.
 */
export type Provenance = 'observed' | 'authored' | 'recorded' | 'derived';

/**
 * Whether a human has checked a claim -- the axis `provenance` deliberately
 * doesn't cover (source vs. verification are different questions). Every
 * node starts `candidate`; only `nexusmem review <id> --verify`/`--reject`
 * moves it, so this is never set by a collector and never touched by a
 * re-sync (see `upsertNodes`).
 */
export type TrustState = 'candidate' | 'verified' | 'rejected';

/** Whether the source artifact predates this project's NexusMem initialization. */
export type CaptureMode = 'backfilled' | 'observed' | 'unknown';

/** Fallback for nodes written without an explicit `provenance` (older callers, test fixtures). */
export function defaultProvenanceForKind(kind: NodeKind): Provenance {
  switch (kind) {
    case 'git_commit':
    case 'code_diff':
    case 'shell_command':
      return 'observed';
    case 'doc_section':
    case 'note':
      return 'authored';
    case 'conversation_turn':
      return 'recorded';
    case 'session_summary':
      return 'derived';
    case 'github_thread':
      return 'recorded';
  }
}

export interface FileTouch {
  /** Repo-relative path, forward slashes, post-rename. */
  path: string;
  /** Set only when the file was renamed/moved in this event. */
  previousPath?: string;
  /** `null` for binary files, where git reports `-`. */
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface MemoryNode {
  /** Content-addressed, stable across re-syncs. See `makeNodeId`. */
  id: string;
  kind: NodeKind;
  /** Stable identity of the repo this node belongs to. See `makeProjectId`. */
  projectId: string;
  /** ISO-8601 ordering timestamp; source time when known, otherwise record time (see `sourceTs`). */
  ts: string;
  /** Timestamp present in the source artifact; null means the source did not record one. */
  sourceTs?: string | null;
  /** Provenance, e.g. `git`, `shell:pwsh`, `shell:zsh`. */
  source: string;
  /** One-line summary. Shown to the agent, and boosted in the search index. */
  title: string;
  /** Full searchable/embeddable text. */
  body: string;
  files: FileTouch[];
  /**
   * Structural importance in 0..1, computed once at ingest time.
   *
   * Retrieval ranks by `relevance * signal`, not relevance alone -- this is
   * what keeps a chatty `chore: bump deps` from eating the context budget that
   * a `fix:` commit deserves.
   */
  signal: number;
  /** Kind-specific extras. Persisted as a JSON blob. */
  meta: Record<string, unknown>;
  /** Optional here so it can default via `defaultProvenanceForKind`; collectors set it explicitly. */
  provenance?: Provenance;
  /** Historical bootstrap vs. an event observed after installation. Normally assigned by the store. */
  captureMode?: CaptureMode;
  /** Id of an older node this one replaces. Down-weighted by the ranker, never deleted. Written by `nexusmem mark-stale`. */
  supersedes?: string | null;
}
