# Workflow Gate Ledger

The workflow gate ledger is the source of truth for auto-dent and manual kaizen workflow evidence. It replaces competing gate lists in lifecycle validation, workflow status, batch reporting, merge readiness, and repair prompting.

## Canonical Gates

Gate ids live in `scripts/workflow-gate-ledger.ts` as `CANONICAL_WORKFLOW_GATES`.

Current gates:

- `ticket-identity`
- `plan-testplan`
- `worktree-case`
- `implementation-tests`
- `dry-refactor`
- `context-delegation`
- `meet-reality`
- `review-requirements-impact`
- `reflection`
- `pr-ci-merge-cleanup`
- `hook-provider-activation`

Every gate has a stable id, label, lifecycle state, evidence items, validation result, and repair instruction.

## Adding A Gate

1. Add the gate to `CANONICAL_WORKFLOW_GATES`.
2. Add or update evidence normalization in `scripts/workflow-gate-ledger.ts`.
3. Add a test that fails if the gate is missing from status, batch summary, merge policy, or repair prompt coverage.
4. Update producer code to emit schema-valid evidence. Do not create a new ad hoc boolean, marker, or progress row as the authoritative source.
5. Update operator-facing docs only after the gate is consumed by at least one enforcement or reporting surface.

The invariant test in `scripts/workflow-gate-ledger.test.ts` is the drift guard. If a gate appears in the schema but not a consumer projection, the PR is incomplete.

## Adding A Producer

A producer can be a hook, phase marker normalizer, final claim parser, review result, test runner, status CLI, or external provider evidence path. Producers must emit `WorkflowEvidenceItem` data through `workflowEvidence()`.

Required evidence fields:

- `schemaVersion`
- `gateId`
- `evidenceType`
- `producer`
- `timestamp`
- `runId` when available
- `source` path or URL when available
- `payload`

Worker final claims are not authoritative evidence. They are diagnostic inputs compared against durable evidence. A claim that says review or tests passed does not pass a gate unless the corresponding review or test artifact exists.

## Compatibility Inputs

`AUTO_DENT_PHASE` markers remain compatibility input only. They normalize into ledger evidence when the marker is schema-valid enough to prove the claim. Malformed markers, such as `AUTO_DENT_PHASE: TEST | 19 passed`, become invalid evidence with a repair instruction.

Hook output remains useful because it is close to the enforcement point, but hook output is a producer of ledger evidence, not a separate gate language.

`scripts/auto-dent-context-delegation.ts` is the context-delegation pressure producer. It mines run logs for transcript taxonomy signals (`context_growth`, `missing_subagent`), high main-thread discovery/tool-call volume, and observed subagent tool use. Observed delegation normalizes to `AUTO_DENT_PHASE: DELEGATE`; threshold pressure without delegation remains a `context-delegation` repair, not a new gate.

## Repair Loop

When a PR-producing run has missing, invalid, stale, or contradictory gate evidence, the ledger produces a targeted repair request for that same PR. Repair requests identify the run, issue, PR, branch, missing gates, invalid gates, and the exact evidence to fill.

Repair attempts must stop only at:

- `merge_ready`
- `blocked_with_reason`
- `repair_budget_exhausted`

Repair should fill evidence before touching code. Restarting unrelated implementation is the wrong response to an evidence-incomplete PR.
