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
  /** Starts a background sync and opens the session with a digest, when there is one. */
  sessionStart: string;
}

/** A drive-letter or UNC path -- the only shape whose separators are backslashes. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Claude Code runs a hook command through a shell, which on Windows is bash:
 * a backslash path dies there with "unexpected EOF" and the hook silently
 * never runs. Found live -- the first end-to-end run captured nothing at all.
 * Forward slashes work in bash and in Windows APIs alike; the quotes cover
 * paths such as C:/Program Files/nodejs/node.exe.
 *
 * The rewrite is keyed on the path's shape, not on the current platform: a
 * backslash is an ordinary character in a POSIX filename, so flattening one
 * would silently point the hook at a different file. Double quotes alone are
 * not enough either -- a shell still expands `$` and a backquote inside them,
 * and a `"` in the path ends the string early. Each of those installs a hook
 * that never runs, with nothing on any output to say so.
 */
const quote = (path: string): string => {
  const p = WINDOWS_PATH.test(path) ? path.replace(/\\/g, '/') : path;
  return `"${p.replace(/(["$`\\])/g, '\\$1')}"`;
};

/**
 * The paths inside an installed hook command: the node executable and the
 * script it runs, un-escaped back to what the shell would pass along.
 *
 * The inverse of `quote`, so a caller can ask whether an installed command
 * can still resolve on this machine. Nothing else in a hook command is
 * quoted, so anything a settings file carries that we did not write yields
 * whatever quoted runs it happens to contain -- harmless, since the only
 * question asked of the result is whether the file exists.
 */
export function hookCommandPaths(command: string): string[] {
  return [...command.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
}

export function agentHookCommands(
  node = process.execPath,
  captureScript = fileURLToPath(new URL('../../dist/cli/agent-hook.js', import.meta.url)),
  cliScript = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)),
): AgentHookCommands {
  return {
    capture: `${quote(node)} ${quote(captureScript)}`,
    recall: `${quote(node)} ${quote(cliScript)} agent recall --trigger failure`,
    sessionStart: `${quote(node)} ${quote(cliScript)} agent session-start`,
  };
}
