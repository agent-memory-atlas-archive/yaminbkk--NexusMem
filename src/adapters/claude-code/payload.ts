import { type AgentEvent, type AgentOutcome, type RawAgentEvent, redactAgentEvent } from '../../agent/event.js';

/**
 * Maps one Claude Code hook payload onto an `AgentEvent`.
 *
 * Every field below was read off a live probe against Claude Code 2.1.226
 * (see tests/agent-payload.test.ts for the captured payloads), not from the
 * docs -- doc summaries claimed a `tool_response.exit_code` that does not
 * exist. What the probe established:
 *
 * - a Bash call that exits non-zero fires `PostToolUseFailure` ONLY, and its
 *   `error` is the text "Exit code N\n<stderr>"; there is no exit-code field
 * - a Bash call that succeeds fires `PostToolUse`, carrying `tool_response`
 * - both carry `tool_use_id`, `cwd`, `session_id` and `duration_ms`
 *
 * Anything that does not match is dropped, never guessed at.
 */

export const AGENT = 'claude-code';

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXIT_CODE = /^Exit code (\d+)/;

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  error?: unknown;
  is_interrupt?: unknown;
  duration_ms?: unknown;
  agent_id?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Splits "Exit code 2\nls: cannot access ..." into its code and the rest. */
function parseError(error: string): { exitCode: number | null; signature: string } {
  const [first = '', ...rest] = error.split(/\r?\n/);
  const match = EXIT_CODE.exec(first);
  if (!match) return { exitCode: null, signature: error.trim() };
  return { exitCode: Number(match[1]), signature: rest.join(' ').trim() };
}

/**
 * `now` is passed in because no hook payload carries a timestamp -- the event
 * is stamped when it is received, which is within milliseconds of the action.
 */
export interface SessionStartPayload {
  sessionId: string;
  cwd: string;
  /** startup | resume | clear | compact, per the live probe. */
  source: string | null;
}

/** SessionStart carries no tool fields, so it gets its own tiny parser rather than bending the event one. */
export function parseSessionStart(rawJson: string): SessionStartPayload | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson.trim());
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as HookPayload & { source?: unknown };
  if (str(p.hook_event_name) !== 'SessionStart') return null;

  const sessionId = str(p.session_id);
  const cwd = str(p.cwd);
  if (!sessionId || !cwd) return null;
  return { sessionId, cwd, source: str(p.source) ?? null };
}

export function parseHookPayload(rawJson: string, now: string): AgentEvent | null {
  let payload: unknown;
  try {
    // A JSON.parse error message quotes its input, i.e. the raw command; never let it escape.
    payload = JSON.parse(rawJson.trim());
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as HookPayload;

  const event = str(p.hook_event_name);
  const sessionId = str(p.session_id);
  const eventId = str(p.tool_use_id);
  const toolName = str(p.tool_name);
  if (!sessionId || !eventId || !toolName) return null;
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return null;

  const failed = event === 'PostToolUseFailure';
  const interrupted = failed && p.is_interrupt === true;
  const outcome: AgentOutcome = interrupted ? 'interrupted' : failed ? 'fail' : 'ok';

  const base = {
    agent: AGENT,
    sessionId,
    eventId,
    ts: now,
    cwd: str(p.cwd) ?? null,
    outcome,
    durationMs: num(p.duration_ms),
    ...(str(p.agent_id) ? { agentId: str(p.agent_id) as string } : {}),
  };

  if (toolName === 'Bash') {
    const command = str(p.tool_input?.command);
    if (!command) return null;
    const error = failed ? parseError(str(p.error) ?? '') : null;
    const draft: RawAgentEvent = {
      ...base,
      kind: 'command',
      command,
      // A success carries no exit code because success is what it means; a failure hides it in text.
      exitCode: failed ? error?.exitCode ?? null : 0,
      ...(error?.signature ? { errorSignature: error.signature } : {}),
    };
    return redactAgentEvent(draft);
  }

  if (EDIT_TOOLS.has(toolName)) {
    // Only the path: an edit's payload also holds the file's old and new content, which is never recorded.
    const filePath = str(p.tool_input?.file_path) ?? str(p.tool_input?.notebook_path);
    if (!filePath) return null;
    return redactAgentEvent({ ...base, kind: 'edit', filePath, exitCode: null });
  }

  return null;
}
