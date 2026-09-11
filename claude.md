# CLAUDE.md

## NexusMem Development Rules

Read the existing architecture and conventions before changing code.
Prefer extending existing seams over introducing new subsystems.

Keep changes narrowly scoped.
Do not add unrelated features, refactors, abstractions, or cleanup just because they seem useful.

## Git Commit Discipline

Work in small, reviewable, independently verified commits.

A commit should represent one complete logical change that can be reviewed,
reverted, and bisected independently.

Do not accumulate an entire feature into one large commit.

### Workflow

For each logical implementation unit:

1. Inspect the relevant existing code and tests.
2. Define the smallest coherent change.
3. Implement only that change.
4. Add or update tests that prove the behavior.
5. Run the relevant targeted tests.
6. Run `npx tsc --noEmit` when production TypeScript or interfaces change.
7. Run `git diff --check`.
8. Inspect `git diff` and `git status`.
9. Commit only when the unit is green.
10. Continue to the next logical unit.

Tests that prove a behavior should normally be committed with that behavior,
not in a later generic test commit.

### Commit Boundaries

Prefer architectural boundaries such as:

- core types / normalization
- vendor adapters
- recorder / persistence
- collectors / ingestion
- correlation
- retrieval / recall
- CLI integration
- schema / migrations
- security fixes
- documentation
- release metadata

Do not split commits merely by file count or number of lines.

Do not create microscopic commits when two changes are required for one
coherent behavior.

Rule of thumb:

> If two changes can be independently reviewed, tested, reverted, or
> bisected, prefer separate commits.
>
> If separating them leaves either commit broken or meaningless, keep
> them together.

### Commit Messages

Use concise conventional commit messages:

- `feat(scope): ...`
- `fix(scope): ...`
- `refactor(scope): ...`
- `test(scope): ...`
- `docs(scope): ...`
- `chore(scope): ...`

Describe the behavior introduced by the commit.

Good:
`feat(agent): collect agent events into memory`

Bad:
`update files`
`continue work`
`fix stuff`

## Testing

Use targeted tests while developing each atomic change.

Before declaring a release or major integration ready, run the full relevant
validation suite:

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- `npm pack --dry-run`
- `git diff --check`

Never claim a test passed unless it was actually executed successfully.

If a test fails, determine whether it is:

- a product regression
- a test regression
- an environment/tooling failure

Do not dismiss failures without evidence.

## Security

NexusMem handles potentially sensitive developer context.

Treat all external or agent-generated input as untrusted.

Never persist raw secrets when a sanitized representation is sufficient.

For security-sensitive changes:

1. State the security invariant.
2. Add regression tests.
3. Test failure/error paths, not only the happy path.
4. Prefer fail-closed behavior.
5. Keep the security change isolated from unrelated refactoring.
6. Verify durable storage, metadata, logs, stdout/stderr, indexes, and
   retrieval paths where relevant.

Never print or expose secret values while auditing.

## Architecture

Keep NexusMem core vendor-neutral.

Vendor-specific integrations such as Claude Code, Codex, or Cursor should
live behind adapters rather than leaking vendor-specific assumptions into
core memory, storage, correlation, or retrieval logic.

Prefer:

vendor event
→ adapter
→ NexusMem canonical type
→ core processing

over teaching the core about every vendor.

Reuse existing collectors, stores, provenance, reconciliation, retrieval,
and security infrastructure where appropriate.

Do not introduce a new subsystem unless the existing architecture cannot
support the requirement cleanly.

## Evidence and Correlation

NexusMem must not claim more than the available evidence supports.

Do not fabricate:

- timestamps
- exit codes
- failure→fix relationships
- provenance
- causal relationships
- agent actions

Represent missing information as unknown/null where appropriate.

Correlation should be conservative.
Ambiguous evidence is preferable to a confident false relationship.

## Performance

NexusMem is intended to stay lightweight and local-first.

Avoid:

- unnecessary network dependencies
- unbounded retrieval
- querying memory on every prompt
- unnecessary embedding work
- token-heavy context injection
- full-corpus work when incremental processing is possible

Measure before introducing optimization heuristics.

## Scope Control

Do not turn a bug fix into a redesign.

Do not turn user feedback into multiple speculative features.

For the current task, distinguish between:

- required for correctness
- required by the acceptance criteria
- useful later

Implement the first two.
Report the third instead of implementing it.

## Git Safety

Local commits are allowed after their logical unit passes verification.

Do NOT:

- push
- force-push
- tag
- publish packages
- create releases
- merge branches
- rewrite published history

unless explicitly instructed.

Never use destructive Git operations merely to make an inconvenient working
tree disappear.

## Before Every Commit

Check:

- tests for the changed behavior pass
- `git diff --check` passes
- the diff contains only the intended logical change
- no debug/scratch/generated files slipped in
- no secrets are present
- the commit can be explained in one sentence

Then commit and continue.

## Before Saying "Done"

Report:

- commits created
- exact files changed
- tests actually run and their results
- architectural decisions made
- known limitations
- remaining blockers

## Commit Granularity

Prefer many small, coherent commits over a few large ones.

For a substantial feature release, aim for a fine-grained history where each
architectural capability, integration seam, regression fix, migration,
security hardening step, CLI surface, test boundary, and release step is
committed independently when it can be reviewed and reverted on its own.

For large releases, 20–30+ commits is a healthy outcome when the work
naturally contains that many independent logical units.

For v0.10.6 specifically, prefer a history around 30 meaningful commits if
the implementation naturally supports that level of decomposition.

Do not create artificial or microscopic commits merely to reach a number.

A commit must:
- implement or fix one coherent behavior
- include the tests that prove that behavior
- pass its targeted validation
- remain independently reviewable
- be independently revertible where practical

Never split:
- implementation from the tests required to prove it
- a type/schema change from the minimum code required to keep the tree valid
- two pieces that would leave either commit broken or meaningless

Never combine:
- unrelated architecture layers
- independent bug fixes
- security fixes with unrelated cleanup
- implementation and release metadata when they can stand alone

The target is not "30 commits."

The target is a history detailed enough that a future maintainer can use
`git log`, `git show`, `git revert`, and `git bisect` to understand exactly
how the feature evolved.

Do not push, tag, publish, or release unless explicitly requested.