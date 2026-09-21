import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * The logical state a model trial starts from, so that anything written into
 * it between seeding and launch -- by the delivery verifier or anything else
 * -- is detected rather than assumed away.
 *
 * Logical, not byte-level: every ordinary table's rows, the files under
 * NEXUSMEM_HOME, the working tree outside `.git`, and git's own HEAD and
 * status. Virtual tables are skipped because their contents live in shadow
 * tables that are dumped anyway, and reading a vec0 table would need the
 * extension loaded.
 *
 * Found by audit, and the reason this exists: at 71b31f3 the ambient trial's
 * own database was probed, and `agent session-start` spawns a detached
 * `sync --auto` that embeds every node when a local embedding server answers.
 * The trial then started with vectors, a recall-state file and moved sync
 * timestamps that the seeded state did not have.
 */

export interface LogicalState {
  db: Record<string, string[]>;
  home: Record<string, string>;
  tree: Record<string, string>;
  head: string;
  status: string;
}

const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 16);
const posixRel = (p: string): string => p.split('\\').join('/');

function fileHashes(dir: string, skip: (rel: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const rel = posixRel(entry);
    if (skip(rel)) continue;
    const path = join(dir, entry);
    if (statSync(path).isFile()) out[rel] = hash(readFileSync(path));
  }
  return out;
}

const cell = (_key: string, value: unknown): unknown =>
  Buffer.isBuffer(value) ? `blob:${hash(value)}` : typeof value === 'bigint' ? value.toString() : value;

export function dumpDatabase(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const out: Record<string, string[]> = {};
    for (const { name, sql } of tables) {
      if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '')) continue;
      out[name] = (db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).raw().all() as unknown[][])
        .map((row) => JSON.stringify(row, cell))
        .sort();
    }
    return out;
  } finally {
    db.close();
  }
}

/** The database files themselves are read logically above; their bytes would only add WAL noise. */
const DB_FILE = /^\.nexusmem\/memory\.db(-wal|-shm|-journal)?$/;

export function logicalState(repoDir: string, nmHome: string): LogicalState {
  return {
    db: dumpDatabase(join(repoDir, '.nexusmem', 'memory.db')),
    home: fileHashes(nmHome, () => false),
    tree: fileHashes(repoDir, (rel) => rel === '.git' || rel.startsWith('.git/') || DB_FILE.test(rel)),
    head: execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    status: execFileSync('git', ['-C', repoDir, 'status', '--porcelain', '-uall'], { encoding: 'utf8' }).trim(),
  };
}

/** Every difference between two states, one line each. Empty means the trial state was not touched. */
export function stateDiff(before: LogicalState, after: LogicalState): string[] {
  const out: string[] = [];
  for (const table of [...new Set([...Object.keys(before.db), ...Object.keys(after.db)])].sort()) {
    const a = new Set(before.db[table] ?? []);
    const b = new Set(after.db[table] ?? []);
    const added = [...b].filter((r) => !a.has(r)).length;
    const removed = [...a].filter((r) => !b.has(r)).length;
    if (added || removed) out.push(`db table ${table}: +${added} -${removed} row(s)`);
  }
  for (const [label, a, b] of [
    ['NEXUSMEM_HOME', before.home, after.home],
    ['working tree', before.tree, after.tree],
  ] as const) {
    for (const file of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[file] === b[file]) continue;
      out.push(`${label} ${file}: ${!a[file] ? 'created' : !b[file] ? 'removed' : 'changed'}`);
    }
  }
  if (before.head !== after.head) out.push('git HEAD moved');
  if (before.status !== after.status) out.push('git status changed');
  return out;
}
