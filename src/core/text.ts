export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Drops a leading UTF-8 byte order mark.
 *
 * Windows tools write one routinely -- PowerShell's `Set-Content -Encoding
 * utf8` on 5.1, and plenty of editors -- and `JSON.parse` rejects the file
 * outright when it is there. Any JSON a user can edit by hand has to survive
 * that. The shell recorder already handles the same thing on its stdin.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Rough heuristic for English-dominant text: ~4 chars per token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
