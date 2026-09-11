/**
 * Generates and manages the block NexusMem inserts into a PowerShell profile
 * to log every command with its real timestamp, cwd and exit code.
 *
 * The block wraps the existing `prompt` function rather than replacing it,
 * so an already-customized prompt (oh-my-posh, posh-git, ...) keeps
 * rendering exactly as before -- logging piggybacks on the fact that
 * `prompt` runs once per command, it does not own the prompt's appearance.
 */

import { defaultRecorderCommand, type RecorderCommand } from './recorder-command.js';

const MARK_START = '# >>> nexusmem shell hook >>>';
const MARK_END = '# <<< nexusmem shell hook <<<';

/**
 * PowerShell single-quoted strings have exactly one escape rule (a literal
 * `'` doubles to `''`) and no backslash processing at all -- unlike a JSON
 * or JS string. `JSON.stringify` would leave a Windows path's backslashes
 * doubled in the resulting PowerShell literal, since JSON escaping and
 * PowerShell escaping are different rules applied to the same character.
 */
function toPowerShellLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function renderHookSnippet(logPath: string, recorder: RecorderCommand = defaultRecorderCommand()): string {
  return [
    MARK_START,
    'if (Test-Path Function:\\prompt) { $function:__ssd_original_prompt = $function:prompt }',
    '$global:__ssd_last_history_id = -1',
    `$global:__ssd_log_path = ${toPowerShellLiteral(logPath)}`,
    `$global:__ssd_node = ${toPowerShellLiteral(recorder.node)}`,
    `$global:__ssd_recorder = ${toPowerShellLiteral(recorder.script)}`,
    'function global:prompt {',
    // Must be first: Get-History (or anything else) below would overwrite $?.
    '  $__ssd_ok = $?',
    '  $__ssd_exit = $LASTEXITCODE',
    '  $__ssd_h = Get-History -Count 1 -ErrorAction SilentlyContinue',
    '  if ($__ssd_h -and $__ssd_h.Id -ne $global:__ssd_last_history_id) {',
    '    $global:__ssd_last_history_id = $__ssd_h.Id',
    '    try {',
    '      $__ssd_entry = [ordered]@{',
    '        ts = (Get-Date).ToString("o")',
    '        cwd = (Get-Location).Path',
    // $LASTEXITCODE alone misses cmdlet failures and goes stale after them; $? catches both.
    '        exitCode = if ($__ssd_ok) { 0 } elseif ($__ssd_exit) { $__ssd_exit } else { 1 }',
    '        durationMs = [int](($__ssd_h.EndExecutionTime - $__ssd_h.StartExecutionTime).TotalMilliseconds)',
    '        command = $__ssd_h.CommandLine',
    '      }',
    // The raw command only ever reaches the recorder's stdin (a pipe, never a file); it hashes and redacts before writing.
    '      $__ssd_psi = New-Object System.Diagnostics.ProcessStartInfo',
    '      $__ssd_psi.FileName = $global:__ssd_node',
    '      $__ssd_psi.Arguments = \'"{0}" --log "{1}" --shell pwsh-hook\' -f $global:__ssd_recorder, $global:__ssd_log_path',
    '      $__ssd_psi.UseShellExecute = $false',
    '      $__ssd_psi.CreateNoWindow = $true',
    '      $__ssd_psi.RedirectStandardInput = $true',
    '      $__ssd_p = [System.Diagnostics.Process]::Start($__ssd_psi)',
    // Bytes, not StandardInput.Write: Windows PowerShell would encode text in the console code page.
    '      $__ssd_bytes = [System.Text.Encoding]::UTF8.GetBytes(($__ssd_entry | ConvertTo-Json -Compress))',
    '      $__ssd_p.StandardInput.BaseStream.Write($__ssd_bytes, 0, $__ssd_bytes.Length)',
    '      $__ssd_p.StandardInput.Close()',
    '      $__ssd_p.Dispose()',
    '    } catch {}',
    '  }',
    '  if (Test-Path Function:\\__ssd_original_prompt) { & $function:__ssd_original_prompt }',
    "  else { \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \" }",
    '}',
    MARK_END,
    '',
  ].join('\n');
}

export function isHookInstalled(profileContent: string): boolean {
  return profileContent.includes(MARK_START);
}

export function stripHookSnippet(profileContent: string): string {
  const startIdx = profileContent.indexOf(MARK_START);
  const endIdx = profileContent.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) return profileContent;

  const afterBlock = profileContent.slice(endIdx + MARK_END.length).replace(/^\r?\n/, '');
  return profileContent.slice(0, startIdx) + afterBlock;
}

/** Idempotent: strips any existing block first, so re-running with a new log path updates cleanly. */
export function upsertHookSnippet(profileContent: string, logPath: string, recorder?: RecorderCommand): string {
  const stripped = stripHookSnippet(profileContent).replace(/\s+$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  return `${prefix}${renderHookSnippet(logPath, recorder)}`;
}
