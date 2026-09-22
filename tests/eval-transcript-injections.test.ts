import { describe, expect, it } from 'vitest';
import { collectInjections, injectedText, type TranscriptEntry } from '../eval/ambient/transcript-injections.js';

// Attachment shapes copied from the Phase-5.3 trigger-fix transcripts (Claude Code 2.1.226).
const DIGEST = 'NexusMem: 3 relevant command(s) from the last 14 days:\n- node check.js (failed here before, fixed 2026-09-09)';
const RECALL = 'NexusMem: this exact command has failed in this repository before (2 time(s)).';

describe('injectedText', () => {
  it('reads a SessionStart digest, whose content is a string', () => {
    expect(injectedText({ type: 'hook_success', hookName: 'SessionStart:startup', content: DIGEST })).toBe(DIGEST);
  });

  it.each(['PostToolUse:Bash', 'PostToolUseFailure:Bash'])('reads %s recall, whose content is an array', (hookName) => {
    expect(injectedText({ type: 'hook_additional_context', hookName, content: [RECALL] })).toBe(RECALL);
  });

  it('counts a tool-event recall once: its hook_success record carries no text', () => {
    const records = [
      { type: 'hook_success', hookName: 'PostToolUse:Bash', content: '' },
      { type: 'hook_additional_context', hookName: 'PostToolUse:Bash', content: [RECALL] },
    ];
    expect(records.map(injectedText).filter((t) => t !== null)).toEqual([RECALL]);
  });

  it.each([
    ['a non-hook attachment', { type: 'skill_listing', content: RECALL }],
    ['hook text that is not NexusMem', { type: 'hook_additional_context', content: ['some other hook'] }],
    ['an array with a non-string entry', { type: 'hook_additional_context', content: [RECALL, 1] }],
    ['no attachment', undefined],
  ])('ignores %s', (_label, attachment) => {
    expect(injectedText(attachment)).toBeNull();
  });
});

describe('collectInjections', () => {
  const envelope = (text: string) => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });
  const userText = (text: string): TranscriptEntry => ({ message: { role: 'user', content: [{ type: 'text', text }] } });

  it('counts an injection recorded as an attachment and as user text once', () => {
    const entries: TranscriptEntry[] = [
      { attachment: { type: 'hook_additional_context', hookName: 'PostToolUse:Bash', content: [RECALL] } },
      userText(RECALL),
    ];
    expect(collectInjections(entries)).toEqual([RECALL]);
  });

  it('counts a content injection and its stdout envelope once', () => {
    const entries: TranscriptEntry[] = [
      { attachment: { type: 'hook_success', hookName: 'PostToolUse:Bash', content: '', stdout: envelope(RECALL) } },
      { attachment: { type: 'hook_additional_context', hookName: 'PostToolUse:Bash', content: [RECALL] } },
    ];
    expect(collectInjections(entries)).toEqual([RECALL]);
  });

  it('keeps an injection that only arrived as user text', () => {
    expect(collectInjections([userText(`<system-reminder>${DIGEST}`)])).toEqual([DIGEST]);
  });

  it('keeps an injection that only arrived as a stdout envelope', () => {
    expect(collectInjections([{ attachment: { type: 'hook_success', content: '', stdout: envelope(RECALL) } }])).toEqual([RECALL]);
  });

  it('still counts a recall that fired twice twice', () => {
    const attached: TranscriptEntry = { attachment: { type: 'hook_additional_context', content: [RECALL] } };
    expect(collectInjections([attached, userText(RECALL), attached, userText(RECALL)])).toEqual([RECALL, RECALL]);
  });

  it('matches a text copy cut at 1500 characters to its full attachment', () => {
    const long = `${RECALL}\n${'- x\n'.repeat(600)}`;
    const entries: TranscriptEntry[] = [{ attachment: { type: 'hook_additional_context', content: [long] } }, userText(long)];
    expect(collectInjections(entries)).toEqual([long]);
  });

  it('ignores what the assistant says about NexusMem', () => {
    expect(collectInjections([{ message: { role: 'assistant', content: [{ type: 'text', text: RECALL }] } }])).toEqual([]);
  });
});
