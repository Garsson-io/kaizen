# PRD: Hook Runtime Safety — Resource Budgets, Circuit Breakers, Graceful Degradation

**Discussion:** [Garsson-io/kaizen#476](https://github.com/Garsson-io/kaizen/discussions/476)
**Author:** Claude (autonomous)
**Date:** 2026-03-22
**Status:** Draft

---

## 1. Problem Statement

### Hooks are code artifacts treated as if they have no runtime consequences

Kaizen's hook infrastructure has excellent *correctness* coverage: does the hook produce the right answer? Does the regex match correctly? Does the gate unblock at the right time? But hooks are not pure functions. They are a **runtime system** that shares process memory, execution time, filesystem state, and an error propagation path with the host Claude Code process. No hook has a resource budget, a timeout enforced at the process level, a circuit breaker, or a graceful degradation path.

The mental model gap:

| Dimension | Hook-as-code (current) | Hook-as-runtime (needed) |
|-----------|----------------------|------------------------|
| Memory | Unbounded | Budgeted per hook |
| Time | `timeout` field in settings, but not enforced at process level | Hard kill after budget exceeded |
| Subprocesses | Uncontrolled | Whitelist with policy |
| Failure mode | Crash or hang the pipeline | Isolated, reported, continued |
| Ordering | Independent | Shared pipeline with cascading failure risk |
| Observability | Exit code only | Start time, duration, peak memory, exit code |

### Incident evidence

Each of the following incidents would have been prevented or mitigated by a hook safety layer:

**#474 — OOM cascade from Stop hook spawning vitest + tsc**

- **What happened:** `kaizen-verify-before-stop.sh` spawned `vitest` and `tsc --noEmit` inside a Stop hook. Stop hooks retry on exit 2. Each retry spawned new ~120 MB processes. Within 60 seconds, accumulated processes exhausted system memory and the Linux OOM killer terminated the Claude Code process.
- **Root cause:** No subprocess policy. No memory budget. No circuit breaker. The hook was free to spawn arbitrarily expensive subprocesses, and the retry mechanism amplified the damage.
- **Cost:** Lost a productive session. Required manual intervention to recover. The fix (kaizen #372) was applied after the fact: the hook was rewritten to be advisory-only and never spawn heavy subprocesses. But nothing *prevents* a future hook from making the same mistake.

**#371 — Conflict markers cause infinite parsing loops (deadlock)**

- **What happened:** A hook file contained git conflict markers (`<<<<<<<`). The hook's text processing entered an infinite loop trying to parse malformed content.
- **Root cause:** No timeout enforcement at the process level. The `timeout` field in settings-fragment.json is a *hint* to the Claude Code runtime, but the hook process itself has no watchdog. A hook that enters an infinite loop will hang the entire pipeline.
- **Cost:** Required manual kill. All subsequent hooks in the pipeline were blocked.

**#386 — No error handling model for bash hooks**

- **What happened:** Hooks that encounter unexpected conditions (missing files, network errors, unexpected input) either crash with an unhelpful error or silently succeed. There is no standard error handling model.
- **Root cause:** Each hook implements its own error handling (or doesn't). There is no shared library for "fail safely and report why." `set -euo pipefail` catches some errors but provides no structured reporting.
- **Cost:** Silent failures accumulate. Hooks that should have flagged problems pass silently. Hooks that hit transient errors crash and block the pipeline.

**#475 — CI lint needed for heavy subprocesses**

- **What happened:** After the #474 OOM, a CI lint was proposed to statically detect heavy subprocess spawns in hook scripts. The lint does not yet exist.
- **Root cause:** No static analysis of hook resource usage. Review depends on humans remembering the anti-pattern.
- **Cost:** The next developer who writes `vitest` or `npm test` inside a PostToolUse or Stop hook will rediscover the OOM.

**#469 — Crash-loop with no defense-in-depth**

- **What happened:** A hook failure triggered a retry, which triggered the same failure, creating a crash loop with no escape hatch.
- **Root cause:** No circuit breaker. No failure counter. No cooldown. The system retried indefinitely.
- **Cost:** Required manual intervention to break the loop.

### The shared resource problem

Hooks appear independent but share:

1. **Process memory** — All hooks in a pipeline share the same system memory budget. One hook allocating 500 MB leaves less for everything else.
2. **Execution time** — A slow hook delays all subsequent hooks and makes the agent unresponsive. Stop hooks that block cause retries, amplifying the problem.
3. **Filesystem state** — Hooks read and write state files in `$STATE_DIR`. One hook corrupting state can cause another hook to malfunction.
4. **Error propagation** — One hook crashing can prevent subsequent hooks from running, depending on the runner implementation. A PreToolUse hook that hangs blocks the tool call and all subsequent hooks.

---

## 2. Safety Properties

Every hook in the kaizen system should satisfy these four safety properties.

### 2.1 Resource Boundedness

- **Memory:** No hook should cause total system memory usage to grow by more than a declared budget (default: 50 MB). Hooks that need more must declare it explicitly.
- **Time:** No hook should run longer than its declared timeout (default: 5 seconds for lightweight hooks, 15 seconds for hooks that read git state). The timeout must be enforced with a hard kill, not just a hint.
- **Subprocess:** No hook should spawn processes that outlive it. Child processes must be in the same process group so they are killed when the hook is killed.
- **Disk:** No hook should write more than 1 MB of temporary state per invocation. State files are small key-value pairs, not logs.

### 2.2 Isolation

- A failing hook must not prevent other hooks in the same pipeline stage from running. The runner should catch failures and continue.
- A slow hook must not make the entire hook pipeline unresponsive. Timeouts must be per-hook, not per-stage.
- A hook's state mutations must not corrupt another hook's state. State files should be namespaced per hook (they already are by convention, but this should be enforced).

### 2.3 Graceful Degradation

- If a hook exceeds its budget, it should be killed and a structured report should be emitted: which hook, what limit was exceeded, what the measured value was.
- If a hook fails, the pipeline should continue with a warning for advisory hooks. Only hooks explicitly marked as `blocking` should halt the pipeline on failure.
- The distinction between **blocking** hooks (PreToolUse deny, Stop block) and **advisory** hooks (warnings, reminders) should be formalized in the hook manifest.
- A failed blocking hook should produce a clear, actionable error message — not a stack trace or silent failure.

### 2.4 Observability

- Each hook execution should be logged with: hook name, start timestamp, end timestamp, wall-clock duration, exit code.
- Hooks that exceed 80% of their timeout budget should be flagged as "slow" in the log.
- Peak memory usage per hook should be trackable (Phase 3 — requires process-level monitoring).
- Aggregate statistics (p50/p95 duration per hook, failure rate per hook) should be queryable from logs.
- Resource trend data enables proactive tightening of budgets before incidents occur.

---

## 3. Design: The Hook Safety Layer

### 3.1 Resource Budgets

Each hook declares its resource budget in the hook manifest. Hooks without explicit budgets receive conservative defaults.

Budget fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout_ms` | integer | 5000 | Hard kill after this many milliseconds |
| `max_memory_mb` | integer | 50 | Memory growth ceiling (enforced via cgroup or monitoring) |
| `allow_subprocess` | string[] | `["jq", "grep", "git", "sed", "awk", "cut", "wc"]` | Whitelist of allowed subprocess binaries |
| `max_disk_bytes` | integer | 1048576 | Max bytes written to state directory per invocation |

Budgets are declared in the hook manifest (see section 4) and enforced by the execution wrapper (see section 3.2).

### 3.2 Execution Wrapper

All hooks run through a thin wrapper (`lib/hook-runner.sh` or equivalent) that enforces budgets. The wrapper:

1. **Sets a process group** — `setsid` or equivalent, so all child processes can be killed together.
2. **Starts a timer** — Records start time. Sets an alarm for `timeout_ms`.
3. **Runs the hook** — Invokes the hook script with the original stdin/stdout/stderr.
4. **On timeout** — Kills the entire process group. Emits a structured log: `HOOK_TIMEOUT hook=<name> limit_ms=<budget> elapsed_ms=<actual>`.
5. **On completion** — Records end time, exit code. Emits timing log: `HOOK_COMPLETE hook=<name> elapsed_ms=<actual> exit=<code>`.
6. **On crash** — Catches non-zero exit. For advisory hooks, logs and continues. For blocking hooks, propagates the exit code.

The wrapper is interposed by modifying the hook invocation in `plugin.json` / settings. Instead of:

```json
{ "command": "./.kaizen/.claude/hooks/kaizen-verify-before-stop.sh", "timeout": 60 }
```

The invocation becomes:

```json
{ "command": "./.kaizen/.claude/hooks/lib/hook-runner.sh kaizen-verify-before-stop", "timeout": 65 }
```

The outer `timeout` is set slightly higher than the inner budget to allow the wrapper to emit its log before the Claude Code runtime kills it.

### 3.3 Subprocess Policy

**Static analysis (CI lint):**

A CI check scans all hook scripts for subprocess invocations and flags violations:

- **Blacklist** (always reject): `vitest`, `jest`, `mocha`, `tsc`, `npm test`, `npm run`, `npx` (with exceptions), `node` with unbounded input, `cargo test`, `go test`, `python -m pytest`.
- **Whitelist** (always allow): `jq`, `grep`, `rg`, `git`, `sed`, `awk`, `cut`, `wc`, `sort`, `uniq`, `head`, `tail`, `cat`, `date`, `basename`, `dirname`, `mktemp`, `rm`, `mv`, `cp`, `test`, `[`, `true`, `false`.
- **Conditional** (require justification): `curl`, `gh` (API calls only, not `gh run`), `npx tsx` (for TS trampoline hooks — must be declared in manifest).

The lint runs in CI on every PR that modifies `.claude/hooks/`. It produces actionable errors:

```
ERROR: .claude/hooks/kaizen-verify-before-stop.sh:25
  Spawns blacklisted subprocess: vitest
  Hooks must not spawn test runners. Use the marker pattern instead.
  See docs/hooks-design.md#heavy-subprocesses-in-accumulating-hooks
```

**Runtime enforcement (Phase 3):**

The execution wrapper can optionally intercept `exec`/`fork` calls via `LD_PRELOAD` or by wrapping `PATH` to shadow blacklisted binaries. This is more complex and is deferred to Phase 3.

### 3.4 Circuit Breaker

If a hook fails repeatedly, it should be temporarily disabled rather than continuing to fail and block the pipeline.

**Algorithm:**

1. Track failures per hook in a state file: `$STATE_DIR/.hook-health/<hook-name>`.
2. Each failure increments a counter with a timestamp.
3. If `failures >= threshold` within `window_minutes`, the hook is circuit-broken:
   - The wrapper skips the hook entirely.
   - A warning is emitted: `HOOK_CIRCUIT_BROKEN hook=<name> failures=<n> window=<minutes>`.
   - The state file records the circuit-break timestamp.
4. After `cooldown_minutes`, the circuit breaker resets. The next invocation runs the hook normally.
5. If the hook succeeds, the failure counter resets to zero.

**Defaults:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `failures` | 3 | Number of failures to trigger circuit break |
| `window_minutes` | 10 | Time window for counting failures |
| `cooldown_minutes` | 30 | How long the hook stays disabled |

**User notification:**

When a hook is circuit-broken, the wrapper emits a user-visible warning on every invocation during the cooldown:

```
WARNING: Hook kaizen-verify-before-stop is temporarily disabled.
It failed 3 times in the last 10 minutes. Will re-enable in 22 minutes.
To force re-enable: rm /tmp/.pr-review-state/.hook-health/kaizen-verify-before-stop
```

---

## 4. The Hook Manifest

Today, hook registrations live in `plugin.json` (and the deprecated `settings-fragment.json`) with minimal metadata: command path and timeout. The hook manifest extends this with safety properties.

**Proposed format** (YAML for readability; actual implementation may use JSON to match existing conventions):

```yaml
hooks:
  kaizen-verify-before-stop:
    type: advisory           # advisory | blocking
    event: Stop
    command: ./.kaizen/.claude/hooks/kaizen-verify-before-stop.sh
    timeout_ms: 3000
    max_memory_mb: 50
    allow_subprocess: [jq, grep, git]
    circuit_breaker:
      failures: 3
      window_minutes: 10
      cooldown_minutes: 30
    description: "Reminds agent to run tests before stopping if TS files were modified"

  kaizen-enforce-pr-review:
    type: blocking
    event: PreToolUse
    matcher: Bash
    command: ./.kaizen/.claude/hooks/kaizen-enforce-pr-review.sh
    timeout_ms: 5000
    max_memory_mb: 30
    allow_subprocess: [jq, grep, git, gh]
    circuit_breaker:
      failures: 5
      window_minutes: 15
      cooldown_minutes: 60
    description: "Blocks non-PR commands while PR review gate is active"

  kaizen-reflect-ts:
    type: advisory
    event: PostToolUse
    matcher: Bash
    command: ./.kaizen/.claude/hooks/kaizen-reflect-ts.sh
    timeout_ms: 10000
    max_memory_mb: 80
    allow_subprocess: [jq, grep, git, npx]  # npx tsx trampoline
    circuit_breaker:
      failures: 3
      window_minutes: 10
      cooldown_minutes: 30
    description: "Captures kaizen reflection data after PR/merge commands"
```

**Key design decisions:**

1. **`type: advisory` vs `type: blocking`** — Advisory hooks log warnings but never halt the pipeline. Blocking hooks can deny tool use or block stop. This distinction exists implicitly today (exit 0 vs exit 2) but is not declared or enforced by the runner.

2. **`allow_subprocess`** — Per-hook whitelist. The CI lint validates that hook scripts only invoke binaries on their whitelist. The runtime wrapper can optionally enforce this.

3. **`circuit_breaker`** — Per-hook override of circuit breaker parameters. Blocking hooks get higher thresholds (more failures before breaking) because disabling them has higher cost.

4. **Backward compatibility** — Hooks without manifest entries get default budgets. The manifest is additive, not required. Migration path is: defaults first, then tighten based on observed usage.

---

## 5. Implementation Phases

### Phase 1: CI lint for heavy subprocesses
**Issue:** #475 (already filed)
**Scope:** Static analysis of hook scripts for blacklisted subprocess invocations.
**Deliverables:**
- Shell script or TypeScript CI check that scans `.claude/hooks/*.sh` for blacklisted commands
- Integration with existing CI pipeline
- Documentation of whitelist/blacklist in `docs/hooks-design.md`

**Effort:** Small. Highest ROI — prevents the exact class of incident that caused #474.

### Phase 2: Execution wrapper with timeouts
**Scope:** `lib/hook-runner.sh` wrapper that enforces per-hook timeouts with hard kills.
**Deliverables:**
- `hook-runner.sh` with process group management and timeout enforcement
- Structured logging (hook name, duration, exit code)
- Migration of all hook invocations to use the wrapper
- Tests for timeout behavior, process group cleanup

**Effort:** Medium. Addresses deadlock (#371) and provides the foundation for all subsequent phases.

### Phase 3: Resource monitoring and budgets
**Scope:** Memory tracking, disk usage monitoring, subprocess interception.
**Deliverables:**
- Memory monitoring via `/proc/<pid>/status` polling or cgroup limits
- Disk write tracking for state directory
- Runtime subprocess whitelist enforcement
- Dashboard or log aggregation for resource trends

**Effort:** Medium-large. Requires platform-specific code (Linux proc filesystem). Deferred until Phase 2 proves the wrapper pattern.

### Phase 4: Circuit breaker and graceful degradation
**Scope:** Failure tracking, automatic disable/re-enable, user notification.
**Deliverables:**
- `.hook-health/` state directory with per-hook failure counters
- Circuit breaker logic in `hook-runner.sh`
- User-visible warnings for circuit-broken hooks
- Manual override to force re-enable

**Effort:** Medium. Depends on Phase 2 wrapper being stable.

### Phase 5: Full hook manifest with declarative safety properties
**Scope:** Formal manifest file with per-hook safety declarations.
**Deliverables:**
- `hook-manifest.yaml` (or JSON equivalent) with all safety properties
- Generator that produces `plugin.json` entries from the manifest
- Validation that every hook has a manifest entry
- CI check that manifest budgets are consistent with observed usage

**Effort:** Medium. Depends on Phases 1-4 establishing the safety primitives.

---

## 6. Migration Strategy

### Principle: generous defaults, gradual tightening

Existing hooks work today without safety declarations. The migration must not break them.

**Step 1: Instrument without enforcing**

Deploy the execution wrapper (Phase 2) with generous defaults:
- `timeout_ms: 30000` (30 seconds — higher than any current hook needs)
- `max_memory_mb: 200` (well above current peak usage)
- No subprocess restrictions at runtime (CI lint only)
- Circuit breaker disabled (tracking only, no auto-disable)

Run for 1-2 weeks. Collect data on actual resource usage per hook.

**Step 2: Set budgets based on observed usage**

For each hook, set budgets at 2x the observed p95:
- If p95 duration is 800 ms, set `timeout_ms: 2000`
- If p95 memory is 20 MB, set `max_memory_mb: 50`

This ensures existing hooks pass comfortably while catching pathological behavior.

**Step 3: Enable circuit breaker**

With budgets set, enable the circuit breaker with conservative thresholds (5 failures / 15 minutes). Monitor for false positives. Tighten after confidence builds.

**Step 4: Enforce subprocess policy**

Move from CI-lint-only to runtime enforcement. Start with a log-only mode (warn on blacklisted subprocess, don't kill) for one sprint, then enforce.

**Step 5: Require manifest entries**

Once all hooks have observed-data-based budgets, require a manifest entry for every hook. New hooks must declare their safety properties at creation time.

---

## 7. Success Criteria

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| Zero OOM incidents from hooks | Incident count in kaizen issues | 0 per quarter |
| Zero deadlock incidents from hooks | Incident count in kaizen issues | 0 per quarter |
| All hooks have declared resource budgets | Manifest coverage | 100% |
| Hook execution time tracked | Structured logs exist for every invocation | 100% coverage |
| No hook exceeds 80% of its budget in normal operation | p95 duration / budget ratio | < 0.8 for all hooks |
| Circuit breaker prevents crash-loops | Incident count for #469-class issues | 0 per quarter |
| CI lint catches heavy subprocess at PR time | #474-class issues reaching production | 0 |
| Hook failures are isolated | One hook failing does not block unrelated hooks | Verified by integration test |

---

## 8. Relationship to Existing Work

### `docs/hooks-design.md`

The hooks-design doc covers hook **correctness**: regex patterns, gate design, allowlist design, testing conventions. This PRD covers hook **safety**: resource budgets, failure isolation, graceful degradation. They are complementary axes of the same system.

Once implemented, the hooks-design doc should be updated with:
- A "Safety" section pointing to the hook manifest
- Updated anti-pattern #7 ("Heavy Subprocesses") to reference the CI lint and subprocess policy
- A "Hook Lifecycle" section covering the execution wrapper

### `settings-fragment.json` and `plugin.json`

The current `timeout` field in hook registrations is a correctness timeout (how long the Claude Code runtime waits). The hook manifest adds *safety* timeouts (how long the hook-runner wrapper waits before hard-killing). The safety timeout should always be less than the registration timeout, with the difference being the wrapper's cleanup window.

Example:
- Manifest: `timeout_ms: 5000` (hook-runner kills the hook at 5 seconds)
- Registration: `"timeout": 8` (Claude Code runtime kills the wrapper at 8 seconds)
- Gap: 3 seconds for the wrapper to emit its structured log and clean up

### Self-healing infrastructure

This PRD establishes the runtime safety primitives. A future self-healing PRD could build on them:
- Circuit breaker data feeds into automated issue filing ("hook X is circuit-broken — file a kaizen issue")
- Resource trends feed into automated budget adjustment
- Failure patterns feed into root cause classification

### The Three Levels

This PRD is primarily **Level 2** (hooks enforcing hooks) with **Level 3** aspirations (the execution wrapper makes unsafe behavior architecturally impossible):

| Component | Level | Rationale |
|-----------|-------|-----------|
| CI lint for subprocesses | L2 | Blocks PRs with violations; agent could bypass with `--no-verify` |
| Execution wrapper timeouts | L3 | Mechanistic — the wrapper kills the process regardless of hook intent |
| Circuit breaker | L2 | State-based enforcement; agent could delete state files |
| Subprocess whitelist (runtime) | L3 | Mechanistic — blacklisted binaries are not on PATH |
| Hook manifest | L1 | Declarative — requires the runner to enforce it |

The progression from L1 manifest declarations to L3 mechanistic enforcement follows the kaizen escalation principle: start with the cheapest intervention, escalate when it fails.

---

## 9. Out of Scope

- **Hook ordering dependencies** — Some hooks logically depend on others (e.g., a gate-creating hook must run before the gate-checking hook). Ordering is a correctness concern, not a safety concern. Deferred to a future hooks-design update.
- **Cross-session hook state** — Circuit breaker state is per-session (ephemeral in `/tmp`). Persistent cross-session health tracking requires a storage layer beyond the current state-file model.
- **Remote hook execution** — All hooks run locally. Distributed hook execution (e.g., in CI) has a different safety model.
- **Hook versioning** — The manifest does not version hooks. Versioning is handled by the plugin system and git.
