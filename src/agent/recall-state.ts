import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalWorkspaceDir } from '../config/paths.js';

/**
 * What has already been said to one agent session, so ambient memory cannot
 * become ambient noise: the same failure is explained once, and a session has
 * a hard ceiling on how many injections it can receive.
 *
 * A small JSON file rather than a database: the recall path runs per tool
 * call, and this has to stay cheap and never block on a lock.
 */

export const MAX_INJECTIONS_PER_SESSION = 5;
const MAX_SESSIONS_KEPT = 20;

interface SessionState {
  count: number;
  keys: string[];
  at: number;
}

type StateFile = Record<string, SessionState>;

export function recallStatePath(): string {
  return join(globalWorkspaceDir(), 'agent-recall-state.json');
}

function read(path: string): StateFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

/**
 * True when this session may be told about `key` now. Recording the decision
 * is the caller's job (`markInjected`), so a lookup that finds nothing spends
 * no quota.
 */
export function shouldInject(sessionId: string, key: string, path = recallStatePath()): boolean {
  const session = read(path)[sessionId];
  if (!session) return true;
  return session.count < MAX_INJECTIONS_PER_SESSION && !session.keys.includes(key);
}

export function markInjected(sessionId: string, key: string, path = recallStatePath(), now = Date.now()): void {
  const state = read(path);
  const session = state[sessionId] ?? { count: 0, keys: [], at: now };
  session.count += 1;
  session.at = now;
  if (!session.keys.includes(key)) session.keys.push(key);
  state[sessionId] = session;

  // Sessions end without telling anyone, so keep only the most recent few.
  const pruned = Object.entries(state)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_SESSIONS_KEPT);

  try {
    writeFileSync(path, JSON.stringify(Object.fromEntries(pruned)), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // A quota we cannot persist must not break the agent's tool call.
  }
}
