import type { V2Scenario } from './scenario.js';

/**
 * The deterministic scorer for the harder ambient-memory experiment.
 *
 * Pure: it reads a trial record and the scenario definition and nothing else.
 * No prose is interpreted anywhere -- every term below is decided by which
 * files a run edited, in what order, and whether the command exits 0
 * afterwards. That is the whole point: the Phase-5 analysis had to be redone
 * twice because detection keyed on wording, and wording changed.
 *
 * Every definition here is frozen before any trial runs.
 */

export const ARMS = ['control', 'mcp', 'ambient'] as const;
export type Arm = (typeof ARMS)[number];

/** Something NexusMem put into the context, with the transcript position it arrived at. */
export interface Injection {
  /** Tool-call index the injection was seen at. 0 means before any tool call (SessionStart). */
  index: number;
  text: string;
}

export interface TrialRecord {
  scenario: string;
  arm: Arm;
  repeat: number;
  /** Position in the frozen trial-order manifest. */
  order: number;
  /** Set when a deterministic pre-flight failed: model behaviour is then not what was measured. */
  systemFailure?: string;
  error?: string;

  /** Repo-relative, forward slashes, in the order first edited. */
  editedFiles: readonly string[];
  /** Repo-relative path -> 1-based tool-call index of its first edit. */
  editIndex: Readonly<Record<string, number>>;
  /** Repo-relative paths the working tree differs by at the end. */
  finalChangedFiles: readonly string[];
  commandPassesAfter: boolean;

  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;

  injections: readonly Injection[];
  /** `mcp__nexusmem__*` calls the model chose to make. */
  nexusMemToolCalls: number;
}

export interface TrialScore {
  scenario: string;
  arm: Arm;
  repeat: number;
  /** Excluded from every rate below: the trial did not measure model behaviour. */
  measured: boolean;

  // --- primary endpoint -----------------------------------------------
  /**
   * PRIMARY. The run edited a file the seeded history proves was already
   * tried and left the check failing, before it touched the file that fixes
   * it. Null for scenarios that seed no dead end, which are excluded from the
   * endpoint by construction rather than scored as zero.
   */
  repeatedDeadEnd: boolean | null;

  // --- secondary ------------------------------------------------------
  taskSuccess: boolean;
  editedFixFile: boolean;
  toolCallsBeforeFix: number | null;
  deadEndsRepeated: number;
  /** Edited the file day 1 ended green on, which git has since reverted and which is inert today. */
  staleEdit: boolean | null;
  /** Edited a file only the off-topic history names. */
  followedIrrelevantMemory: boolean;
  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Ambient put something in front of the model at all. */
  memoryDelivered: boolean;
  /**
   * Causal-use rule, frozen before trials: an injection naming the file that
   * fixes it arrived BEFORE that file was first edited, and the run reached it
   * without first spending an edit on a disproved approach. An injection that
   * merely appears somewhere in the transcript does not count.
   */
  usefulMemoryDelivery: boolean;
  proactiveMcpCalls: number;
}

const leaf = (file: string): string => file.split('/').pop()!;

/** Does this injection name that file, by path or by basename? */
export const names = (text: string, file: string): boolean => text.includes(file) || text.includes(leaf(file));

const INFINITY_INDEX = Number.POSITIVE_INFINITY;

export function scoreTrial(record: TrialRecord, scenario: V2Scenario): TrialScore {
  const measured = !record.systemFailure && !record.error;
  const indexOf = (file: string): number => record.editIndex[file] ?? INFINITY_INDEX;

  // The moment the run reached the answer. Never edited it -> every dead end
  // it spent an edit on counts, which is the honest reading of a run that
  // repeated a disproved approach and never got there.
  const solutionIndex = indexOf(scenario.fix.file);
  const repeatedBeforeSolution = scenario.deadEnds.filter((e) => indexOf(e.file) < solutionIndex);

  const deliveredBeforeSolution = record.injections.filter((i) => i.index < solutionIndex);
  const usefulMemoryDelivery =
    solutionIndex !== INFINITY_INDEX &&
    repeatedBeforeSolution.length === 0 &&
    deliveredBeforeSolution.some((i) => names(i.text, scenario.fix.file));

  return {
    scenario: record.scenario,
    arm: record.arm,
    repeat: record.repeat,
    measured,

    repeatedDeadEnd: scenario.deadEnds.length === 0 ? null : repeatedBeforeSolution.length > 0,

    taskSuccess: record.commandPassesAfter,
    editedFixFile: solutionIndex !== INFINITY_INDEX,
    toolCallsBeforeFix: solutionIndex === INFINITY_INDEX ? null : solutionIndex,
    deadEndsRepeated: scenario.deadEnds.filter((e) => indexOf(e.file) !== INFINITY_INDEX).length,
    staleEdit: scenario.staleTrap ? indexOf(scenario.staleTrap.file) !== INFINITY_INDEX : null,
    followedIrrelevantMemory: scenario.noiseFiles.some((f) => indexOf(f) !== INFINITY_INDEX),
    toolCalls: record.toolCalls,
    failedToolCalls: record.failedToolCalls,
    turns: record.turns,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    memoryDelivered: record.injections.length > 0,
    usefulMemoryDelivery,
    proactiveMcpCalls: record.nexusMemToolCalls,
  };
}

export interface ArmSummary {
  arm: Arm;
  measured: number;
  excluded: number;
  /** Numerator and denominator of the primary endpoint, over scenarios that seed a dead end. */
  repeatedDeadEnd: [number, number];
  taskSuccess: [number, number];
  staleEdit: [number, number];
  followedIrrelevantMemory: [number, number];
  usefulMemoryDelivery: [number, number];
  medianToolCalls: number | null;
  medianFailedToolCalls: number | null;
  totalCostUsd: number;
  proactiveMcpCalls: number;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const ratio = (rows: readonly TrialScore[], pick: (s: TrialScore) => boolean | null): [number, number] => {
  const scored = rows.map(pick).filter((v): v is boolean => v !== null);
  return [scored.filter(Boolean).length, scored.length];
};

export function summariseArm(arm: Arm, all: readonly TrialScore[]): ArmSummary {
  const cell = all.filter((s) => s.arm === arm);
  const rows = cell.filter((s) => s.measured);
  return {
    arm,
    measured: rows.length,
    excluded: cell.length - rows.length,
    repeatedDeadEnd: ratio(rows, (s) => s.repeatedDeadEnd),
    taskSuccess: ratio(rows, (s) => s.taskSuccess),
    staleEdit: ratio(rows, (s) => s.staleEdit),
    followedIrrelevantMemory: ratio(rows, (s) => s.followedIrrelevantMemory),
    usefulMemoryDelivery: ratio(rows, (s) => s.usefulMemoryDelivery),
    medianToolCalls: median(rows.map((s) => s.toolCalls)),
    medianFailedToolCalls: median(rows.map((s) => s.failedToolCalls)),
    totalCostUsd: rows.reduce((sum, s) => sum + s.costUsd, 0),
    proactiveMcpCalls: rows.reduce((sum, s) => sum + s.proactiveMcpCalls, 0),
  };
}
