import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent, AgentEventKind, AgentOutcome } from './event.js';

/**
 * The only writer and the only reader of the agent event log.
 *
 * Same contract as the shell recorder: an adapter hands over an already
 * redacted event, and a single append persists it. No temp file, so a crash
 * can leave nothing half-written behind.
 */

const KINDS: ReadonlySet<string> = new Set<AgentEventKind>(['command', 'edit']);
const OUTCOMES: ReadonlySet<string> = new Set<AgentOutcome>(['ok', 'fail', 'interrupted', 'unknown']);

export async function appendAgentEvent(event: AgentEvent, logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** A torn or unrecognised line is skipped, never fatal: one bad line must not stop a sync. */
export function parseAgentEventLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (typeof e.agent !== 'string' || typeof e.sessionId !== 'string' || typeof e.eventId !== 'string') return null;
  if (typeof e.ts !== 'string' || typeof e.kind !== 'string' || !KINDS.has(e.kind)) return null;
  if (typeof e.outcome !== 'string' || !OUTCOMES.has(e.outcome)) return null;
  return parsed as AgentEvent;
}

export interface ReadAgentEventsResult {
  events: AgentEvent[];
  /** Total lines in the file: the caller's next cursor, as with the shell hook log. */
  totalLines: number;
}

/** Reads lines appended since `fromLine`; a cursor past the end means the file was rotated, so re-read it all. */
export async function readAgentEvents(logPath: string, fromLine: number): Promise<ReadAgentEventsResult> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return { events: [], totalLines: fromLine };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const start = fromLine > 0 && fromLine <= lines.length ? fromLine : 0;
  const events = lines.slice(start).map(parseAgentEventLine).filter((e): e is AgentEvent => e !== null);
  return { events, totalLines: lines.length };
}
