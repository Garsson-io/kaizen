# Auto-Dent Operations Guide

The auto-dent system is kaizen's autonomous batch runner. It picks issues from the backlog, delegates to `/kaizen-deep-dive` agents, tracks artifacts, and provides real-time observability. This document covers how to run, monitor, debug, and extend the system.

## Architecture

```
auto-dent.sh (compatibility wrapper)
  │
  └── auto-dent.ts (TypeScript batch runner)
        ├── pulls main between runs (self-update + outer-loop hot reload)
        ├── manages state.json (cross-run persistence)
        ├── enforces stop conditions (max runs, consecutive failures, halt file)
        └── auto-dent-run.ts (single-run TypeScript runner)
              ├── builds prompt from templates (prompts/*.md)
              ├── spawns the selected provider (Claude stream-json or Codex JSONL)
              ├── parses real-time milestones (PRs, issues, costs)
              ├── posts per-run comments to batch progress issue
              ├── queues or blocks auto-merge based on review/process verdicts
              └── writes results back to state.json

auto-dent-ctl.ts (control plane)
  ├── status  — show active/completed batches
  └── halt    — stop a batch or all batches

auto-dent-score.ts (scoring)
  └── per-run and per-batch quality scoring

kaizen-workflow-driver.ts (workflow forcing/status)
  ├── renders the headless /goal-equivalent contract into every run prompt
  └── reports reusable workflow stage status for skills, /goal, and auto-dent
```

### Self-Update And Hot Reload

The batch runner (`auto-dent.ts`) runs `git pull --ff-only origin main` before each run. It invokes `auto-dent-run.ts` from the main checkout on every iteration, so merged PRs that improve the single-run runner take effect on the next run.

When the successful pull changes an outer-harness contract file, the current outer process starts a replacement process:

```bash
npx tsx scripts/auto-dent.ts --resume logs/auto-dent/<batch-id>/state.json
```

The old process exits before cleanup, reflection, the next run, or final batch summary. The resumed process reads the same durable `state.json`, keeps the same halt file and progress issue, and continues with the current run count, budget, failure, and cooldown state. `auto-dent.sh` remains only as the stable operator entrypoint.

The source of truth for reload-critical files is `OUTER_HARNESS_RELOAD_PATHS` in `scripts/auto-dent.ts`. When batch control, state persistence, command routing, progress/finalization, summary, or artifact logic moves into a new support file, add that file to the registry and cover it in `scripts/auto-dent.test.ts`.

### Cross-Run State

All cross-run state lives in `logs/auto-dent/<batch-id>/state.json`. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `batch_id` | string | Unique ID: `batch-YYMMDD-HHMM-XXXX` |
| `guidance` | string | Human-provided guidance prompt |
| `run` | number | Current run number (0-indexed before first run) |
| `prs` | string[] | All PR URLs created across all runs |
| `issues_filed` | string[] | Issues filed by agents |
| `issues_closed` | string[] | Issues closed by merged PRs |
| `consecutive_failures` | number | Resets to 0 on any successful run |
| `stop_reason` | string | Why the batch stopped (empty while running) |
| `progress_issue` | string | GitHub issue URL for batch progress tracking |
| `run_history` | RunMetrics[] | Per-run duration, cost, tool calls, exit code |
| `cost_integrity_warnings` | string[] per run | Data-integrity warnings for cost attribution, such as timeout kills that leave a tool-using run at `$0.00` |
| `review_verdict` | `"pass"\|"fail"\|"error"\|"skipped"` per run | Requirements review verdict for the PR produced by this run; `"fail"` blocks auto-merge |
| `review_cost_usd` | number per run | Cost of the requirements review for this run (typically $0.10–0.20) |

### Prompt Templates

Templates live in `prompts/`. The default is `deep-dive-default.md`. Variables are substituted using `{{variable}}` syntax, with `{{#var}}...{{/var}}` for conditionals.

Key variables: `{{guidance}}`, `{{run_tag}}`, `{{run_context}}`, `{{issues_closed}}`, `{{prs}}`, `{{host_repo}}`, `{{goal_forcing_contract}}`.

`{{goal_forcing_contract}}` comes from `scripts/kaizen-workflow-driver.ts`. It is the headless equivalent of `/goal`: a run should not finish while applicable kaizen gates remain pending. Keep lifecycle gate wording there instead of copying checklists into individual prompt templates.

