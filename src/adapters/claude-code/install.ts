import type { AgentHookCommands } from '../../agent/hook-command.js';

/**
 * Upserts NexusMem's hooks into a Claude Code settings object.
 *
 * Pure JSON in, JSON out -- reading and writing the file is the CLI's job, so
 * this can be tested against real settings shapes without touching anyone's
 * configuration.
 *
 * Two rules the code has to keep: never disturb another tool's hooks, and
 * stay recognisably ours so `remove` can take exactly what `install` added.
 * Ownership is decided by the command string, since Claude Code's schema has
 * no place to put a marker of our own.
 *
 * Deliberately not used: `async: true`. The docs describe it, but the live
 * probe never exercised it, and an unknown key in a user's real settings file
 * is not worth the risk until it is verified.
 */

/** Bash is what an agent fails at; the edit tools are what an attempt consists of. */
export const CAPTURE_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const RECALL_MATCHER = 'Bash';
/** Recall runs before the agent sees the failure, so it has to be quick or absent. */
const RECALL_TIMEOUT_SECONDS = 5;

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export function isNexusMemHook(command: string): boolean {
  const c = command.toLowerCase();
  return c.includes('agent-hook.js') || /agent\s+recall/.test(c);
}

function matcherFor(commands: AgentHookCommands, event: string): HookMatcher[] {
  const capture: HookMatcher = {
    matcher: CAPTURE_MATCHER,
    hooks: [{ type: 'command', command: commands.capture }],
  };
  if (event === 'PostToolUse') return [capture];
  return [
    capture,
    { matcher: RECALL_MATCHER, hooks: [{ type: 'command', command: commands.recall, timeout: RECALL_TIMEOUT_SECONDS }] },
  ];
}

/** Everything that is not ours, with empty leftovers dropped. */
function withoutOurs(entries: readonly HookMatcher[]): HookMatcher[] {
  return entries
    .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !isNexusMemHook(h.command ?? '')) }))
    .filter((entry) => (entry.hooks?.length ?? 0) > 0);
}

export function upsertAgentHooks(settings: ClaudeSettings, commands: AgentHookCommands): ClaudeSettings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    hooks[event] = [...withoutOurs(hooks[event] ?? []), ...matcherFor(commands, event)];
  }
  return { ...settings, hooks };
}

export function removeAgentHooks(settings: ClaudeSettings): { settings: ClaudeSettings; removed: number } {
  const hooks = { ...(settings.hooks ?? {}) };
  let removed = 0;

  for (const [event, entries] of Object.entries(hooks)) {
    const before = entries.flatMap((e) => e.hooks ?? []).filter((h) => isNexusMemHook(h.command ?? '')).length;
    removed += before;
    const kept = withoutOurs(entries);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  const next: ClaudeSettings = { ...settings, hooks };
  // An empty hooks object is noise in a file we did not create.
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

export interface AgentHookStatus {
  installed: boolean;
  /** False when an installed block points at a different NexusMem path, e.g. after moving the install. */
  upToDate: boolean;
}

export function agentHookStatus(settings: ClaudeSettings, commands: AgentHookCommands): AgentHookStatus {
  const present = Object.values(settings.hooks ?? {})
    .flatMap((entries) => entries.flatMap((e) => e.hooks ?? []))
    .map((h) => h.command ?? '')
    .filter(isNexusMemHook);

  if (present.length === 0) return { installed: false, upToDate: false };
  const expected = [commands.capture, commands.recall];
  return { installed: true, upToDate: expected.every((cmd) => present.includes(cmd)) };
}
