# Hook Gym — Synthetic Problem Runner with Loss-Based Hook Observability

## Problem

The kaizen hook/gate system has 25 hooks across 4 event types, but there is no way to **run a real agent session through the full kaizen lifecycle while observing hook behavior**. The existing infrastructure has complementary blind spots:

- **auto-dent** runs real agents with hooks active but never captures hook events — hooks fire invisibly
- **SessionSimulator** calls hooks directly but doesn't run real `claude` sessions
- The CLI has `--include-hook-events` (emits hook lifecycle JSON in stream-json) but **nobody uses it**
- `--dangerously-skip-permissions` does NOT skip hooks (only `--bare` does) — confirmed in hooks-design.md and incident #323

Fixing kaizen-on-kaizen creates a chicken-and-egg loop: broken tools produce broken fixes. We need to exercise hooks on **trivially simple** synthetic problems where failures are clearly hook/gate issues, not task complexity.

## Solution

Hook Gym: a synthetic problem runner that spawns cheap agents (haiku/sonnet) on simple problems with `--include-hook-events` to get full hook observability. It adopts the autoresearch methodology (ground truth, weighted scoring, confusion-pair taxonomy, iteration logging) for scientific hook measurement and regression prevention.

### Goals

1. **Now**: Diagnose and fix broken hooks by exercising them on simple problems
2. **Ongoing**: Prevent regressions by running scenarios as a test suite after hook changes
3. **Future**: Enable loss-based improvement of agentic flows (prompts, skills, hook logic)

## Methodology — Adopted from kaizen-autoresearch

| Autoresearch concept | Hook-gym equivalent |
|---------------------|---------------------|
| Corpus tasks (EC-01..EC-N) | Scenarios (`probe-hooks`, `lifecycle-gates`, `full-clear`) |
| Ground truth (GT levels) | Expected hook decisions per scenario (fire/deny/allow/block) |
| Weighted loss function | Hook decision accuracy score (weighted by severity) |
| `autoresearch-results.jsonl` | `hook-gym-results.jsonl` — iteration log with score/delta/status |
| Confusion pairs (pred-GT) | Hook confusion pairs: `(hook, expected_decision, actual_decision)` |
| Taxonomy files | `taxonomy/` directory routing failures by hook + confusion pair |
| `mine-report.ts` | `hook-gym-report.ts` — top failures by weighted impact |
| Explore pre-screening | Quick single-scenario re-run after a fix, before full suite |
| Leaderboard | `leaderboard.md` — hook pass rate over time |

## Hook Event Format (Probed)

Captured from `claude -p --include-hook-events --output-format stream-json --verbose`:

### Hook started event
```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "845876f2-7841-408e-8146-d96dec318e88",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "uuid": "c529fa76-...",
  "session_id": "8213f9f6-..."
}
```

### Hook response event
```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "845876f2-7841-408e-8146-d96dec318e88",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "",
  "stdout": "",
  "stderr": "",
  "exit_code": 0,
  "outcome": "success",
  "uuid": "56c30f3c-...",
  "session_id": "8213f9f6-..."
}
```

### Key observations

- Hook events are `type: "system"` with subtypes `hook_started` and `hook_response`
- `hook_id` correlates start/response pairs for timing measurement
- `hook_name` format is `"EventType:groupName"` (e.g., `"SessionStart:startup"`)
- Individual hooks within a group share the same `hook_name` — distinguished only by `hook_id`
- `output` contains the hook's JSON response (if any) — this is where `permissionDecision: "deny"` appears
- `exit_code` + `outcome` indicate success/failure
- `stdout`/`stderr` are separate from `output`

