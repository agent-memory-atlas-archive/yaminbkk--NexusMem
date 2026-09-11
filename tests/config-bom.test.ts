import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentInstall } from '../src/cli/commands/agent.js';
import { runInit } from '../src/cli/commands/init.js';
import { readConfig, resolveWorkspace } from '../src/config/workspace.js';
import { gitFixture } from './helpers.js';

/**
 * Windows tools write a UTF-8 BOM routinely -- PowerShell 5.1's
 * `Set-Content -Encoding utf8` does, and so do several editors -- and
 * `JSON.parse` rejects the whole file when one is present.
 *
 * Found while setting up a real interactive session: a config.json rewritten
 * from PowerShell made `sync` fail with "is not valid JSON", which reads like
 * a corrupt file rather than an encoding detail.
 */

const BOM = String.fromCharCode(0xfeff);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-bom-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('user-editable JSON survives a UTF-8 BOM', () => {
  it('reads a workspace config that a Windows editor saved with one', async () => {
    const g = (...args: string[]) => gitFixture(dir, args, { env: process.env });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    g('add', '.');
    g('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    const ws = resolveWorkspace(dir);
    const original = readFileSync(ws.configPath, 'utf8');
    writeFileSync(ws.configPath, BOM + original, 'utf8');

    const config = await readConfig(ws);
    expect(config.version).toBe(1);
    expect(config.projectId).toEqual(expect.any(String));
  });

  it('installs agent hooks into a settings file that has one, instead of refusing it', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    writeFileSync(settingsPath, `${BOM}${JSON.stringify({ theme: 'dark' }, null, 2)}\n`, 'utf8');

    const out: string[] = [];
    expect(await runAgentInstall({ cwd: dir, scope: 'project', out: (c) => out.push(c) })).toBe(0);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as { theme?: string; hooks?: Record<string, unknown> };
    expect(out.join('')).toContain('installed');
    // The user's own settings survive, and the file is rewritten without the BOM.
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.hooks ?? {})).toContain('PostToolUseFailure');
  });

  it('still refuses a settings file that is genuinely not JSON', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), `${BOM}{ this is not json`);

    const out: string[] = [];
    expect(await runAgentInstall({ cwd: dir, scope: 'project', out: (c) => out.push(c) })).toBe(1);
    expect(out.join('')).toContain('refused');
  });
});
