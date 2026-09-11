/**
 * Entry point Claude Code's PostToolUse / PostToolUseFailure hooks run:
 *
 *   <hook payload on stdin> | node agent-hook.js [--log <path>]
 *
 * Its own small bundle, like the shell recorder, so it starts fast and loads
 * no native dependency. Silent by design: nothing on stdout or stderr, no
 * temp file, so no failure path can echo the payload it received. Any event
 * it cannot handle is dropped. It never exits 2, which is the only code that
 * would block the agent.
 */
import { appendAgentEvent } from '../../agent/record.js';
import { agentEventLogPath } from '../../agent/paths.js';
import { parseHookPayload } from './payload.js';

const MAX_EVENT_BYTES = 1_000_000;

const drop = (): never => process.exit(1);
process.on('uncaughtException', drop);
process.on('unhandledRejection', drop);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_EVENT_BYTES) drop();
    chunks.push(chunk as Buffer);
  }
  // Windows PowerShell can prepend a BOM to a redirected stdin; parseHookPayload trims it.
  const event = parseHookPayload(Buffer.concat(chunks).toString('utf8'), new Date().toISOString());
  if (!event) return drop();
  await appendAgentEvent(event, arg('--log') ?? agentEventLogPath());
  process.exit(0);
}

main().catch(drop);
