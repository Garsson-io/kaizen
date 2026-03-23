# Auto-Dent Operations Guide

The auto-dent system is kaizen's autonomous batch runner. It picks issues from the backlog, delegates to `/kaizen-deep-dive` agents, tracks artifacts, and provides real-time observability. This document covers how to run, monitor, debug, and extend the system.

## Architecture

```
auto-dent.sh (trampoline)
  │
  ├── pulls main between runs (self-update)
  ├── manages state.json (cross-run persistence)
  ├── enforces stop conditions (max runs, consecutive failures, halt file)
  │
  └── auto-dent-run.sh (thin wrapper)
        └── auto-dent-run.ts (TypeScript runner)
              ├── builds prompt from templates (prompts/*.md)
              ├── spawns claude with --output-format stream-json
              ├── parses real-time milestones (PRs, issues, costs)
              ├── posts per-run comments to batch progress issue
              ├── queues auto-merge as safety net
              └── writes results back to state.json

auto-dent-ctl.ts (control plane)
  ├── status  — show active/completed batches
  └── halt    — stop a batch or all batches

auto-dent-score.ts (scoring)
  └── per-run and per-batch quality scoring
```

### Self-Update Mechanism

The trampoline (`auto-dent.sh`) runs `git pull --ff-only origin main` before each run. Because `auto-dent-run.sh` is re-read from disk each iteration, merged PRs that improve the runner take effect on the next run. This is how the system improves itself overnight.

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

### Prompt Templates

Templates live in `prompts/`. The default is `deep-dive-default.md`. Variables are substituted using `{{variable}}` syntax, with `{{#var}}...{{/var}}` for conditionals.

Key variables: `{{guidance}}`, `{{run_tag}}`, `{{run_context}}`, `{{issues_closed}}`, `{{prs}}`, `{{host_repo}}`.

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

# Custom timeout (default 45min per run)
./scripts/auto-dent.sh --max-run-seconds 1800 "simple fixes only"
```

### All flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-runs N` | unlimited | Stop after N runs |
| `--cooldown N` | 30s | Seconds between runs |
| `--budget N.NN` | none | Per-run budget (passed to `claude --max-budget-usd`) |
| `--max-budget N.NN` | none | Total batch budget — halts when cumulative cost exceeds |
| `--max-failures N` | 3 | Stop after N consecutive failures |
| `--max-run-seconds N` | 2700 (45min) | Wall-time timeout per run |
| `--dry-run` | off | Show what would run |
| `--test-task` | off | Use synthetic fast task |
| `--experiment` | off | Enable extra pipeline diagnostics |

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

### From another terminal

```bash
# Show all batches (active and completed)
./scripts/auto-dent.sh --status

# Or directly:
npx tsx scripts/auto-dent-ctl.ts status
```

### From GitHub

Each batch creates a progress issue (labeled `auto-dent`). Per-run results are posted as comments with PRs created, issues filed, and run metrics.

### Logs

All logs go to `logs/auto-dent/<batch-id>/`:
- `state.json` — live batch state (updated after each run)
- `run-N.log` — raw claude output for run N
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
| Auto-merge failure | PRs created but not merged | Branch protection rules | Check repo settings, CI status |

## Post-Batch Hygiene

After a batch completes:

1. **PRs** — The harness queues auto-merge. Check for any stuck PRs:
   ```bash
   gh pr list --repo Garsson-io/kaizen --label auto-dent --state open
   ```

2. **Worktrees** — Runs create worktrees that should be cleaned up on merge. Check for stale ones:
   ```bash
   git worktree list
   ```

3. **Batch progress issue** — Auto-closed by the harness. Verify:
   ```bash
   jq '.progress_issue' logs/auto-dent/<batch-id>/state.json
   ```

## Scoring

The `auto-dent-score.ts` module scores run quality. Per-run scores consider:
- PRs created (higher = better)
- Issues filed/closed
- Cost efficiency (value per dollar)
- Exit code (non-zero penalized)

Batch scores aggregate per-run scores with a post-hoc analysis that checks actual merge status of PRs.

## Extending the System

### Adding a new prompt template
Create `prompts/my-template.md` with `{{variable}}` placeholders. Template selection is currently hardcoded (`deep-dive-default.md`) — changing it requires modifying `auto-dent-run.ts`.

### Adding new state fields
1. Add the field to `BatchState` interface in `auto-dent-run.ts`
2. Initialize it in `auto-dent.sh` state file creation
3. Update it in the appropriate phase of `auto-dent-run.ts`

### Adding new stop conditions
Add to the trampoline's main loop in `auto-dent.sh` (between runs) or to `auto-dent-run.ts` (during a run, via stream-json parsing).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/auto-dent.sh` | Trampoline (outer loop, self-update, stop conditions) |
| `scripts/auto-dent-run.sh` | Thin bash wrapper for TS runner |
| `scripts/auto-dent-run.ts` | TypeScript runner (prompt building, stream-json parsing, state updates) |
| `scripts/auto-dent-ctl.ts` | Control plane (status, halt) |
| `scripts/auto-dent-score.ts` | Run and batch quality scoring |
| `scripts/auto-dent-harness.ts` | Harness utilities (auto-merge, labeling) |
| `prompts/deep-dive-default.md` | Default prompt template |
| `prompts/test-task.md` | Synthetic test task template |
| `logs/auto-dent/<batch-id>/` | Per-batch logs and state |
| `docs/horizons/autonomous-batch-operations.md` | Horizon taxonomy (L0-L7 vision) |
| `docs/prd-overnight-dent-horizon.md` | Multi-axis maturity PRD |
| `docs/prd-overnight-dent-lifecycle.md` | Lifecycle management PRD |