Context-heavy work is delegated by default through that same contract. The exact fan-out policy is rendered by `renderContextDelegationPolicy()` from `DEFAULT_CONTEXT_DELEGATION_SUBSTEPS` in `scripts/auto-dent-context-delegation.ts`; keep the sub-step list there. The same helper mines run logs for context pressure (`context_growth`, `missing_subagent`, high main-thread discovery/tool-call volume) and observed subagent tool use. Observed delegation becomes a `DELEGATE` progress row; threshold-crossing PR runs without delegation repair the existing `context-delegation` gate.

Status for a run or issue uses the same shared model:

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --mode exploit --issue <N> --repo <owner/repo>
```

When the run has gate evidence that cannot be inferred from git/GitHub state,
pass it as stage evidence flags instead of creating a separate checklist:

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --mode exploit --issue <N> --repo <owner/repo> \
  --review "done: review verdict passed" \
  --meet-reality "done: rendered prompt inspected"
```

## Running a Batch

### Basic usage

```bash
./scripts/auto-dent.sh "focus on hooks reliability"
```

### Common options

```bash
# Limit to 5 runs with $5 budget per run
./scripts/auto-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"

# Quick test with synthetic task (no real work)
./scripts/auto-dent.sh --test-task --max-runs 1

# Enable experiment diagnostics (shows git HEAD changes, PR merge status)
./scripts/auto-dent.sh --experiment "fix area/skills issues"

# Preview without executing
./scripts/auto-dent.sh --dry-run "focus on observability"

# Run with Codex subscription CLI instead of Claude
./scripts/auto-dent.sh --provider codex "focus on provider-safe fixes"

# Custom timeout (default 45min per run)
./scripts/auto-dent.sh --max-run-seconds 1800 "simple fixes only"
```

### All flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-runs N` | unlimited | Stop after N runs |
| `--cooldown N` | 30s | Seconds between runs |
| `--budget N.NN` | none | Per-run budget. Claude receives `--max-budget-usd`; Codex is bounded by run timeout and batch budget accounting. |
| `--max-budget N.NN` | none | Total batch budget — halts when cumulative cost exceeds |
| `--max-failures N` | 3 | Stop after N consecutive failures |
| `--max-run-seconds N` | 1200 (20min) | Wall-time timeout per run |
| `--provider claude\|codex` | claude | Agent provider; Codex uses subscription CLI JSONL output |
| `--dry-run` | off | Show what would run |
| `--test-task` | off | Use synthetic fast task |
| `--experiment` | off | Enable extra pipeline diagnostics |
| `--resume FILE` | off | Resume an existing batch from `state.json`; normally used by the self-update handoff |

### Provider smoke tests

Fast CI uses mocked subprocesses and synthetic Codex JSONL. To check the real
provider CLI boundary before a provider-runtime release, run the gated live
smoke for the provider you are changing:

```bash
LIVE_PROBE=1 npm test -- --run scripts/auto-dent-harness.test.ts
LIVE_PROBE_CODEX=1 npm test -- --run scripts/auto-dent-harness.test.ts
```

The live probe returns the raw provider log path in assertion failures so a
failed smoke can be replayed or attached without rerunning the provider call.

## Monitoring a Running Batch

### From the same terminal

The trampoline prints real-time progress after each run:
```
━━━ Batch Progress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Runs: 5/10 completed | 0 consecutive failures
  PRs:  3 created | Issues: 2 closed
  Time: 1h 23m elapsed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

During a run the live console is **decision-led, not tool-call-led** (#1492). Every
text source — assistant prose, tool results, and the final result — flows through one
ingestion pipeline (`ingestRunText` in `auto-dent-stream.ts`), so parsed phase markers
(`◉ [PICK] #1365 — …`, `[IMPLEMENT]`, `[STOP]`, …) print to the console regardless of
whether the agent narrated them or `echo`ed them to stdout. Markers are deduplicated, so
a decision echoed through several stream messages prints once. Control signals (stop,
contemplation recs) are honored only from agent-authoritative text — never from tool
output — so a `cat` of a file containing a literal `AUTO_DENT_PHASE: STOP` cannot halt
the batch. A GitHub branch-push helper URL (`pull/new/…`, `compare/…`) renders as a
distinct `◉ [PUSH] branch pushed — PR pending` line and a `PR | branch-pushed` work-cycle
row, so a pushed branch is never misread as a real PR (a later `/pull/<N>` supersedes it).

### From another terminal

```bash
# Show all batches (active and completed)
./scripts/auto-dent.sh --status

# Or directly:
npx tsx scripts/auto-dent-ctl.ts status
```