### PreToolUse deny response (expected in `output` field)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "blocked because..."
  }
}
```

### Stop block response (expected in `output` field)
```json
{
  "decision": "block",
  "reason": "You have pending gates..."
}
```

## Architecture: Compose, Don't Duplicate

### Reused modules from auto-dent (no changes)

| Module | What we reuse |
|--------|--------------|
| `auto-dent-stream.ts` | `processStreamMessage`, `parsePhaseMarkers`, `formatToolUse`, `extractArtifacts`, `color` |
| `auto-dent-events.ts` | `EventEmitter`, `makeRunId`, event envelope format |
| `auto-dent-score.ts` | `classifyFailure`, failure taxonomy constants |
| `auto-dent-harness.ts` | `msg.*` builders, `StreamCapture`, `makeRunResult`, `runLiveProbe` pattern |
| `auto-dent-artifacts.ts` | `buildRunManifest`, `writeRunManifest` for log archival |

### New files

| File | Purpose | ~Lines |
|------|---------|--------|
| `scripts/hook-gym.ts` | CLI + runner | ~350 |
| `scripts/hook-gym-scenarios.ts` | Scenario corpus + ground truth | ~200 |
| `scripts/hook-gym-stream.ts` | Hook event parser for `--include-hook-events` | ~150 |
| `scripts/hook-gym-score.ts` | Mechanistic scorer | ~200 |
| `scripts/hook-gym-report.ts` | Timeline + mine report + leaderboard | ~200 |
| `scripts/hook-gym-schema.ts` | Zod schemas | ~100 |
| `scripts/hook-gym-replay.ts` | Extract tool sequences + replay through hooks | ~150 |

## Ground Truth & Scoring

### Ground truth per scenario

```typescript
interface HookExpectation {
  hookName: string;           // e.g. "kaizen-enforce-case-exists"
  eventType: string;          // PreToolUse, PostToolUse, Stop, SessionStart
  expectedDecision: "fire" | "deny" | "allow" | "block" | "set-gate" | "clear-gate" | "skip";
  severity: number;           // 1=advisory, 2=enforcement, 3=gate-critical
  description: string;
}

