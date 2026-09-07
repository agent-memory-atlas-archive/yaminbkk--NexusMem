/**
 * One tracked markdown file in the repository -- README, architecture docs,
 * anything git already knows about (see read.ts for why tracked-only).
 */
export interface RawDocFile {
  /** Repo-relative path, forward slashes. */
  path: string;
  content: string;
  /** ISO-8601 file mtime, used only for deterministic internal ordering. */
  ts: string;
}
