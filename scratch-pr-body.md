## Story

Once upon a time, #843/#1500 taught auto-dent to *prove* its hooks loaded: every run now carries a `hook_activation` verdict — `degraded` when a hook-expecting provider ran with the kaizen plugin absent, so review/dirty/stop gates never fired.

Every day, that verdict was computed, banner-printed, and shipped as a run metric. But nothing **bound** it to the irreversible step. PR #1498 (which closed #1220) built the authoritative merge-readiness primitive `decideAutoMergeSafety` and wired in review / process / lifecycle verdicts — yet it left `hook_activation` out of the decision entirely.

One day, the consequence was concrete: at `auto-dent-run.ts:2651` the merge decision was computed **without** `result.hookActivation`, and `AutoMergeSafetySignals` had no hook field. So an auto-dent kaizen PR from a degraded run — or one where **no `system.init` was ever observed** on a hook-expecting provider — still queued for auto-merge. A PR that was never gated by any kaizen enforcement could merge silently. That is the exact "computed-but-not-bound" failure class #1220 exists to close, and it is design points #2 (provider asymmetry) and #3 (no-init = not ready) of the ticket — the slice #1498 didn't ship.

Because of that, this PR **extends the existing primitive** (it does not add a 5th competing check). `decideAutoMergeSafety` now consumes `hookActivation` and `provider`, and refuses to call a PR merge-ready when:
- the verdict is `degraded` (kaizen hooks did not load), or
- no `system.init` was observed on a hook-expecting provider (absence-of-evidence ≠ ready).

Because of that, provider asymmetry is honored by **reusing** `providerClaimsHookSupport` (the #1500 SSOT, never re-derived): Codex — which has no Claude Code hook runtime — never blocks, because `degraded = providerClaimsHookSupport(provider) && !active` is already provider-correct by construction. Both hook checks are gated behind `reviewRequired`, so synthetic/test-task probe PRs (the established exception) are unaffected.

Until finally, the merge choke point in `main()` passes `result.hookActivation` and `state.provider ?? 'claude'` into the decision — defaulting a missing provider to the hook-expecting `claude` so legacy state fails **closed**.

And ever since, the harness consumes one authoritative merge-readiness decision that reads review, process, lifecycle **and** hook-activation evidence from a single typed source — instead of leaving the enforcement payoff of #843/#1500 detached from the action it was built to gate.

Closes Garsson-io/kaizen#1220
Related: Garsson-io/kaizen#843, Garsson-io/kaizen#1500, Garsson-io/kaizen#1501

## Why this is the *completion* of #1220, not a duplicate

#1220 was reopened because PR #1498 was a **partial acceptance**: it shipped the primitive and the review/process/lifecycle binding, but the issue's own design points #2 and #3 (provider-aware hook-degradation binding, and "no init = not ready") were never wired in. This PR delivers exactly that residual slice and nothing more — batch-tier metric consumption and the init-event-seen assertion remain #1501 (out of scope); root-causing the ~24% `plugins:[]` flakiness remains #842 (out of scope).

## Design decisions

| Decision | Why | Tradeoff |
|---|---|---|
| Extend `decideAutoMergeSafety` instead of adding a new check | One authoritative merge-readiness decision; no drift between competing gates | The hook rule lives next to review/process/lifecycle rather than in a hook-specific module |
| Reuse `providerClaimsHookSupport` for the absent-verdict case | The #1500 SSOT already encodes provider asymmetry; re-deriving it would drift | Adds an import edge from merge-policy → hook-activation (no cycle) |
| Gate hook checks behind `reviewRequired` | Honors the enumerated synthetic/test-task exception; adds zero new false positives | A degraded *test-task* probe PR is not blocked on hook grounds (it is synthetic by definition) |
| Default missing `provider` to `claude` at the call site | Legacy state with no provider field must fail **closed**, not open | Treats unknown-provider runs as hook-expecting |
| Direct `gh pr merge` hook (`enforce-merge-verdict.ts`) stays review-only | `hook_activation` is a run-level signal not reconstructable from a bare PR number — and a degraded session could not run that PreToolUse hook anyway | The hook-activation binding is harness-tier only; the direct-merge L2 path covers the review verdict |

## What's in this PR

| File | Purpose |
|---|---|
| `scripts/auto-dent-merge-policy.ts` | `AutoMergeSafetySignals` gains `hookActivation` + `provider`; `autoMergeBlockReasons` blocks on degraded / no-init-on-hook-expecting-provider |
| `scripts/auto-dent-run.ts` | Call site passes `result.hookActivation` + `state.provider ?? 'claude'` into the decision |
| `scripts/auto-dent-merge-policy.test.ts` | Real-fixture fail-closed matrix (hook state × provider × reviewRequired × prCount) proving the gate BLOCKS |
| `scripts/auto-dent-run.test.ts` | `stream → verdict → gate` integration via `processStreamMessage`; source-invariant guard on the call-site wiring |

## Test plan (behaviors × levels)

| Behavior | Unit | Integration | Source-invariant |
|---|---|---|---|
| Degraded claude PR is blocked | ✅ real-fixture | ✅ stream→gate | — |
| No `system.init` on claude is blocked (unknown ≠ ready) | ✅ | — | — |
| Codex (no hook runtime) is never blocked | ✅ | ✅ stream→gate | — |
| Active kaizen plugin → allowed (no new block) | ✅ regression | — | — |
| Synthetic/test-task run not blocked on hook grounds | ✅ | — | — |
| Non-PR run not blocked | ✅ | — | — |
| Both review-fail and hook reasons surface together | ✅ | — | — |
| Call site binds the hook signal + fail-closed provider default | — | — | ✅ |

## Validation

- [x] `npx vitest run scripts/auto-dent-merge-policy.test.ts scripts/auto-dent-run.test.ts` — 339 passed.
- [x] `npx vitest run scripts` — 56 files, 1650 passed, 2 skipped.
- [x] `npm run typecheck` — passed (no import cycle: merge-policy → hook-activation is one-directional).
- [x] `git diff --check` — clean.
- [x] Plan + substantive test plan stored on #1220 before any source edit (I3/I8).

## I23 note

This change touches **no hook scripts and no skills** — only `scripts/auto-dent-*.ts`. The hook E2E suite against `kaizen-test-fixture` is therefore not triggered. The hook-activation *binding* is exercised by the `stream → verdict → gate` integration test instead.
