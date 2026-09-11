import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  hookLogPath,
  resolveBashProfilePath,
  resolvePowerShellProfilePath,
  resolveZshProfilePath,
} from '../shell/paths.js';
import * as bash from './bash.js';
import * as powershell from './powershell.js';
import * as zsh from './zsh.js';

export type ShellKind = 'pwsh' | 'bash' | 'zsh';

interface ShellHookModule {
  renderHookSnippet(logPath: string): string;
  isHookInstalled(profileContent: string): boolean;
  stripHookSnippet(profileContent: string): string;
  upsertHookSnippet(profileContent: string, logPath: string): string;
  resolveProfilePath(override?: string): Promise<string | null>;
}

const SHELL_MODULES: Record<ShellKind, ShellHookModule> = {
  pwsh: {
    renderHookSnippet: (logPath) => powershell.renderHookSnippet(logPath),
    isHookInstalled: powershell.isHookInstalled,
    stripHookSnippet: powershell.stripHookSnippet,
    upsertHookSnippet: powershell.upsertHookSnippet,
    resolveProfilePath: async (override) => override ?? (await resolvePowerShellProfilePath()),
  },
  bash: {
    renderHookSnippet: (logPath) => bash.renderHookSnippet(logPath),
    isHookInstalled: bash.isHookInstalled,
    stripHookSnippet: bash.stripHookSnippet,
    upsertHookSnippet: bash.upsertHookSnippet,
    resolveProfilePath: async (override) => override ?? resolveBashProfilePath(),
  },
  zsh: {
    renderHookSnippet: (logPath) => zsh.renderHookSnippet(logPath),
    isHookInstalled: zsh.isHookInstalled,
    stripHookSnippet: zsh.stripHookSnippet,
    upsertHookSnippet: zsh.upsertHookSnippet,
    resolveProfilePath: async (override) => override ?? resolveZshProfilePath(),
  },
};

/** win32 only ever means PowerShell here; elsewhere, `$SHELL` distinguishes zsh from the bash default. */
export function detectShellKind(): ShellKind {
  if (process.platform === 'win32') return 'pwsh';
  return (process.env.SHELL ?? '').includes('zsh') ? 'zsh' : 'bash';
}

export interface HookTarget {
  shell: ShellKind;
  profilePath: string;
  logPath: string;
}

export class ProfileNotFoundError extends Error {
  constructor(readonly shell: ShellKind) {
    super(
      shell === 'pwsh'
        ? 'Could not resolve a PowerShell profile path (tried `powershell -Command $PROFILE`). Pass --profile explicitly.'
        : `Could not resolve a ${shell} profile path. Pass --profile explicitly.`,
    );
    this.name = 'ProfileNotFoundError';
  }
}

export async function resolveHookTarget(
  shellOverride?: ShellKind,
  profileOverride?: string,
  logPathOverride?: string,
): Promise<HookTarget> {
  const shell = shellOverride ?? detectShellKind();
  const profilePath = await SHELL_MODULES[shell].resolveProfilePath(profileOverride);
  if (!profilePath) throw new ProfileNotFoundError(shell);
  return { shell, profilePath, logPath: logPathOverride ?? hookLogPath() };
}

async function readProfile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function installHook(target: HookTarget): Promise<{ changed: boolean; alreadyInstalled: boolean }> {
  const mod = SHELL_MODULES[target.shell];
  const current = await readProfile(target.profilePath);
  const alreadyInstalled = mod.isHookInstalled(current);
  const next = mod.upsertHookSnippet(current, target.logPath);

  if (next === current) return { changed: false, alreadyInstalled };

  await mkdir(dirname(target.profilePath), { recursive: true });
  await writeFile(target.profilePath, next, 'utf8');
  return { changed: true, alreadyInstalled };
}

export async function removeHook(target: HookTarget): Promise<{ changed: boolean }> {
  const mod = SHELL_MODULES[target.shell];
  const current = await readProfile(target.profilePath);
  if (!mod.isHookInstalled(current)) return { changed: false };

  await writeFile(target.profilePath, mod.stripHookSnippet(current), 'utf8');
  return { changed: true };
}

/**
 * `upToDate` is false when the installed block differs from what `hook install` would write now --
 * notably a block from before 0.10.5, which appends the raw command straight to the log file.
 */
export async function hookStatus(target: HookTarget): Promise<{ installed: boolean; upToDate: boolean }> {
  const mod = SHELL_MODULES[target.shell];
  const current = (await readProfile(target.profilePath)).replace(/\r\n/g, '\n');
  const installed = mod.isHookInstalled(current);
  const expected = mod.renderHookSnippet(target.logPath).trimEnd();
  const endMarker = expected.slice(expected.lastIndexOf('\n') + 1);
  const start = current.indexOf(expected.slice(0, expected.indexOf('\n')));
  const end = current.indexOf(endMarker, start);
  const upToDate = installed && start !== -1 && end !== -1 && current.slice(start, end + endMarker.length) === expected;
  return { installed, upToDate };
}
