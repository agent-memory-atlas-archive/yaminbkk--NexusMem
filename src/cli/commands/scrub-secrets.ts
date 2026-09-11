import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { readLiveRegistry } from '../../config/registry.js';
import { resolveWorkspace } from '../../config/workspace.js';
import { readRepoInfo } from '../../git/repo.js';
import { sanitizeHookLog } from '../../shell/hook-log.js';
import { hookLogPath } from '../../shell/paths.js';
import { SCRUB_KINDS, scrubDatabase, type ScrubReport } from '../../store/scrub.js';
import { OllamaEmbeddingProvider } from '../../vector/embed.js';
import { acquireSyncLock } from '../sync-lock.js';

export interface ScrubSecretsOptions {
  cwd: string;
  /** Every database in the NexusMem registry instead of just this repository's. */
  allProjects: boolean;
  /** Without it this is a dry run: counts only, nothing written. */
  yes: boolean;
  /** Re-embed redacted nodes now; otherwise the next sync does it. */
  embed: boolean;
  out?: (chunk: string) => void;
}

/**
 * Removes secrets that versions before the redaction fix already wrote: the
 * shared shell hook log and each database's rows, FTS index, embeddings and
 * on-disk remnants. Dry run unless `--yes`.
 */
export async function runScrubSecrets(opts: ScrubSecretsOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  let incomplete = false;

  const logPath = hookLogPath();
  out(`${pc.bold('shell hook log')} ${logPath}\n`);
  if (!existsSync(logPath)) {
    out(`  ${pc.dim('not present on this machine')}\n`);
  } else {
    try {
      const { linesChanged, legacyLines } = await sanitizeHookLog(logPath, { dryRun: !opts.yes });
      out(`  ${linesChanged} line(s) ${opts.yes ? 'redacted' : 'to redact'}\n`);
      if (legacyLines > 0) {
        out(
          `  ${pc.yellow(`${legacyLines} line(s) came from an outdated shell hook`)} that writes commands unredacted -- ` +
            'run `nexusmem hook install` again in each shell (see `nexusmem hook status`)\n',
        );
      }
    } catch (err) {
      incomplete = true;
      out(`  ${pc.red('could not redact the hook log')}: ${(err as Error).message}\n`);
    }
  }

  const dbPaths = opts.allProjects
    ? [...new Set((await readLiveRegistry()).entries.map((e) => e.dbPath))]
    : [resolveWorkspace((await readRepoInfo(opts.cwd)).root).dbPath];

  for (const dbPath of dbPaths) {
    out(`\n${pc.bold(dbPath)}\n`);
    if (!existsSync(dbPath)) {
      out(`  ${pc.dim('no database -- nothing to scrub')}\n`);
      continue;
    }
    // Keeps the post-commit hook's background sync from running mid-scrub.
    const lock = opts.yes ? acquireSyncLock(dirname(dbPath)) : null;
    if (opts.yes && !lock) {
      incomplete = true;
      out(`  ${pc.yellow('a background sync is using this database -- re-run when it finishes')}\n`);
      continue;
    }
    try {
      const report = await scrubDatabase(dbPath, {
        apply: opts.yes,
        embeddingProvider: opts.yes && opts.embed ? new OllamaEmbeddingProvider() : null,
      });
      printReport(report, out);
      if (report.remnantsPurged === false) incomplete = true;
    } catch (err) {
      incomplete = true;
      out(`  ${pc.red('scrub failed')}: ${(err as Error).message}\n`);
    } finally {
      lock?.release();
    }
  }

  if (!opts.yes) {
    out(
      `\n${pc.bold('Dry run')}: nothing was changed. Re-run with --yes to back up each database, redact it in place, ` +
        'drop and re-embed stale vectors, rebuild the FTS index, VACUUM, and truncate the WAL.\n',
    );
  }
  return incomplete ? 1 : 0;
}

function printReport(r: ScrubReport, out: (chunk: string) => void): void {
  for (const kind of SCRUB_KINDS) {
    const { scanned, changed } = r.byKind[kind];
    out(`  ${kind.padEnd(22)} ${String(scanned).padStart(6)} scanned  ${changed} ${r.applied ? 'redacted' : 'to redact'}\n`);
  }
  out(`  ${'contradiction reasons'.padEnd(22)} ${' '.repeat(14)}${r.contradictionReasonsChanged} ${r.applied ? 'redacted' : 'to redact'}\n`);

  if (r.applied) {
    if (r.backupPath) {
      out(`  ${pc.bold('backup')}  ${r.backupPath}\n`);
      out(
        `  ${pc.yellow('WARNING')} that backup was taken BEFORE redaction and still contains every secret removed here. ` +
          'Verify this database, then delete the backup yourself -- NexusMem never deletes backups.\n',
      );
    } else {
      out(`  ${pc.dim('no row needed redaction -- no backup taken')}\n`);
    }
    if (r.embeddingsDropped > 0) {
      out(
        `  dropped ${r.embeddingsDropped} stale embedding(s), re-embedded ${r.reembedded}` +
          (r.embeddingsPending > 0 ? `; ${r.embeddingsPending} still pending (the next \`nexusmem sync\` embeds them)` : '') +
          '\n',
      );
    }
    out(
      r.remnantsPurged
        ? `  FTS index rebuilt, database VACUUMed, WAL truncated\n`
        : `  ${pc.yellow('on-disk remnants NOT purged')}: the rows are redacted, but another process (MCP server, VS Code extension, ` +
            'a running sync) has this database open, which blocks VACUUM / WAL truncation. Close it and re-run `nexusmem scrub-secrets --yes`.\n',
    );
  }

  if (r.existingBackups.length > 0) {
    out(`  ${pc.yellow('older backups')} (may hold unredacted secrets; NexusMem never deletes them):\n`);
    for (const path of r.existingBackups) out(`    ${path}\n`);
  }
}
