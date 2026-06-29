# Review Round CLI

`scripts/review-round.ts` is the operator boundary for focused authoritative
review rounds. Use it when a PR needs selected dimensions rerun and stored
without entering the full `review-fix` repair loop.

## When To Use It

- A PR already has a review round, but only a few dimensions need rerun after a
  narrow push.
- A provider run failed or timed out and the operator needs a durable artifact
  before deciding what to retry.
- The review verdict gate needs authoritative `review/rN/<dimension>` findings
  plus `review/rN/summary`, but the caller should not hand-build JSON payloads.

Use `scripts/review-fix.ts` instead when the desired workflow is review, spawn a
repair session, resume, and re-review.

## Commands

```bash
npx tsx scripts/review-round.ts run \
  --pr 1739 --issue 1736 --repo Garsson-io/kaizen \
  --dimensions security,test-quality \
  --provider codex \
  --timeout 360s \
  --out logs/review/pr-1739-r1.json
```

`run` prefetches the issue, PR body, PR diff, stored plan, and stored test plan,
then calls `reviewBattery()`. It always writes a JSON artifact. If `--out` is
omitted, the default path is `logs/review/pr-<N>-<timestamp>.json`.

```bash
npx tsx scripts/review-round.ts store \
  --file logs/review/pr-1739-r1.json \
  --round 1 \
  --rerun-gate
```

`store` validates the artifact before any GitHub writes. It refuses artifacts
with provider-failed dimensions, MISSING findings, invalid finding payloads, or
missing requested dimensions. A successful store uses `storeReviewBatch()`,
writes the review sentinel through the existing structured-data CLI helper, and
optionally reruns the Review verdict gate.

```bash
npx tsx scripts/review-round.ts run-and-store \
  --pr 1739 --issue 1736 --repo Garsson-io/kaizen \
  --group diff,tests \
  --store-only-if-pass \
  --rerun-gate
```

`run-and-store` is intentionally guarded by `--store-only-if-pass`; combined
storage without the explicit fail-closed guard is rejected.

## Dimension Selection

- `--dimensions a,b,c`: exact dimension list.
- `--all-pr`: all PR-applicable dimensions from `reviewBattery`.
- `--group diff,tests`: common operator groups.

Supported groups:

| Group | Meaning |
|---|---|
| `diff` | PR dimensions that only need the diff |
| `issue` | issue/diff dimensions without plan or test needs |
| `plan` | dimensions that need the stored plan |
| `tests` | dimensions that need test context |
| `description` | PR-description review |
| `skills` | skill/prompt-change review |
| `all-pr` | all PR-applicable dimensions |

## Artifact Lifecycle

Artifacts under `logs/review/` are local run evidence and are ignored by git.
They are durable for the current worktree/run, but they are not the final
authoritative record. Once an artifact is inspected and passes the store guard,
`store` promotes its findings into GitHub review attachments:

- `review/rN/<dimension>`
- `review/rN/summary`
- `review/active-round`
- local review sentinel for the hook gate

If the artifact is useful review evidence for humans, attach or quote the
relevant excerpt in the PR body or a PR comment before cleaning up the worktree.

## Recovery Output

After `run`, the CLI prints per-dimension status and a copy-pasteable next
command:

- failed provider or MISSING dimensions -> rerun command with `--dimensions`
- passable artifact -> store command for the generated artifact path

That output is the intended handoff between a noisy provider run and the
authoritative storage step.
