# Harder ambient-memory experiment — frozen design

This is a **separate, versioned** experiment. It does not replace, rewrite or
re-interpret the Phase-5 one in `eval/ambient/`, whose scenarios, results and
analysis stay exactly as they are. That result remains:

```
control  9/9      mcp  9/9      ambient  9/9      ambient useful recall  4/9
```

**No model trial of this design has been run.** This directory is the design,
its fixtures, its scorer, and the deterministic proofs that they work.

## 1. Why the old experiment could not answer the question

The three Phase-5 fixtures all failed with output that named the module to
change:

| scenario | what the failing command printed | where the answer was |
| --- | --- | --- |
| `retry-regression` | `TypeError: ... reading 'toFixed'` from `retry.js` | one import away, in `parse.js` |
| `lost-writes` | `expected 3 records committed, got 0` | `writer.js`, whose sibling `reader.js` shows the corrected form |
| `stale-fix` | `bad encoding: id=7,tags=a,b` against an expected `id=7;tags=a,b` | the one `join` in `encode.js` |

Each repository held five to seven small files. In every case ordinary
inspection — read the stack trace, read the assertion, read the one file it
points at — reaches the answer, and the seeded history only restates what
reading already gave. The recorded consequence is not that ambient lost: it is
that **the dead-end rate was 0/27 in every arm**. A measure with no variance in
the control arm cannot discriminate, at any sample size. Ambient useful recall
moving 2/9 → 3/9 → 4/9 across reruns is noise against that background.

Secondary contributors, recorded for completeness: 25 turns is an unlimited
budget for a five-file repository, and the "abandoned approaches" (a retry
budget, a log guard, a timeout constant) were never tempting, because the
error pointed elsewhere from the first turn.

## 2. What this experiment measures

> Does automatically delivered engineering history change useful agent
> behaviour on a realistic coding task?

Not "can NexusMem retrieve relevant text" — the deterministic retrieval tests
already answer that. The fixtures are therefore built the other way round from
Phase 5: the failing output names a symptom and no file, the most attractive
candidate in the workspace is **proven** not to fix it, and the seeded history
records that someone already tried that candidate.

Task success is **deliberately not** the primary endpoint. A ceiling there is
expected and acceptable.

### Primary endpoint (frozen)

**Repeated dead-end rate.** Per trial, a boolean:

> The run edited a file the seeded history proves was already tried and left
> the check failing, **before** it first edited the file that fixes it.

"Before it reached the answer" is decided by file evidence alone: the tool-call
index of the first edit of `fix.file`. A run that never edits that file has
every dead end it spent an edit on counted, which is the honest reading of a
run that repeated a disproved approach and never got there.

`unrelated-history` seeds no dead end, so it scores `null` and is **excluded
from the endpoint by construction** rather than counted as a zero.

### Secondary endpoints

task success · edited the file that fixes it · tool calls before that edit ·
stale edit (`reverted-window` only) · followed irrelevant memory · tool calls ·
failed tool calls · turns · cost · duration · memory delivered · useful memory
delivery · proactive MCP calls.

### Useful-delivery rule (frozen before trials)

An injection counts as causally useful only when **all** of:

1. it names the file that fixes the check -- its exact repo-relative path, or
   its bare basename where the text gives no directory at all (never a
   substring: `website.json` does not name `site.json`), and
2. it arrived at a transcript position strictly before that file was first
   edited, and
3. the run reached that file without first spending an edit on a disproved
   approach.

An injection that merely appears somewhere in the transcript does not count.

## 3. The scenarios

| scenario | category | intended memory advantage | primary endpoint |
| --- | --- | --- | --- |
| `shadowed-config` | previously failed approach / wrong layer | **location**: which of several plausible files is authoritative | yes |
| `reverted-window` | stale / reverted fix | **discrimination**: the answer memory knows is no longer the answer | yes |
| `unrelated-history` | null memory | **none**: memory must not cost anything when it is irrelevant | no (null case) |

Three strong scenarios rather than five weak ones, as the design rules allow.
Each has a distinct intended advantage; none is a variant of another.

### `shadowed-config`

`node check.js` prints `retention must be 30 days, got 7`. `config/defaults.json`
visibly holds `"retentionDays": 7` — the most attractive edit in the workspace.
It is inert: `src/config/load.js` merges every `config/*.json` in sorted order,
and `config/site.json` sorts after it and also sets `7`. The second dead end,
coercing the value in `src/retention.js`, is equally plausible and equally
inert. The answer is `config/site.json`.

*Rediscovery route (documented, never in the task):* edit `config/defaults.json`,
re-run, observe the effective value did not move, then read the loader or grep
the key and find the second source merged over it.

### `reverted-window`

`node check.js` prints `bad buckets: [[1,2],[3,4],[5,6]]`. Day 1 ended green by
widening the shared `src/window.js`; git then reverted that for breaking the
digest job, and the grouping path was rewired onto its own `src/paging.js`,
which a later refactor folded back to the shared default. `src/window.js` is
still imported by `src/bucket.js` (for an unrelated estimate) and by
`src/digest.js`, so it still looks live — and editing it now changes nothing.

