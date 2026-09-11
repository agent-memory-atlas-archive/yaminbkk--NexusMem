import { fileURLToPath } from 'node:url';

/**
 * How an installed agent hook reaches NexusMem.
 *
 * Resolved against this module's own URL, which sits two levels below the
 * package root both in source (src/agent/) and once bundled (dist/cli/) --
 * the same trick hooks/recorder-command.ts uses. A module under
 * adapters/claude-code/ could not do this: bundling would change its depth.
 */
export interface AgentHookCommands {
  /** Fast, no-database capture path. */
  capture: string;
  /** Full CLI: recall has to read the database, which the capture bundle cannot. */
  recall: string;
}

const quote = (path: string): string => (path.includes(' ') ? `"${path}"` : path);

export function agentHookCommands(
  node = process.execPath,
  captureScript = fileURLToPath(new URL('../../dist/cli/agent-hook.js', import.meta.url)),
  cliScript = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)),
): AgentHookCommands {
  return {
    capture: `${quote(node)} ${quote(captureScript)}`,
    recall: `${quote(node)} ${quote(cliScript)} agent recall --trigger failure`,
  };
}
