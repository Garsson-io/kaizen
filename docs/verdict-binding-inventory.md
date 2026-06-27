# Verdict → Terminal-Action Binding Inventory (#1227)

**The category.** Kaizen *computes* quality verdicts well. The recurring failure
is that **no mechanism is required to honour a verdict at the irreversible
action.** At a point-of-no-return the system asks *"does an artifact exist?"*
instead of *"did the relevant verdict pass?"* — so a correct FAIL is computed,
logged, and then silently overruled by the absence of any consumer.

This is distinct from #943 (the gate *measures* the wrong thing — a
**measurement** error). Here the verdict is measured *correctly* and then
*nothing consumes it* at the action that matters — a **binding** error.

**The rule.** Every irreversible / finalizing action MUST mechanically consume
the relevant computed verdict and **fail closed**. A computed verdict with no
enforcing consumer at a terminal action is itself a defect.

The pinned, machine-checked version of this table is
[`src/verdict-binding-invariant.test.ts`](../src/verdict-binding-invariant.test.ts):
if a binding is removed, that test goes red.

## Inventory

| Terminal action | Verdict it must consume | Enforcing consumer | Fail-closed behaviour | Ticket |
|---|---|---|---|---|
| `gh pr merge` | latest stored review round verdict | `src/hooks/enforce-merge-verdict.ts` (PreToolUse Bash hook) | DENY merge when latest round derives FAIL (covers fix-loop-exhausted). Override: `KAIZEN_ALLOW_MERGE_FAIL=1` (explicit + logged). | #1220 |
| auto-dent run-success stamp | `review_verdict` / `process_verdict` / `lifecycle_health` | `deriveRunOutcome()` in `scripts/auto-dent-run.ts` | `review_verdict==fail` ∨ `process_verdict==process-incomplete` ∨ `lifecycle_health==critical` ⇒ `outcome=failure`, never `success`. | #1224 |
| store a PASS review summary | CI status for the reviewed head | `enforceCiProofForPass()` in `src/cli-structured-data.ts`, backed by `src/review-ci-proof.ts` | Wait for CI (poll). `pending` after timeout ⇒ exit 75 (`ci_pending`, NOT a review FAIL). Stale head / red CI ⇒ exit 1. PASS only when CI is green. | #1221, #1222, #1225 |
| store a review summary (storage layer) | (none — must stay side-effect-free) | `storeReviewSummary()` in `src/structured-data.ts` | No `gh`/`git` shell-outs in the storage primitive; the proof lives at the CLI boundary. | #1222 |

## Residual / tracked-elsewhere bindings

These are *known* terminal actions whose verdict binding is weaker than the
above and is tracked separately — listed here so they are not mistaken for
"covered":

| Terminal action | Verdict | Status |
|---|---|---|
| `gh pr merge` of a PR with **no** stored review | (review existence) | WARN only — categorically blocking unreviewed merges would over-block in host-project mode. Tracked by #843 (hook enforcement unverified in headless mode) / #1166 (Claude-only gates). |
| issue close (`Closes #N`) | I2 scope-match | L1 only (agent must remember). #1227 flags it as a binding gap. |
| post-merge completion / deployment verify | merged-state verdict | #86 / #1165. |

## Why a categorical test, not just three fixes

Fixing #1220 + #1224 + #1225 individually leaves the *next* terminal action
ungated. The invariant test turns the inventory into a forcing function: adding
a new finalizing action, or removing a binding, must keep this table — and the
test — honest. That is the compound interest (see the [Zen of Kaizen](../.agents/kaizen/zen.md):
*"an enforcement point is worth a thousand instructions"*).