This is the scenario where memory can **harm**: a system that repeats "this is
what fixed it" without qualification sends the run to an inert file. The
product labels it (`no longer holds`) via a revert commit that touches the same
file; whether that labelling is enough is what the trial measures.

### `unrelated-history`

A plain bug in `src/total.js` (a string accumulator). The seeded history is
rich and concerns a **different command** (`node tools/report.js eu`) and
different files (`src/format.js`, `src/locale.js`), both of which really exist
in the workspace so following the memory is possible. Nothing here should help.
What is measured is whether delivery costs anything: extra tool calls, an edit
to a file only the off-topic history names, a worse outcome than control.

Delivery verification asserts the opposite of the other two here: recall must
**not** claim a prior failure for this command.

## 4. Candidates considered and rejected

| candidate | why rejected |
| --- | --- |
| **ordering / environment** — a loader that depends on `readdirSync` order, fixed by sorting | the fixture's own outcome would vary by platform, so it could not be deterministically verified before trials |
| **two-setting conjunction in one file** — both flags must flip | the scorer is file-level by design; with both dead ends and the answer in one file there is nothing to score without interpreting edit contents |
| **generated artifact** — edit the file, a build step overwrites it | to make the overwrite happen during `node check.js`, the check itself would have to run the generator, which is not a realistic check; and editing the data file directly would simply work |
| **failed dependency / tool choice** — a package already tried and rejected | needs `npm install`, so network and non-determinism, against the local-first performance rules |
| **regression in a sibling module** — the same bug class recurring | this is exactly `lost-writes`, which is one of the three that hit the ceiling: the antipattern is famous enough to be recognised on sight |
| **double cap** — two limits, the obvious one already loose | the attractor has to be a literal equal to the wrong output, which makes it a coin flip between two grep hits; and it duplicates `shadowed-config`'s category |

## 5. Anti-ceiling analysis

| scenario | decision point | tempting dead end | why inspection does not instantly solve it |
| --- | --- | --- | --- |
| `shadowed-config` | which config file is authoritative | `config/defaults.json`, which literally shows the reported value | the merge order is in a loader nothing in the failing path names; the two files are indistinguishable without reading it |
| `reverted-window` | which of two size sources the grouping path calls | `src/window.js`, which is still imported by the same file and by a second module | both are one-line `return 2`; telling them apart needs reading which one `bucketise` actually calls |
| `unrelated-history` | none — this is the null case | none seeded | expected to be solved quickly in every arm; that is the point |

The claim being made is narrow and honest: **the dead-end base rate in control
should be materially above zero**, which is the one thing Phase 5 did not have.
It is not claimed that these tasks are hard, or that task success will
discriminate. Scale is not the discriminator either — these are still small
repositories, and `Grep` is deliberately left available to every arm.

## 6. Anti-rigging

- One task sentence, identical for all three scenarios and all three arms,
  naming no file, no approach, and no memory system. Asserted in
  `tests/eval-v2-scenario.test.ts`.
- Scenario names and every fixture path are scanned for mechanism vocabulary
  (`nexusmem`, `memory`, `recall`, `previous attempt`, `known fix`, `stale`,
  `failed before`, `hint`). Fixtures use ordinary project names.
- The model's working directory is a neutral `workspace-*` temp directory, so
  no shell command it writes spells out the scenario or the arm.
- Git commit subjects **do** describe the abandoned attempts. That is the
  rediscovery route, available identically to every arm, and is what makes the
  control arm solvable rather than blind.
- The MCP arm is never prompted to call the tools. Phase 5 measured 0 proactive
  `mcp__nexusmem__*` calls across 18 trials that had them available; nothing
  here is arranged to change that number.

## 7. Information parity

All three arms share: workspace bytes, task string, model, `--max-turns 25`,
the ordinary tool set (`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`), an
empty-by-default MCP config, and a `--settings` file (so only its contents
differ, not whether one was passed). Differences are exactly:

| arm | NexusMem project dir | seeded event log | MCP server | installed hooks |
| --- | --- | --- | --- | --- |
| `control` | no | no | no | no |
| `mcp` | yes | yes | yes | no |
| `ambient` | yes | yes | no | yes |

The ambient arm is handed the empty MCP config, exactly like control: its
only channel to the memory is the installed hooks. (The first version of this
table said "reachable" for ambient; `claudeArgs` in `run.ts` never gave it
that, and the table was corrected before any trial ran.)

`eval/ambient-v2/isolation.ts` asserts this off the filesystem on every trial,
not from what the runner intended.

## 8. Sample size, order and cost

```
3 scenarios x 7 repeats x 3 arms = 63 trials
primary endpoint denominator: 2 scenarios x 7 repeats = 14 per arm
```

