import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalWorkspaceDir } from '../config/paths.js';
import { agentEventLogPath } from './paths.js';
import { parseAgentEventLine } from './record.js';

/**
 * Whether capture is actually working, answered from evidence already on
 * disk rather than from the fact that hooks are configured.
 *
 * Two sources, both local, neither of which stores anything about the payload:
 *
 * - the agent event log's last line says when capture last succeeded. Reading
 *   it costs nothing on the hook's path, because nothing extra is written.
 * - a drop marker file says when the hook last threw an event away, and why,
 *   as a code from a fixed set. Without it, "no events because the developer
 *   was not coding" and "no events because the payload shape changed" look
 *   identical, which is exactly the silent failure this exists to catch.
 *
 * Deliberately no state a healthy run has to update: the common path writes
 * one line to the log and nothing else.
 */

export type CaptureHealth = 'healthy' | 'stale' | 'failing' | 'never-observed' | 'unknown';

/** Reasons the hook can record. A closed set, so no payload text can ever reach the file. */
export const DROP_REASONS = ['unparsable-json', 'unsupported-event', 'unsupported-tool', 'missing-fields', 'write-failed'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** How recently capture must have worked to count as healthy. A day covers a normal working rhythm. */
export const HEALTHY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CaptureStatus {
  health: CaptureHealth;
  lastEventAt: string | null;
  /** 'command' | 'edit' -- the kind of the last captured event, never its content. */
  lastEventKind: string | null;
  lastEventOutcome: string | null;
  lastDropAt: string | null;
  lastDropReason: DropReason | null;
  drops: number;
}

interface DropState {
  lastDropAt?: unknown;
  lastDropReason?: unknown;
  drops?: unknown;
}

export function captureDropStatePath(): string {
  return join(globalWorkspaceDir(), 'agent-capture-drops.json');
}

const isDropReason = (value: unknown): value is DropReason => DROP_REASONS.includes(value as DropReason);

/**
 * Records that one event was thrown away. Called from the hook's failure
 * path, so it must never throw and never block the agent.
 */
export function recordCaptureDrop(reason: DropReason, path = captureDropStatePath(), now = new Date()): void {
  try {
    // Re-validated rather than trusted: this is the one field a caller could
    // otherwise use to smuggle payload text into a file.
    const safeReason: DropReason = isDropReason(reason) ? reason : 'missing-fields';
    const previous = readDropState(path);
    const drops = typeof previous.drops === 'number' && Number.isFinite(previous.drops) ? previous.drops : 0;
    writeFileSync(path, JSON.stringify({ lastDropAt: now.toISOString(), lastDropReason: safeReason, drops: drops + 1 }), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Health reporting is never worth failing a capture over.
  }
}

function readDropState(path: string): DropState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as DropState) : {};
  } catch {
    return {};
  }
}

/** The last line the log holds that still parses; a torn final line is skipped, not fatal. */
function lastEvent(logPath: string): { at: string; kind: string; outcome: string } | null | 'unreadable' {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch (err) {
    // Absent is a real answer ("never observed"); anything else means we cannot tell.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const event = parseAgentEventLine(lines[i]!);
    if (event) return { at: event.ts, kind: event.kind, outcome: event.outcome };
  }
  return lines.length > 0 ? 'unreadable' : null;
}

export interface CaptureStatusOptions {
  logPath?: string;
  dropStatePath?: string;
  now?: Date;
}

export function readCaptureStatus(opts: CaptureStatusOptions = {}): CaptureStatus {
  const now = opts.now ?? new Date();
  const event = lastEvent(opts.logPath ?? agentEventLogPath());
  const drop = readDropState(opts.dropStatePath ?? captureDropStatePath());

  const lastDropAt = typeof drop.lastDropAt === 'string' ? drop.lastDropAt : null;
  const lastDropReason = isDropReason(drop.lastDropReason) ? drop.lastDropReason : null;
  const drops = typeof drop.drops === 'number' && Number.isFinite(drop.drops) ? drop.drops : 0;
  const base = { lastDropAt, lastDropReason, drops };

  if (event === 'unreadable') {
    return { ...base, health: 'unknown', lastEventAt: null, lastEventKind: null, lastEventOutcome: null };
  }
  if (event === null) {
    // Drops with nothing ever captured is the signature of a payload shape we no longer understand.
    return { ...base, health: drops > 0 ? 'failing' : 'never-observed', lastEventAt: null, lastEventKind: null, lastEventOutcome: null };
  }

  const captured = { lastEventAt: event.at, lastEventKind: event.kind, lastEventOutcome: event.outcome };
  const eventAt = Date.parse(event.at);
  if (Number.isNaN(eventAt)) return { ...base, ...captured, health: 'unknown' };

  // A drop after the last success means capture broke since it last worked.
  if (lastDropAt && Date.parse(lastDropAt) > eventAt) return { ...base, ...captured, health: 'failing' };

  return { ...base, ...captured, health: now.getTime() - eventAt <= HEALTHY_WINDOW_MS ? 'healthy' : 'stale' };
}
