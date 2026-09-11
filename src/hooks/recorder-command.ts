import { fileURLToPath } from 'node:url';

/** How an installed shell hook reaches the recorder: an absolute node binary plus the bundled recorder script. */
export interface RecorderCommand {
  node: string;
  script: string;
}

/**
 * Resolved against this module's own URL, which sits two levels below the
 * package root both in source (src/hooks/) and once bundled (dist/cli/) --
 * the same trick core/version.ts uses to find package.json.
 */
export function defaultRecorderCommand(): RecorderCommand {
  return { node: process.execPath, script: fileURLToPath(new URL('../../dist/cli/recorder.js', import.meta.url)) };
}

/** Git Bash runs Windows executables fine, but only forward-slash paths survive its quoting untouched. */
export function forPosixShell(path: string): string {
  return /^[A-Za-z]:\\/.test(path) ? path.replace(/\\/g, '/') : path;
}
