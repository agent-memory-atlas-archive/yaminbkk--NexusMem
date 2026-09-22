import { describe, expect, it } from 'vitest';
import { V2_SCENARIOS, type V2Scenario } from '../eval/ambient-v2/scenario.js';
import { scoreTrial, summariseArm, type Arm, type TrialRecord } from '../eval/ambient-v2/scorer.js';

/**
 * The scorer is frozen before any trial runs, so its definitions are pinned
 * here rather than described in prose. The last three cases are mutation
 * proofs: each corrupts one piece of the mapping the scorer depends on and
 * asserts the verdict changes, so a scorer that silently stopped detecting
 * the intended behaviour cannot pass.
 */

const SHADOWED = V2_SCENARIOS.find((s) => s.name === 'shadowed-config')!;
const WINDOW = V2_SCENARIOS.find((s) => s.name === 'reverted-window')!;
const NULL_CASE = V2_SCENARIOS.find((s) => s.name === 'unrelated-history')!;

function record(scenario: V2Scenario, edits: Record<string, number>, over: Partial<TrialRecord> = {}): TrialRecord {
  return {
    scenario: scenario.name,
    arm: 'control' as Arm,
    repeat: 1,
    order: 1,
    editedFiles: Object.keys(edits),
    editIndex: edits,
    finalChangedFiles: Object.keys(edits),
    commandPassesAfter: true,
    toolCalls: 10,
    failedToolCalls: 1,
    turns: 6,
    costUsd: 0.1,
    durationMs: 1000,
    injections: [],
    nexusMemToolCalls: 0,
    ...over,
  };
}

describe('harder-eval scorer', () => {
  it('counts a dead end only when it came before the file that fixes it', () => {
    const before = scoreTrial(record(SHADOWED, { 'config/defaults.json': 3, 'config/site.json': 7 }), SHADOWED);
    expect(before.repeatedDeadEnd).toBe(true);
    expect(before.toolCallsBeforeFix).toBe(7);

    const after = scoreTrial(record(SHADOWED, { 'config/site.json': 3, 'config/defaults.json': 7 }), SHADOWED);
    expect(after.repeatedDeadEnd).toBe(false);
    expect(after.deadEndsRepeated).toBe(1);
  });

  it('treats never reaching the answer as repeating every dead end it tried', () => {
    const score = scoreTrial(record(SHADOWED, { 'src/retention.js': 4 }, { commandPassesAfter: false }), SHADOWED);
    expect(score.repeatedDeadEnd).toBe(true);
    expect(score.editedFixFile).toBe(false);
    expect(score.toolCallsBeforeFix).toBeNull();
    expect(score.taskSuccess).toBe(false);
  });

  it('excludes the null-memory scenario from the primary endpoint rather than scoring it zero', () => {
    const score = scoreTrial(record(NULL_CASE, { 'src/total.js': 5 }), NULL_CASE);
    expect(score.repeatedDeadEnd).toBeNull();
    expect(score.staleEdit).toBeNull();
    expect(score.followedIrrelevantMemory).toBe(false);
    expect(scoreTrial(record(NULL_CASE, { 'src/format.js': 2, 'src/total.js': 5 }), NULL_CASE).followedIrrelevantMemory).toBe(true);
  });

  it('flags an edit of the file git has since reverted', () => {
    expect(scoreTrial(record(WINDOW, { 'src/paging.js': 4 }), WINDOW).staleEdit).toBe(false);
    expect(scoreTrial(record(WINDOW, { 'src/window.js': 3, 'src/paging.js': 6 }), WINDOW).staleEdit).toBe(true);
  });

  it('credits delivery as useful only when it arrived before the decision and was followed', () => {
    const naming = [{ index: 2, text: 'NexusMem: ... fixed on 2026-01-01 by editing config/site.json' }];
    const useful = scoreTrial(record(SHADOWED, { 'config/site.json': 5 }, { injections: naming }), SHADOWED);
    expect(useful.usefulMemoryDelivery).toBe(true);

    const tooLate = scoreTrial(record(SHADOWED, { 'config/site.json': 1 }, { injections: naming }), SHADOWED);
    expect(tooLate.usefulMemoryDelivery).toBe(false);

    const ignored = scoreTrial(
      record(SHADOWED, { 'config/defaults.json': 3, 'config/site.json': 5 }, { injections: naming }),
      SHADOWED,
    );
    expect(ignored.memoryDelivered).toBe(true);
    expect(ignored.usefulMemoryDelivery).toBe(false);
  });

  it('summarises an arm over measured runs only', () => {
    const scores = [
      scoreTrial(record(SHADOWED, { 'config/defaults.json': 2, 'config/site.json': 5 }), SHADOWED),
      scoreTrial(record(SHADOWED, { 'config/site.json': 4 }), SHADOWED),
      scoreTrial(record(SHADOWED, {}, { systemFailure: 'delivery: nothing recalled' }), SHADOWED),
      scoreTrial(record(NULL_CASE, { 'src/total.js': 3 }), NULL_CASE),
    ];
    const summary = summariseArm('control', scores);
    expect(summary.measured).toBe(3);
    expect(summary.excluded).toBe(1);
    // The null scenario contributes to task success but not to the endpoint.
    expect(summary.repeatedDeadEnd).toEqual([1, 2]);
    expect(summary.taskSuccess).toEqual([3, 3]);
  });

  // --- mutation proofs -------------------------------------------------

  it('mutation: dropping the seeded dead end stops the endpoint firing', () => {
    const blind: V2Scenario = { ...SHADOWED, deadEnds: [] };
    const trial = record(SHADOWED, { 'config/defaults.json': 3, 'config/site.json': 7 });
    expect(scoreTrial(trial, SHADOWED).repeatedDeadEnd).toBe(true);
    expect(scoreTrial(trial, blind).repeatedDeadEnd).toBeNull();
  });

  it('mutation: pointing the answer at the wrong file flips the verdict', () => {
    const wrong: V2Scenario = { ...SHADOWED, fix: { ...SHADOWED.fix, file: 'src/prune.js' } };
    const trial = record(SHADOWED, { 'config/defaults.json': 3, 'config/site.json': 7 });
    expect(scoreTrial(trial, SHADOWED).editedFixFile).toBe(true);
    expect(scoreTrial(trial, wrong).editedFixFile).toBe(false);
    expect(scoreTrial(trial, wrong).toolCallsBeforeFix).toBeNull();
  });

  it('mutation: mislabelling the stale trap stops the detour being seen', () => {
    const trial = record(WINDOW, { 'src/window.js': 3, 'src/paging.js': 6 });
    expect(scoreTrial(trial, WINDOW).staleEdit).toBe(true);
    expect(scoreTrial(trial, { ...WINDOW, staleTrap: undefined }).staleEdit).toBeNull();
  });
});
