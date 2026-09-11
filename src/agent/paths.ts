import { join } from 'node:path';
import { globalWorkspaceDir } from '../config/paths.js';

/**
 * One stream for every agent session on this machine, like the shell hook log
 * -- an agent session moves between repos, so the log is filtered by cwd at
 * read time rather than split per project.
 */
export function agentEventLogPath(): string {
  return join(globalWorkspaceDir(), 'agent-events.jsonl');
}
