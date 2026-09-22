import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Builds the root CLI exactly once, in Vitest's main process, before any
 * test file (root or vscode-extension) starts running.
 *
 * `tests/mcp.test.ts` and `vscode-extension/tests/mcpClient.test.ts` both
 * spawn the built `dist/cli/index.js` as a real subprocess. Building per file
 * races: Vitest runs files in parallel, tsup clears its output directory
 * before writing, so the loser's spawn sees a missing or half-written module.
 * `globalSetup` runs once in the orchestrating process, strictly before any
 * worker starts.
 */
export default function setup(): void {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
