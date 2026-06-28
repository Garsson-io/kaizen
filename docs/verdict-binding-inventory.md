# Verdict Binding Inventory

Kaizen verdicts are only useful when terminal actions must consume them. This
inventory maps every computed verdict in the #1227 category to its source
producer and to the irreversible action that enforces it.

The table below is generated from `src/verdict-binding-inventory.ts`; keep the
TypeScript inventory as the source of truth.

| Computed verdict | Producer | Producer signatures | Terminal-critical |
|---|---|---|---|
| Stored review round verdict | src/structured-data.ts: deriveStoredRoundVerdict() from per-dimension findings | src/review-finding-contract.ts:type:RoundVerdict<br>src/structured-data.ts:function:deriveStoredRoundVerdict<br>src/structured-data.ts:field:round_verdict | yes |
| Auto-dent review/fix-loop verdict | scripts/auto-dent-run.ts: runReviewWiring() records pass/fail/skipped | scripts/auto-dent-events.ts:field:review_verdict<br>scripts/auto-dent-run.ts:field:review_verdict | yes |
| Durable process-evidence verdict | scripts/auto-dent-lifecycle.ts: validateProcessEvidence() | scripts/auto-dent-events.ts:field:process_verdict<br>scripts/auto-dent-lifecycle.ts:function:validateProcessEvidence<br>scripts/auto-dent-lifecycle.ts:type:ProcessVerdict<br>scripts/auto-dent-run.ts:field:process_verdict | yes |
| Lifecycle health verdict | scripts/auto-dent-lifecycle.ts: validateRunLifecycle() | scripts/auto-dent-lifecycle.ts:function:validateRunLifecycle | yes |
| PR merge-state verdict | scripts/auto-dent-github.ts: classifyMergeView() / checkMergeStatus() | scripts/auto-dent-github.ts:function:checkMergeStatus<br>scripts/auto-dent-github.ts:function:classifyMergeView | yes |
| Reflection issue-ref verification verdict | src/hooks/lib/issue-ref-verifier.ts: verifyIssueRef() | src/hooks/lib/issue-ref-verifier.ts:function:verifyIssueRef | yes |
| Batch outcome schema verdict | scripts/batch-outcome.ts: BatchOutcomeSchema.parse() | scripts/batch-outcome.ts:const:BatchOutcomeSchema | yes |
| Hook-activation verdict | scripts/auto-dent-hook-activation.ts: evaluateHookActivation() from the session system.init event | scripts/auto-dent-hook-activation.ts:function:evaluateHookActivation<br>scripts/auto-dent-hook-activation.ts:interface:HookActivationVerdict | yes |
| Test-health verdict | src/known-failures.ts: unownedFailures() over the known-failures registry, surfaced as the testHealth signal (#1481/#1518) | src/known-failures.ts:function:unownedFailures<br>scripts/known-failures-status.ts:function:runClassify | yes |

| Terminal action | Computed verdicts consumed | Enforcing consumer | Failure mode blocked |
|---|---|---|---|
| Run-success stamp | Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict | deriveRunOutcome() consumes hasHardQualityFailure() before success is stamped | A run with review FAIL, process-incomplete, or critical lifecycle gaps cannot be recorded as success. |
| Issue close | PR merge-state verdict<br>Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict | verifyIssuesClosed()/autoCloseKaizenIssues() require merged PR state and route closure through the configured issues repo; merge itself is gated by quality verdicts | Issue closure only follows a merged PR, auto-merge is denied when quality verdicts are red, and host-mode closures cannot silently target the kaizen repo. |
| Batch finalize | Batch outcome schema verdict<br>PR merge-state verdict | closeBatchProgressIssue() reconciles merged PR outcomes, then buildBatchOutcome()/BatchOutcomeSchema validate the durable record | Final batch metrics do not rely only on scraped narration; malformed outcome records are rejected on read. |
| Gate clear | Reflection issue-ref verification verdict | processHookInput() validates filed/incident refs before clearing the gate state | A fabricated filed issue/incident ref cannot clear the reflection gate. |
| Merge | Stored review round verdict<br>Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict<br>Hook-activation verdict<br>Test-health verdict | enforce-merge-verdict blocks direct FAIL merges; decideAutoMergeSafety blocks unsafe auto-merge queueing, including degraded/unknown hook-activation (#1220) and unowned test failures (#1518) | A PR with FAIL review/process/lifecycle verdicts — a degraded run where kaizen hooks did not load (or no system.init was seen on a hook-expecting provider) — or a run that observed a failing test owned by no open issue — cannot be merged or queued by the normal paths. |

## Detector

`findInventoryViolations()` fails when:

- a source verdict producer signature is not classified in the inventory
- a computed verdict has no producer source evidence
- a required terminal action is missing from the inventory
- a terminal action consumes no computed verdict
- a terminal-critical computed verdict has no enforcing terminal consumer
- source evidence tokens disappear from the files that are supposed to produce or enforce a binding

That detector is covered by `src/verdict-binding-inventory.test.ts`, including a
negative test with an intentionally unbound verdict and a producer-boundary test
with an intentionally unclassified source signature.