interface Scenario {
  name: string;
  prompt: string;
  model: "haiku" | "sonnet";
  maxBudget: number;
  timeoutSeconds: number;
  expectedHooks: HookExpectation[];
  expectedGateLifecycle: {
    gate: string;
    shouldActivate: boolean;
    shouldClear: boolean;
  }[];
}
```

### Severity weights

| Severity | Weight | Examples |
|----------|--------|---------|
| 1 (advisory) | 1 | `search-before-file`, `verify-before-stop` |
| 2 (enforcement) | 2 | `enforce-worktree-writes`, `enforce-case-exists` |
| 3 (gate-critical) | 4 | `stop-gate`, `pr-review-loop`, `kaizen-reflect` |

### Mechanistic scorer

```typescript
interface ScoreResult {
  scenario: string;
  hookAccuracy: number;       // % of hooks matching expected decision
  gateAccuracy: number;       // % of gates with correct lifecycle
  totalLoss: number;          // weighted loss (lower = better)
  confusionPairs: Array<{
    hook: string;
    expected: string;
    actual: string;
    severity: number;
  }>;
  criticalMisses: number;     // severity>=3 mismatches
}
```

### Iteration log

```typescript
// Append-only JSONL — hook-gym-results.jsonl
interface IterationResult {
  iteration: number;
  timestamp: string;
  commit: string;
  scenario: string;
  loss: number;
  delta: number;              // vs reference baseline
  status: "baseline" | "keep" | "discard" | "regression";
  hookAccuracy: number;
  gateAccuracy: number;
  criticalMisses: number;
  confusionPairs: string[];
  cost: number;
  durationSeconds: number;
  model: string;
}
```

## Scenarios

### `probe-hooks` (~$0.02, haiku, 60s)

**Task**: Create a file, commit, attempt `gh pr create`.

**Ground truth**:
- SessionStart: 3 hooks fire (check-wip, session-cleanup, worktree-setup)
- PreToolUse/Write: enforce-worktree-writes=ALLOW, enforce-case-exists=DENY, enforce-pr-review=ALLOW
- PreToolUse/Bash on `git commit`: enforce-case-worktree=ALLOW, block-git-rebase=ALLOW
- PostToolUse/Bash on `gh pr create`: pr-review-loop=SET(needs_review), kaizen-reflect=SET(needs_pr_kaizen)
- Stop: stop-gate=BLOCK (2 gates pending)

### `lifecycle-gates` (~$0.10, sonnet, 120s)

**Task**: Create kaizen case, edit file, run tests, create PR, observe gate behavior, emit KAIZEN_UNFINISHED.

**Ground truth**: All hooks fire. Gates activate on PR creation. Stop gate blocks. UNFINISHED clears gates.

### `full-clear` (~$0.25, sonnet, 180s)

**Task**: Make change, PR, invoke `/kaizen-review-pr`, invoke `/kaizen-reflect`, stop cleanly.

**Ground truth**: Gates activate AND clear through proper lifecycle. Clean stop.

## Replay & Canned Mode

Three layers for cost-efficient testing:

| Layer | Hooks fire? | LLM? | Cost | Use case |
|-------|:-----------:|:----:|:----:|----------|
| Score-only | No | No | $0 | Re-score against updated ground truth |
| Hook replay | **Yes** | No | $0 | Test hook fixes against same tool sequence |
| Live run | Yes | Yes | $0.02-0.25 | Capture new baseline |

### Capture → Extract → Replay

1. **Live run** produces `run-N.log` (stream-json)
2. **Extract** parses tool_use blocks → `fixtures/probe-hooks.fixture.json`
3. **Hook replay** feeds fixture through `SessionSimulator`/`HookRunner` → score against GT

The `SessionSimulator` already supports canned events:
```typescript
session.fireBashPre("gh pr create ...");
session.fireBashPost("gh pr create ...", { stdout: "https://..." });
session.fireStop();
```

## CLI

```bash
npx tsx scripts/hook-gym.ts --list                    # List scenarios
npx tsx scripts/hook-gym.ts --run probe-hooks         # Run scenario (live)
npx tsx scripts/hook-gym.ts --run probe-hooks --dry-run  # Show prompt only
npx tsx scripts/hook-gym.ts --run-all                 # All scenarios
npx tsx scripts/hook-gym.ts --replay <log>            # Re-score captured log
npx tsx scripts/hook-gym.ts --replay-hooks <fixture>  # Replay through real hooks
npx tsx scripts/hook-gym.ts --extract <log>           # Extract fixture from log
npx tsx scripts/hook-gym.ts --rescore <scenario>      # Re-score vs updated GT
npx tsx scripts/hook-gym.ts --mine                    # Top failures by impact
npx tsx scripts/hook-gym.ts --leaderboard             # Score history
npx tsx scripts/hook-gym.ts --debug                   # Raw hook event JSON
```

## PR Split

### Phase 1: Foundation (tooling PRs)

| PR | Contents | Value |
|----|----------|-------|
| 1 | Spec + Issue + Probe | Alignment artifact |
| 2 | Schema + Scenarios + Parser | Foundation, `--list` and `--dry-run` work |
| 3 | Live Runner + Timeline | **First visibility** into hook behavior |

### Phase 2: Measurement (tooling PRs)

| PR | Contents | Value |
|----|----------|-------|
| 4 | Scorer + Iteration Log | Quantitative hook health metric |
| 5 | Replay + Fixtures | CI-ready regression tests ($0) |
| 6 | Mine Report + Taxonomy | Systematic failure diagnosis |

### Phase 3: Hook Fixes (separate PRs)

Each hook fix is its own PR with:
- Bug description with hook-gym evidence (confusion pair, timeline)
- The fix
- Updated fixture verification
- `hook-gym:ci` regression check

### The Ladder

```
PR 1 (spec)     → alignment
PR 2 (schemas)  → ground truth defined
PR 3 (observe)  → SEE hook behavior
PR 4 (measure)  → QUANTIFY hook health
PR 5 (replay)   → PREVENT regressions
PR 6 (diagnose) → PRIORITIZE fixes
PR 7+ (fixes)   → hooks get fixed → kaizen builds itself better
```

## Log Structure

```
logs/hook-gym/
├── state.json
├── hook-gym-results.jsonl        # Iteration log (append-only)
├── events.jsonl
├── leaderboard.md
├── taxonomy/                     # Per-hook failure JSONL
├── run-N-<scenario>.log          # Raw stream-json
├── run-N-<scenario>-prompt.md    # Rendered prompt
└── run-N-<scenario>-report.md    # Timeline + score
```