**No formal power calculation is claimed.** What 14 per arm buys, by Fisher
exact test at α=0.05: 11/14 vs 3/14 separates (p≈0.004), 10/14 vs 4/14
separates (p≈0.03), 9/14 vs 5/14 does not (p≈0.13). So the design is powered
for a large practical effect (≈0.4 absolute or more) and nothing smaller. That
is deliberate: a smaller effect than that would not change the product
decision.

**Order.** Trials are blocked by (scenario, repeat); the three arms inside a
block rotate which goes first, so each arm leads exactly 7 blocks, and the
blocks are shuffled from a fixed seed. Reproducible from the seed alone and
recorded in `manifest.json`.

**Cost.** No per-trial cost from the Phase-5 run survives in the repository, so
there is no measured figure to extrapolate from and none is invented here. The
structural bounds are: 63 trials, ≤25 turns each, a repository of 8–13 small
files. The runner records `total_cost_usd` per trial, so the first block of
three calibrates the rest, and a real run can be stopped after it. Expected
wall time is dominated by the per-trial deterministic pre-flight (~4–8 s for
each of the 21 ambient trials) plus the model turns themselves.

**Disk.** One transcript per trial plus `records.json`, `scores.json` and
`manifest.json`; fixtures live in temp directories and are removed after each
trial.

## 9. Running it

```
npm run build
npx tsx eval/ambient-v2/verify-fixtures.ts     # fixtures are internally truthful
npx tsx eval/ambient-v2/verify-delivery.ts     # the product can deliver each scenario (on disposable twins)
npx tsx eval/ambient-v2/fingerprint.ts         # the hashes to record
npx tsx eval/ambient-v2/run.ts --dry-run       # full orchestration, MODEL CALL COUNT 0
```

A real run additionally requires `NEXUSMEM_EVAL_V2_AUTHORIZE=1`, so trials
cannot start from a mistyped argument.

## 10. Freezing

Record the fingerprints from `fingerprint.ts` with any results. If any of them
changes after trials begin, results from before and after describe different
experiments and must not be pooled.

The fingerprints are host-independent: event paths are canonicalised at the
fingerprint boundary (separator and placeholder root only; case, drive letters
and UNC shares are kept distinct), and source files are hashed with LF line
endings. Tests build Windows-shaped and POSIX-shaped spellings of the same
fixture explicitly and require one hash for both.

## 11. Review fixes made before any trial

The first design commit (`71b31f3`) was reviewed before a single model call.
Five harness defects were found and fixed; scenario definitions, prompts,
fixtures, seeded histories, the primary endpoint, repeats and trial order are
unchanged by all of them.

| # | defect at 71b31f3 | effect had it shipped | fix |
| --- | --- | --- | --- |
| F1 | event paths hashed as the host's `join` spells them | `scenarios` and `design` differed between a Windows and a POSIX host for byte-identical content | canonicalise at the fingerprint boundary only; runtime events keep native paths |
| F2 | containment case-sensitive everywhere, uniqueness case-folded everywhere | spurious isolation failures on Windows, merged distinct paths on POSIX | fold case on win32 only; contain on whole path components |
| F3 | delivery probed the ambient trial's own instance | the trial started with state the seeded experiment did not have (see below) | prove delivery on a disposable twin; diff the trial's logical state across the pre-flight and fail on any change |
| F4 | `git diff --name-only HEAD` for the changed-file record | a solution that adds a new file (e.g. a config that sorts last) left no trace | `git status --porcelain -z -uall`, harness-owned paths excluded |
| F5 | `String.includes` for "does this injection name the fix file" | `config/website.json` counted as naming `config/site.json` | exact repo-relative path, or a bare basename only when no directory is given |

**F3 in detail.** A before/after logical diff of the ambient trial's own
state around the old pre-flight found, for every scenario:

- `agent-recall-state.json` created under NEXUSMEM_HOME -- written by every
  recall that fires. Session-keyed, so a new model session would not collide
  with it, but it is trial-visible state the seeded experiment did not have.
- `agent session-start` spawns a detached `sync --auto`, which does not pass
  `--no-embed`. On a host with a local embedding server it embedded every
  node (`nodes_vec_*` rows, `meta.embedding.identity`); without one it does
  not. The trial's starting state therefore depended on what the orchestration
  host happened to be running. Nothing on the ambient arm's delivery path reads
  vectors, and the ambient arm has no MCP server, so no endpoint was changed by
  it -- but it broke the invariant that every trial starts from the seeded
  state, and it made that state host-dependent.
- `sync_state` timestamps, the `projects` row's last-seen time and the
  `projects.json` registry moved -- timestamps only.

After the fix the same diff is empty for the ambient and mcp pre-flights, and
`tests/eval-v2-contamination.test.ts` proves the guard is not vacuous: probing
the trial itself is caught, as is a single synthetic row or file.

Delivery is now proved on a twin built by the same function from the same
frozen definition, with the same hooks installed and the same product path
exercised. What that proves is that this definition, with this build, delivers
-- not that the trial's own bytes were probed, which is exactly what must not
happen.
