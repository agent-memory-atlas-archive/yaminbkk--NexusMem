/**
 * Entry point the installed shell hooks run once per command:
 *
 *   <hook> | node recorder.js --log <path> --shell <pwsh-hook|bash-hook|zsh-hook>
 *
 * Bundled separately from the CLI so it starts fast. Silent by design: it
 * never writes to stdout or stderr and creates no temp files, so no failure
 * path -- a bad event, an unwritable log, a crash -- can echo the command it
 * received anywhere. On any failure the event is dropped.
 */
import { recordShellEvent } from '../shell/recorder.js';

const MAX_EVENT_BYTES = 1_000_000;

const drop = (): never => process.exit(1);
process.on('uncaughtException', drop);
process.on('unhandledRejection', drop);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const logPath = arg('--log');
  const shell = arg('--shell');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_EVENT_BYTES) drop();
    chunks.push(chunk as Buffer);
  }
  const ok = logPath && shell ? await recordShellEvent(Buffer.concat(chunks).toString('utf8'), logPath, shell) : false;
  process.exit(ok ? 0 : 1);
}

main().catch(drop);
