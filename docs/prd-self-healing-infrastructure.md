# PRD: Self-Healing Infrastructure -- Detect, Diagnose, Repair Corrupted State

**Discussion:** [Garsson-io/kaizen#476](https://github.com/Garsson-io/kaizen/discussions/476)
**Author:** Claude (autonomous)
**Date:** 2026-03-22
**Status:** Draft

---

## 1. Problem Statement

When kaizen's own infrastructure breaks, it **stays broken until a human notices**. There is no mechanism for the system to detect and repair its own corrupted state. This violates a core kaizen principle: "No promises without mechanisms. 'Later' without a signal is 'never.'"

### 1.1 Corruption Modes (with evidence)

| Issue | Corruption Mode | Subsystem | Impact |
|-------|----------------|-----------|--------|
| [#371](https://github.com/Garsson-io/kaizen/issues/371) | Conflict markers in hook files (<<<<<<, =======, >>>>>>) | Hooks | Infinite deadlock -- hooks can't parse themselves, system halts |
| [#309](https://github.com/Garsson-io/kaizen/issues/309) | Stale state files from dead processes | Hooks | Phantom gates -- a gate appears blocked but the blocker is gone |
| [#417](https://github.com/Garsson-io/kaizen/issues/417) | 20+ stale worktrees accumulating on disk | Worktrees | Disk exhaustion, confusion about which worktrees are active |
| [#474](https://github.com/Garsson-io/kaizen/issues/474) | OOM from vitest spawned in stop hook | CI/Build | Agent killed mid-operation, no circuit breaker prevents recurrence |
| [#469](https://github.com/Garsson-io/kaizen/issues/469) | Crash-loop with no defense-in-depth | Hooks | Repeated failures with no backoff, escalation, or recovery |

### 1.2 Cost of Manual Detection

Each corruption mode shares the same lifecycle today:

1. **Silent onset** -- corruption occurs during normal operation (merge conflict, zombie process, abandoned worktree)
2. **Invisible degradation** -- system continues operating in a degraded state, sometimes for days
3. **Cascading failure** -- a second operation trips over the corrupted state, producing a confusing error
4. **Human investigation** -- a human notices the confusing error, spends 15-60 minutes diagnosing
5. **Manual repair** -- human applies a fix (delete stale file, resolve conflict, prune worktree)

The compound cost is not just the human time per incident. It is the erosion of trust in autonomous operation. Every time the system silently degrades, it proves that "autonomous" means "autonomous until something breaks quietly."

### 1.3 Why Existing Monitoring Is Insufficient

Kaizen has enforcement hooks (L2) that block bad actions. But enforcement is **prophylactic** -- it prevents bad actions. It does not detect or repair **bad state** that already exists. The system needs both:

- **Enforcement** (existing): "Don't create conflict markers" -- prevent corruption
- **Health checking** (missing): "Are there conflict markers right now?" -- detect corruption

No subsystem currently owns recovery. Hooks don't check their own file integrity. Worktree management doesn't audit for orphans. Batch operations don't track their own cleanup. The pattern is the same everywhere, but nobody implements it.

### 1.4 Why This Is Cross-Cutting, Not a Horizon

Self-healing is not a quality dimension to optimize along (like testing maturity or security posture). It is a **capability that every subsystem needs**. Hooks need to detect corrupted state files. Batch operations need to detect stale artifacts. Worktree management needs to detect orphans. The detection-diagnosis-repair-report pattern is identical across all subsystems -- only the specifics differ.

This makes it a cross-cutting concern: a shared infrastructure capability, not an improvement axis.

---

## 2. The Self-Healing Pattern

Every health check follows the same four-phase cycle:

```
DETECT --> DIAGNOSE --> REPAIR --> REPORT
```

| Phase | Purpose | Output |
|-------|---------|--------|
| **Detect** | Find anomalous state via health check | Boolean: healthy / unhealthy |
| **Diagnose** | Classify severity and identify root cause | Severity level + corruption type |
| **Repair** | Apply safe, idempotent recovery action | State restored or quarantined |
| **Report** | Record what happened for learning | Incident log entry + optional kaizen issue |

Principles governing the cycle:

- **Repair actions must be idempotent.** Running the same repair twice must produce the same result. This allows retry without fear.
- **Repair actions must be conservative.** When in doubt, quarantine (rename to `.broken`) rather than delete. Data loss is worse than clutter.
- **Detection must be cheap.** Health checks run frequently. They must complete in milliseconds, not seconds.
- **Reports feed back into kaizen-reflect.** Health check incidents are data for reflection, not just log noise.

---

## 3. Subsystem Health Checks

### 3.1 Hook Infrastructure

Hooks are the enforcement layer. When hooks themselves are corrupted, enforcement breaks down -- the guards have no guards.

| Check | Detect | Severity | Repair |
|-------|--------|----------|--------|
| Conflict markers in hook files | `grep -rn '<<<<<<\|=======\|>>>>>>' .claude/hooks/` | **Critical** -- can cause infinite deadlock (#371) | Quarantine: rename affected file to `<name>.broken`, log incident, notify. Do NOT attempt to resolve the conflict automatically. |
| Stale state files | State files (`.state`, `.lock`) with mtime older than configurable threshold (default: 4 hours) | **High** -- causes phantom gates (#309) | Clear stale state file. Write audit log entry with: original content, age, associated process (if determinable). |
| Zombie hook processes | Hook processes (identified by PID files or process name pattern) running longer than configurable timeout (default: 5 minutes) | **High** -- wastes resources, blocks operations | Kill process group. Clear associated PID/lock files. Log incident. |
| Hook syntax errors | `bash -n <hook_file>` for shell hooks, parse check for TS hooks | **Medium** -- hook silently fails to load | Quarantine file. Fall back to previous known-good version if available. |

### 3.2 Worktree Management

Worktrees provide isolation. Orphan worktrees waste disk and create confusion about what is active.

| Check | Detect | Severity | Repair |
|-------|--------|----------|--------|
| Orphan worktrees (no branch) | `git worktree list` shows worktrees whose branch no longer exists | **Medium** -- disk waste (#417) | Archive uncommitted changes to a tarball in `.claude/worktree-archive/`, then `git worktree remove`. Log what was archived. |
| Stale worktrees (no recent access) | Worktrees not accessed in N days (default: 7), determined by stat on worktree directory | **Low** -- disk waste, potential confusion | Prompt (if interactive) or label as stale. Do NOT auto-delete worktrees with uncommitted changes -- archive first. |
| Worktrees with ancient uncommitted changes | Worktrees with uncommitted changes where the most recent change is older than N days (default: 14) | **Medium** -- likely abandoned work | Archive uncommitted changes. Create a kaizen issue noting the abandoned work. Remove worktree. |
| Excessive worktree count | More than N worktrees exist (default: 10) | **Low** -- approaching resource limits | Advisory warning. List all worktrees sorted by last access time. Suggest candidates for removal. |

### 3.3 Batch Operations

Batch operations (multi-issue processing, bulk PR creation) create distributed state that is easy to abandon.

| Check | Detect | Severity | Repair |
|-------|--------|----------|--------|
| Abandoned tracking issues | Tracking issues with no update in N hours (default: 24) and associated worktrees still on disk | **Medium** -- orphaned resources | Label tracking issue as `stale`. Add comment with current state (worktree exists, PR status). |
| Stuck PRs from batch runs | PRs created by batch operations with no review activity in N days (default: 3) | **Low** -- review queue bloat | Add advisory comment to PR. Label as `needs-attention`. |
| Leftover worktrees from completed runs | Worktrees associated with merged or closed PRs | **Medium** -- disk waste | Remove worktree (changes are already in the merged PR). Log cleanup. |

### 3.4 CI/Build

Build artifacts and configuration files can become stale or corrupted.

| Check | Detect | Severity | Repair |
|-------|--------|----------|--------|
| Stale build artifacts | `dist/` directory older than newest file in `src/` | **Medium** -- runtime uses wrong code (#157) | Trigger rebuild: `npm run build`. Log that rebuild was triggered and why. |
| Dead process lock files | `.lock` files whose owning PID no longer exists | **High** -- blocks operations | Remove lock file. Log PID, lock file path, and age. |
| Conflict markers in config | `grep '<<<<<<' .claude/settings.json .claude/settings-fragment.json` | **Critical** -- settings fail to parse | Quarantine file. Attempt to restore from git: `git checkout HEAD -- <file>`. If that fails, quarantine and notify. |
| OOM-prone processes | Processes matching known OOM patterns (e.g., vitest in hook context) spawned by hooks | **Critical** -- can kill agent (#474) | Kill process immediately. Add to circuit-breaker deny list. Log incident. |

---

## 4. Implementation Architecture

### 4.1 Option A: Periodic Sweep

Run all health checks on a schedule (every N hours or at session start).

| Pro | Con |
|-----|-----|
| Simple to implement -- single entry point | Doesn't catch problems between sweeps |
| Predictable resource usage | Critical issues (OOM, conflict deadlock) need immediate response |
| Easy to test -- deterministic execution | Stale state accumulates until next sweep |

### 4.2 Option B: Event-Driven Checks

Run relevant health checks after each hook/skill execution.

| Pro | Con |
|-----|-----|
| Catches problems immediately | Adds latency to every operation |
| Context-aware -- knows what just happened | Some checks are expensive to run after every operation |
| Natural integration with existing hook lifecycle | Harder to test -- depends on execution context |

### 4.3 Option C: Hybrid (Recommended)

Separate checks by urgency:

**Event-driven (critical checks):**
- Conflict markers in hook files -- checked before each hook execution
- OOM-prone process detection -- checked during hook execution
- Dead lock files -- checked when a lock acquisition fails

**Session-start (important checks):**
- Stale state files -- checked once at session start
- Stale build artifacts -- checked once at session start
- Conflict markers in config files -- checked once at session start

**Periodic / on-demand (non-critical checks):**
- Orphan and stale worktrees -- checked by `/kaizen-cleanup` or on schedule
- Batch operation leftovers -- checked by `/kaizen-cleanup` or on schedule
- Excessive worktree count -- checked at worktree creation time

This ensures critical corruption is caught immediately, important issues are caught early in each session, and non-critical cleanup runs when convenient.

---

## 5. The Health Check Registry

Health checks should be declarative -- each subsystem registers what to check, rather than embedding checks in ad-hoc scripts.

### 5.1 Registry Format

```yaml
# .claude/kaizen/health-checks.yaml

checks:
  - name: hook-conflict-markers
    subsystem: hooks
    detect:
      command: "grep -rln '<<<<<<' .claude/hooks/*.sh"
      exit_success_means: unhealthy  # grep returns 0 when it finds matches
    severity: critical
    repair:
      action: quarantine
      pattern: "mv {file} {file}.broken"
    schedule: event:pre-hook-execution

  - name: stale-state-files
    subsystem: hooks
    detect:
      command: "find .claude/hooks/ -name '*.state' -mmin +240"
      exit_success_means: unhealthy
    severity: high
    repair:
      action: clear-with-audit
      audit_fields: [content, age, associated_process]
    schedule: session-start
    threshold_minutes: 240

  - name: orphan-worktrees
    subsystem: worktrees
    detect:
      command: "git worktree list --porcelain | ..."
      exit_success_means: unhealthy
    severity: medium
    repair:
      action: archive-and-remove
      archive_dir: .claude/worktree-archive/
    schedule: periodic:daily

  - name: stale-dist
    subsystem: ci
    detect:
      command: "test $(stat -c %Y dist/ 2>/dev/null || echo 0) -lt $(stat -c %Y src/ 2>/dev/null || echo 0)"
      exit_success_means: unhealthy
    severity: medium
    repair:
      action: rebuild
      command: "npm run build"
    schedule: session-start
```

### 5.2 Registry Runner

A single runner script (`kaizen-health-check.sh` or equivalent) that:

1. Reads the registry
2. Filters checks by schedule (event / session-start / periodic)
3. Executes the detect command
4. If unhealthy: runs diagnosis (severity classification)
5. If repair is configured: executes repair action
6. Writes incident record to `.claude/kaizen/health-log.jsonl`
7. For critical/high severity: prints advisory to agent output

### 5.3 Incident Record Format

```json
{
  "timestamp": "2026-03-22T14:30:00Z",
  "check": "hook-conflict-markers",
  "subsystem": "hooks",
  "severity": "critical",
  "detect_output": ".claude/hooks/kaizen-verify-before-stop.sh",
  "repair_action": "quarantine",
  "repair_result": "success",
  "details": "Renamed to .claude/hooks/kaizen-verify-before-stop.sh.broken"
}
```

---

## 6. Implementation Phases

### Phase 1: Framework + Critical Checks

**Goal:** Catch the corruption modes that cause the worst incidents.

**Deliverables:**
- Health check runner script (reads registry, executes checks, writes log)
- Three critical checks implemented:
  - Conflict markers in hook files (#371)
  - Stale state files / phantom gates (#309)
  - OOM-prone process detection (#474)
- Session-start integration (run critical + important checks at session start)
- Incident log (`.claude/kaizen/health-log.jsonl`)

**Success criteria:**
- Conflict markers detected within 1 session start
- Stale state files cleared automatically with audit trail
- OOM-prone processes killed before agent crash

### Phase 2: Worktree Health + Auto-Cleanup

**Goal:** Prevent disk waste and worktree confusion.

**Deliverables:**
- Orphan worktree detection and archive-and-remove
- Stale worktree detection with configurable thresholds
- Integration with `/kaizen-cleanup` skill
- Worktree archive directory with recovery instructions

**Success criteria:**
- Zero orphan worktrees persisting more than 24 hours
- Disk reclaimed automatically from completed batch runs

### Phase 3: Batch Operation Health

**Goal:** Track and clean up distributed batch state.

**Deliverables:**
- Abandoned tracking issue detection
- Stuck PR detection and labeling
- Leftover worktree cleanup for merged/closed PRs
- Integration with batch operation lifecycle

**Success criteria:**
- Batch operation cleanup is automatic, not manual
- Stale tracking issues are labeled within 24 hours

### Phase 4: Full Declarative Registry

**Goal:** Make health checks a first-class, extensible system.

**Deliverables:**
- YAML registry format with full schema
- Registry validation (check definitions are well-formed)
- Custom check registration for host projects
- Health dashboard (summary command showing all check statuses)
- Integration with kaizen-reflect (health incidents as reflection data)

**Success criteria:**
- Adding a new health check requires only a YAML entry
- Host projects can register project-specific health checks
- Health check results are visible in kaizen reflections

---

## 7. Success Criteria

### Quantitative

1. **Zero incidents from corrupted state persisting more than 1 hour** for critical-severity checks (conflict markers, OOM)
2. **Zero incidents from corrupted state persisting more than 24 hours** for high-severity checks (stale state, dead locks)
3. **All health checks have corresponding repair actions** -- no detect-only checks without a repair path
4. **Health check overhead under 500ms** for session-start checks combined

### Qualitative

5. **Health check results feed into kaizen-reflect as data** -- incidents are not just logged, they inform process improvement
6. **Repair actions are safe** -- no data loss from automated repair; quarantine over delete
7. **The system heals itself without human intervention** for known corruption modes
8. **New corruption modes discovered by humans become health checks** -- the system learns from each new incident

---

## 8. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Repair actions make things worse** -- automated repair deletes something important | High | Conservative repair policy: quarantine (rename to `.broken`) rather than delete. Archive before remove. All repairs are idempotent. |
| **False positives cause unnecessary repairs** -- a state file is "stale" but actually in use by a slow operation | Medium | Configurable thresholds with conservative defaults. Check for owning PID before clearing state. Quarantine rather than delete. |
| **Health checks consume resources** -- the monitoring itself becomes a performance problem | Low | Detection commands must be cheap (grep, stat, find with -maxdepth). Expensive checks (build validation) run only at session start. Budget: 500ms total for all session-start checks. |
| **Circular failure** -- health check infrastructure itself breaks | Medium | Health checks are simple shell scripts with no dependencies on the systems they monitor. A broken hook can't prevent the health check from detecting that the hook is broken. |
| **Over-engineering** -- building a complex registry system when simple scripts would suffice | Medium | Phase 1 uses simple scripts. The registry (Phase 4) is only built after the pattern is proven by 3+ working checks. "Avoiding overengineering is not a license to underengineer. Build what the problem needs." |

---

## 9. What This PRD Is NOT

- **Not a monitoring/observability system** -- this is not Prometheus or Grafana. Health checks are internal, not external.
- **Not a replacement for enforcement hooks** -- enforcement prevents bad actions. Health checks detect bad state. Both are needed.
- **Not a horizon** -- self-healing is a capability, not a quality dimension. There is no "self-healing maturity ladder." Either the system can detect and repair corruption, or it cannot.
- **Not an implementation plan** -- implementation details come in `/kaizen-implement` after this PRD is accepted.

---

## 10. Relationship to Kaizen Philosophy

From the Zen of Kaizen:

> "No promises without mechanisms. 'Later' without a signal is 'never.'"

Today, recovery from corrupted state is a promise without a mechanism. "We'll notice and fix it" is not a mechanism. Health checks are the mechanism.

> "Enforcement is love. The hook that blocks you at 2 AM saves the human at 9 AM."

Health checks extend this principle: the check that detects corruption at 2 AM and repairs it automatically means no human is needed at 9 AM.

> "If it failed once, it's a lesson. If it failed twice, it needs a hook."

Issues #371, #309, #417, #474, and #469 are five different manifestations of the same lesson: the system cannot detect or repair its own corrupted state. Five occurrences is not a lesson -- it is a pattern that needs infrastructure.

> "The right level matters more than the right fix."

Self-healing is inherently Level 3 (mechanistic). Health checks that run automatically and repair without human intervention cannot be bypassed or forgotten. This is the right level for infrastructure integrity.