### Cross-PR DRY sweep

Use the dry-sweep control command when a batch has accumulated several adjacent
Auto-Dent PRs and you want cleanup candidates before adding more mechanisms:

```bash
npx tsx scripts/auto-dent-ctl.ts dry-sweep --repo Garsson-io/kaizen --limit 20
```

The report scans production `scripts/` and `src/` code for known drift families
such as GitHub execution wrappers, direct progress comments versus marker
attachments, telemetry envelopes, display formatting, and markdown table helpers.
When `--repo` is provided it also annotates candidates with recent merged PRs
whose changed files overlap the candidate files.

To persist the result on a batch progress issue as an idempotent marker-comment
attachment:

```bash
npx tsx scripts/auto-dent-ctl.ts dry-sweep --repo Garsson-io/kaizen --post <progress-issue>
```

`auto-dent-ctl.ts reflect` runs the same sweep on its normal cadence and surfaces
the candidate count in reflection insights. Treat those insights as advisory
steering: convert high-confidence findings into small cleanup issues or PRs
before adding another parallel mechanism.

### From GitHub

Each batch creates a progress issue (labeled `auto-dent`). Per-run results are posted as comments with PRs created, issues filed, and run metrics.

### Logs

The planning pre-pass writes raw provider output under a private
`planning-<provider>-*` subdirectory before `plan.json` exists:

| File | Provider | Purpose |
|------|----------|---------|
| `planning-codex-*/plan-codex.jsonl` | Codex | Raw JSONL from `codex exec` during planning. Use this when the terminal says planning is still reading issues/files or when plan extraction fails. |
| `planning-claude-*/plan-claude-stream.jsonl` | Claude | Raw `stream-json` output from Claude planning. Use this to audit issue reads, file inspection, and final plan text. |
| `plan-output.schema.json` | Codex | JSON schema passed to Codex for constrained planning output. |
| `plan.json` | all | Normalized ranked plan consumed by the batch loop after planning succeeds. |

The terminal prints bounded planning progress while these files grow. Treat the
raw files as forensic artifacts; do not paste them into the terminal unless you
are debugging parser behavior.

All logs go to `logs/auto-dent/<batch-id>/`:
- `state.json` — live batch state (updated after each run)
- `run-N.log` — raw provider output and harness diagnostics for run N
- `batch-summary.txt` — machine-readable summary (written at batch end)

## Stopping a Batch

### From the same terminal
`Ctrl+C` — signals graceful shutdown. Finishes the current run, writes the summary, then exits.

### From another terminal
```bash
# Halt all active batches
./scripts/auto-dent.sh --halt

# Halt a specific batch
./scripts/auto-dent.sh --halt batch-260323-0003-072b
```

This creates a `HALT` file in the batch log directory. The trampoline checks for this file between runs and during cooldown (every 3s).

### Agent-initiated stop
The agent inside a run can stop the batch by emitting:
```
AUTO_DENT_PHASE: STOP | reason=backlog exhausted
```
The runner parses this from the stream-json output and sets `stop_reason` in state.

### Automatic stop conditions
- **Max runs reached** — `--max-runs N`
- **Consecutive failures** — 3 (default) consecutive non-zero exit codes
- **Fast-fail cooldown** — runs completing in <60s with no output trigger escalating cooldown (30s → 60s → 120s → 240s → stop)

## Debugging a Failed Batch

### 1. Check the summary
```bash
cat logs/auto-dent/<batch-id>/batch-summary.txt
```

### 2. Check state for stop reason
```bash
jq '.stop_reason, .consecutive_failures' logs/auto-dent/<batch-id>/state.json
```

### 3. Check per-run metrics
```bash
jq '.run_history[] | {run, exit_code, duration_seconds, cost_usd, prs}' logs/auto-dent/<batch-id>/state.json
```

### 3b. Check review verdict distribution
```bash
jq '.run_history[] | {run, review_verdict, review_cost_usd}' logs/auto-dent/<batch-id>/state.json
```

`review_verdict="fail"` blocks auto-merge for the run's PRs and disables any existing auto-merge request. A high fail rate (>30% across a batch) still signals that PRs are closing issues in name only. Investigate the specific runs where verdict is `"fail"` to find systemic gaps.

If `review_verdict` is `"error"` or `"skipped"`, the review could not complete (rate limit, timeout, or no PR in that run). These are expected for runs that produce no PR. For PR-producing normal runs, skipped or missing required review also blocks auto-merge.

