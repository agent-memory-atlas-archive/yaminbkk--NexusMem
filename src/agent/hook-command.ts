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

/**
 * Claude Code runs a hook command through a shell, which on Windows is bash:
 * a backslash path dies there with "unexpected EOF" and the hook silently
 * never runs. Found live -- the first end-to-end run captured nothing at all.
 * Forward slashes work in bash and in Windows APIs alike; the quotes cover
 * paths such as C:/Program Files/nodejs/node.exe.
 */
const quote = (path: string): string => `"${path.replace(/\\/g, '/')}"`;

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
