import { redact } from '../conversation/redact.js';
import { sha256Hex } from '../core/ids.js';

/**
 * One attempt a coding agent made: a command it ran, or a file it edited.
 *
 * Vendor-neutral on purpose. Nothing here names Claude Code, a hook event or
 * a tool_use id -- an adapter maps its own payload onto this shape, so a
 * second agent needs no change in the core. The raw command and error text
 * exist only in `RawAgentEvent`, in memory; `redactAgentEvent` is the only
 * way to get an `AgentEvent`, and what it returns is safe to persist.
 */

export type AgentEventKind = 'command' | 'edit';

/** `interrupted` is a user abort, not a failure: it says nothing about the attempt. */
export type AgentOutcome = 'ok' | 'fail' | 'interrupted' | 'unknown';

export interface RawAgentEvent {
  agent: string;
  sessionId: string;
  /** The agent's own id for this action; makes the event idempotent across delivery paths. */
  eventId: string;
  ts: string;
  cwd: string | null;
  kind: AgentEventKind;
  /** Raw, for a command event. Redacted before it leaves this module. */
  command?: string;
  /** Repo-relative or absolute path, for an edit event. Never file content. */
  filePath?: string;
  outcome: AgentOutcome;
  exitCode: number | null;
  /** Raw first lines of the failure output. Redacted and truncated before persisting. */
  errorSignature?: string;
  durationMs: number | null;
  /** Set when a subagent produced the event. */
  agentId?: string;
}

export interface AgentEvent extends Omit<RawAgentEvent, 'command' | 'errorSignature'> {
  command?: string;
  /** sha256 prefix of the RAW command: correlation matches on this, never on redacted text. */
  commandHash?: string;
  errorSignature?: string;
}

/** Long enough to identify a failure, short enough that a stack trace never lands in the DB. */
export const MAX_ERROR_SIGNATURE_CHARS = 200;

export function agentEventNaturalKey(event: Pick<AgentEvent, 'agent' | 'sessionId' | 'eventId'>): string {
  return `agent:${event.agent}:${event.sessionId}:${event.eventId}`;
}

/** The one gate between raw agent output and anything durable. */
export function redactAgentEvent(raw: RawAgentEvent): AgentEvent {
  const { command, errorSignature, ...rest } = raw;
  return {
    ...rest,
    ...(command === undefined
      ? {}
      : { command: redact(command).text, commandHash: sha256Hex(command).slice(0, 12) }),
    ...(errorSignature === undefined ? {} : { errorSignature: redact(errorSignature).text.slice(0, MAX_ERROR_SIGNATURE_CHARS) }),
  };
}