### 4. Read the failing run's log
```bash
# Find which run failed
jq '.run_history[] | select(.exit_code != 0) | .run' logs/auto-dent/<batch-id>/state.json

# Read its log
less logs/auto-dent/<batch-id>/run-N.log
```

### Common failure patterns

| Pattern | Symptom | Cause | Fix |
|---------|---------|-------|-----|
| Tight loop | Runs complete in <60s, cooldown escalates | Agent can't find work / bad guidance | Adjust guidance, check backlog |
| Same issue retry | Consecutive failures on same issue | Issue is blocked or broken | Add to exclusion list |
| OOM / timeout | Run exits with signal 9 or timeout | Agent spawned heavy subprocess | Check for vitest/tsc in hooks (#474) |
| Hook deadlock | Run hangs indefinitely | Merge conflict markers in hooks | Check `.claude/hooks/` for conflict markers |
| Auto-merge blocked | PRs created but not merged | Review/process/lifecycle verdict did not pass | Fix findings, re-run review, or use explicit human override |
| Auto-merge failure | PRs created but not merged | Branch protection rules or failed `gh pr merge --auto/--disable-auto` | Check repo settings, CI status, and `auto_merge_*_failed` log lines |

## Post-Batch Hygiene

After a batch completes:

1. **PRs** — The harness queues auto-merge only after the review/process/lifecycle gates allow it. Check for any stuck or blocked PRs:
   ```bash
   gh pr list --repo Garsson-io/kaizen --label auto-dent --state open
   ```

   Repositories that want a non-Claude backstop should mark the GitHub Actions
   check `Review verdict gate / Review verdict gate` as required in branch
   protection. That check reads the same stored review verdict as the merge hook
   and fails when the latest round derives `FAIL`.

2. **Worktrees** — Runs create worktrees that should be cleaned up on merge. Check for stale ones:
   ```bash
   git worktree list
   ```

3. **Batch progress issue** — Auto-closed by the harness. Verify:
   ```bash
   jq '.progress_issue' logs/auto-dent/<batch-id>/state.json
   ```

   At close the harness writes durable attachments on the progress issue
   (both idempotent marker comments — re-running finalize edits in place):
   - anomaly incident links (`scripts/auto-dent-anomaly-incidents.ts`) — when a
     run has failed, `empty_success`, hook rejection, critical lifecycle gaps,
     more than 3 PRs, or 2x cost/duration outliers, the harness searches
     for an existing matching issue and files one if absent. The batch completion
     attachment lists created/reused refs under `### Anomaly Incidents`. Filing is
     best-effort and fail-open; a GitHub outage must not block batch close.
   - `batch-outcome` (`scripts/batch-outcome.ts`) — schema-validated summary for
     cross-batch learning (#1108, #940).
   - `rsi-improvement-proposals` (`scripts/auto-dent-rsi.ts`) — bounded RSI
     proposal set built from reflection/degradation signals. Each proposal names
     the target prompt/skill/process surface, behavioral proof requirements,
     baseline metrics, a cross-run improvement verdict, and accept/reject
     criteria for later batch outcomes (#1158). Inspect it with:
     ```bash
     npx tsx scripts/auto-dent-rsi.ts summary --issue <progress-issue> \
       --repo Garsson-io/kaizen
     ```

     To close the loop after applying one proposal, evaluate the next
     `batch-outcome` against the stored baseline:
     ```bash
     npx tsx scripts/auto-dent-rsi.ts evaluate \
       --file rsi-improvement-proposals.json \
       --after-outcome-file next-batch-outcome.json
     ```

     The `summary` command can read directly from GitHub (`--issue/--repo`) or
     from a saved JSON file (`--file`). The evaluator intentionally reads files
     so review evidence can pin the exact before/after artifacts used.
   - `batch-artifacts` (`scripts/batch-artifacts-upload.ts`) — the RAW forensic
     dump: `events.jsonl` + `state.json` inlined, size-capped to GitHub's 65,536-char
     comment limit, truncated head+tail with a pointer to the on-disk copy when a
     large batch overflows (#696, epic #842). Read it from the cloud with:
     ```bash
     npx tsx src/cli-section-editor.ts read-attachment --issue <progress-issue> \
       --repo Garsson-io/kaizen --name batch-artifacts
     ```

   Full `run-*.log` transcript bundles are intentionally not carried by the
   capped `batch-artifacts` comment. The cloud transport decision for compressed
   transcript logs is documented in
   [`docs/auto-dent-transcript-transport.md`](auto-dent-transcript-transport.md);
   that contract uses GitHub Actions artifacts for the complete scrubbed bundle
   and keeps the progress issue as a small manifest/index.

   The read-only dashboard data contract over these progress issue artifacts is
   documented in
   [`docs/auto-dent-dashboard-data-contract.md`](auto-dent-dashboard-data-contract.md).
   Dashboard UI code must consume that typed projection instead of scraping local
   logs or inventing a second lifecycle model.

4. **OpenTelemetry GenAI traces** — JSONL remains the durable source of truth.
   To mirror completed runs to an OTLP/GenAI-compatible HTTP collector, set:
   ```bash
   KAIZEN_OTEL_ENDPOINT=https://otel.example/v1/traces
   ```
   Export is best-effort and fail-open: a collector outage must not block the
   auto-dent run or prevent `events.jsonl` from being written.
   The platform decision and live-smoke boundary are documented in
   [`docs/auto-dent-trace-platform-evaluation.md`](auto-dent-trace-platform-evaluation.md):
   use the existing `scripts/auto-dent-otel.ts` projection first, try an OTLP
   trace UI such as Langfuse before adding vendor-specific converters, and keep
   complete transcript bundles on the transcript artifact transport rather than
   raw trace span attributes.

## Scoring

The `auto-dent-score.ts` module scores run quality. Per-run scores consider:
- PRs created (higher = better)
- Issues filed/closed
- Cost efficiency (value per dollar)
- Exit code (non-zero penalized)

Batch scores aggregate per-run scores with a post-hoc analysis that checks actual merge status of PRs.

## Provider Comparison Matrix

Use the deterministic provider matrix when comparing Claude, Codex, and hybrid
auto-dent strategies without invoking provider CLIs or API-token billing:

```bash
npx tsx scripts/auto-dent-provider-matrix.ts --dry-run
npx tsx scripts/auto-dent-provider-matrix.ts --write logs/auto-dent/<batch-id>
npx tsx scripts/auto-dent-provider-matrix.ts --report logs/auto-dent/<batch-id>/provider-comparison.json
```

The artifact records phase-level provider/billing choices, process verdicts,
failure classes, review quality, cost-signal availability, hook rejections, and
operator inspectability, then recommends a default strategy for the next stage.

## Extending the System

### Adding a new prompt template
Create `prompts/my-template.md` with `{{variable}}` placeholders. Template selection is currently hardcoded (`deep-dive-default.md`) — changing it requires modifying `auto-dent-run.ts`.

### Adding new state fields
1. Add the field to `BatchState` interface in `auto-dent-run.ts`
2. Initialize it in `auto-dent.ts` state creation
3. Update it in the appropriate phase of `auto-dent-run.ts`

### Adding new stop conditions
Add to the batch loop in `auto-dent.ts` (between runs) or to `auto-dent-run.ts` (during a run, via stream-json parsing).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/auto-dent.sh` | Compatibility wrapper for the TS batch runner |
| `scripts/auto-dent.ts` | TypeScript batch runner (outer loop, self-update, stop conditions, summaries) |
| `scripts/auto-dent-run.ts` | Single-run TypeScript runner (prompt building, stream-json parsing, state updates) |
| `scripts/auto-dent-context-delegation.ts` | Context pressure and observed delegation analysis for the `context-delegation` gate |
| `scripts/auto-dent-ctl.ts` | Control plane (status, halt, reflect, dry-sweep) |
| `scripts/auto-dent-dry-sweep.ts` | Cross-PR/codebase DRY drift candidate collector |
| `scripts/auto-dent-score.ts` | Run and batch quality scoring |
| `scripts/auto-dent-provider-matrix.ts` | Synthetic Claude/Codex/hybrid provider comparison matrix |
| `scripts/auto-dent-harness.ts` | Harness utilities (auto-merge, labeling) |
| `prompts/deep-dive-default.md` | Default prompt template |
| `prompts/test-task.md` | Synthetic test task template |
| `logs/auto-dent/<batch-id>/` | Per-batch logs and state |
| `docs/horizons/autonomous-batch-operations.md` | Horizon taxonomy (L0-L7 vision) |
| `docs/prd-overnight-dent-horizon.md` | Multi-axis maturity PRD |
| `docs/prd-overnight-dent-lifecycle.md` | Lifecycle management PRD |
