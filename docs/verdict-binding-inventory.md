# Verdict Binding Inventory

Kaizen verdicts are only useful when terminal actions must consume them. This
inventory maps every computed verdict in the #1227 category to the irreversible
action that enforces it.

The table below is generated from `src/verdict-binding-inventory.ts`; keep the
TypeScript inventory as the source of truth.

| Terminal action | Computed verdicts consumed | Enforcing consumer | Failure mode blocked |
|---|---|---|---|
| Run-success stamp | Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict | deriveRunOutcome() consumes hasHardQualityFailure() before success is stamped | A run with review FAIL, process-incomplete, or critical lifecycle gaps cannot be recorded as success. |
| Issue close | PR merge-state verdict<br>Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict | verifyIssuesClosed()/autoCloseKaizenIssues() require merged PR state and route closure through the configured issues repo; merge itself is gated by quality verdicts | Issue closure only follows a merged PR, auto-merge is denied when quality verdicts are red, and host-mode closures cannot silently target the kaizen repo. |
| Batch finalize | Batch outcome schema verdict<br>PR merge-state verdict | closeBatchProgressIssue() reconciles merged PR outcomes, then buildBatchOutcome()/BatchOutcomeSchema validate the durable record | Final batch metrics do not rely only on scraped narration; malformed outcome records are rejected on read. |
| Gate clear | Reflection issue-ref verification verdict | processHookInput() validates filed/incident refs before clearing the gate state | A fabricated filed issue/incident ref cannot clear the reflection gate. |
| Merge | Stored review round verdict<br>Auto-dent review/fix-loop verdict<br>Durable process-evidence verdict<br>Lifecycle health verdict | enforce-merge-verdict blocks direct FAIL merges; decideAutoMergeSafety blocks unsafe auto-merge queueing | A PR with FAIL review/process/lifecycle verdicts cannot be merged or queued by the normal paths. |

## Detector

`findInventoryViolations()` fails when:

- a required terminal action is missing from the inventory
- a terminal action consumes no computed verdict
- a terminal-critical computed verdict has no enforcing terminal consumer
- source evidence tokens disappear from the files that are supposed to enforce a binding

That detector is covered by `src/verdict-binding-inventory.test.ts`, including a
negative test with an intentionally unbound verdict.
