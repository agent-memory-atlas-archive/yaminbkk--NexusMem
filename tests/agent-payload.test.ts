import { describe, expect, it } from 'vitest';
import { agentEventNaturalKey, MAX_ERROR_SIGNATURE_CHARS } from '../src/agent/event.js';
import { parseHookPayload } from '../src/adapters/claude-code/payload.js';
import { sha256Hex } from '../src/core/ids.js';

/**
 * The payloads below are the ones a live Claude Code 2.1.226 probe produced
 * (2026-09-11), field for field -- including the absence of any exit-code
 * field on a failure, which is why the code parses "Exit code N" out of text.
 */

const NOW = '2026-09-11T15:00:00.000Z';

const FAILING_BASH = {
  session_id: 'sess-1',
  transcript_path: 'C:/t/sess-1.jsonl',
  cwd: 'D:/repo',
  prompt_id: 'p1',
  permission_mode: 'default',
  effort: 'medium',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'ls ./no-such-dir-xyz', description: 'List nonexistent directory' },
  tool_use_id: 'toolu_01LptP88hUpbZQXdJNBJek9W',
  error: "Exit code 2\nls: cannot access './no-such-dir-xyz': No such file or directory",
  is_interrupt: false,
  duration_ms: 42,
};

const SUCCEEDING_BASH = {
  session_id: 'sess-1',
  cwd: 'D:/repo',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo probe-ok', description: 'Echo probe-ok string' },
  tool_response: { stdout: 'probe-ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  tool_use_id: 'toolu_01YHV8sripk465tg273QcykC',
  duration_ms: 17,
};

const EDIT = {
  session_id: 'sess-1',
  cwd: 'D:/repo',
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'D:/repo/src/a.ts', old_string: 'const apiKey = "sk_live_0000"', new_string: 'const apiKey = env.KEY' },
  tool_response: { filePath: 'D:/repo/src/a.ts' },
  tool_use_id: 'toolu_edit_1',
  duration_ms: 5,
};

const parse = (payload: unknown) => parseHookPayload(JSON.stringify(payload), NOW);

describe('parseHookPayload', () => {
  it('reads a failed Bash call: exit code out of the error text, plus the signature', () => {
    expect(parse(FAILING_BASH)).toEqual({
      agent: 'claude-code',
      sessionId: 'sess-1',
      eventId: 'toolu_01LptP88hUpbZQXdJNBJek9W',
      ts: NOW,
      cwd: 'D:/repo',
      kind: 'command',
      command: 'ls ./no-such-dir-xyz',
      commandHash: sha256Hex('ls ./no-such-dir-xyz').slice(0, 12),
      outcome: 'fail',
      exitCode: 2,
      errorSignature: "ls: cannot access './no-such-dir-xyz': No such file or directory",
      durationMs: 42,
    });
  });

  it('reads a successful Bash call as exit 0, with no error signature', () => {
    expect(parse(SUCCEEDING_BASH)).toMatchObject({ kind: 'command', command: 'echo probe-ok', outcome: 'ok', exitCode: 0 });
    expect(parse(SUCCEEDING_BASH)).not.toHaveProperty('errorSignature');
  });

  it('treats a user abort as interrupted, not as a failure', () => {
    expect(parse({ ...FAILING_BASH, is_interrupt: true })).toMatchObject({ outcome: 'interrupted' });
  });

  it('records only the path of an edit, never the file content the payload also carries', () => {
    const event = parse(EDIT);
    expect(event).toEqual({
      agent: 'claude-code',
      sessionId: 'sess-1',
      eventId: 'toolu_edit_1',
      ts: NOW,
      cwd: 'D:/repo',
      kind: 'edit',
      filePath: 'D:/repo/src/a.ts',
      outcome: 'ok',
      exitCode: null,
      durationMs: 5,
    });
    expect(JSON.stringify(event)).not.toContain('sk_live_0000');
  });

  it('redacts secrets in the command and in the error signature, keeping the raw hash', () => {
    const command = 'psql postgres://app:my-secret@db/app';
    const event = parse({
      ...FAILING_BASH,
      tool_input: { command },
      error: 'Exit code 1\nFATAL: password authentication failed for postgres://app:my-secret@db/app',
    });

    expect(JSON.stringify(event)).not.toContain('my-secret');
    expect(event).toMatchObject({ exitCode: 1, commandHash: sha256Hex(command).slice(0, 12) });
    expect(event?.errorSignature).toContain('[redacted]');
  });

  it('truncates a long error signature', () => {
    const event = parse({ ...FAILING_BASH, error: `Exit code 1\n${'x'.repeat(500)}` });
    expect(event?.errorSignature).toHaveLength(MAX_ERROR_SIGNATURE_CHARS);
  });

  it('keeps the error text when a failure does not start with an exit code', () => {
    expect(parse({ ...FAILING_BASH, error: 'Command timed out after 2m' })).toMatchObject({
      exitCode: null,
      errorSignature: 'Command timed out after 2m',
    });
  });

  it('gives one natural key per agent action, so both delivery paths land on one node', () => {
    expect(agentEventNaturalKey(parse(FAILING_BASH)!)).toBe('agent:claude-code:sess-1:toolu_01LptP88hUpbZQXdJNBJek9W');
  });

  it('tags a subagent event with its agent id', () => {
    expect(parse({ ...FAILING_BASH, agent_id: 'agent-7' })).toMatchObject({ agentId: 'agent-7' });
  });

  it.each([
    ['malformed JSON', '{"session_id":"s"'],
    ['a non-object', '"just a string"'],
    ['an unhandled event', JSON.stringify({ ...FAILING_BASH, hook_event_name: 'PreToolUse' })],
    ['an unhandled tool', JSON.stringify({ ...FAILING_BASH, tool_name: 'WebFetch' })],
    ['a missing tool_use_id', JSON.stringify({ ...FAILING_BASH, tool_use_id: undefined })],
    ['a missing session_id', JSON.stringify({ ...FAILING_BASH, session_id: undefined })],
    ['a Bash call with no command', JSON.stringify({ ...FAILING_BASH, tool_input: {} })],
    ['an edit with no path', JSON.stringify({ ...EDIT, tool_input: {} })],
  ])('drops %s', (_label, json) => {
    expect(parseHookPayload(json, NOW)).toBeNull();
  });
});
