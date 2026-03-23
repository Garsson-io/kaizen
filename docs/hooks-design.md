# Hooks Design — Patterns, Anti-Patterns, and Lessons Learned

This document captures hard-won knowledge about the Claude Code hooks system. It's the reference for anyone writing, debugging, or maintaining hooks. Last verified: 2026-03-22.

## Architecture

### Two Independent Systems: Permissions vs Hooks

Claude Code has two enforcement layers that are often confused:

| System | Flag to bypass | What it does |
|--------|---------------|--------------|
| **Permissions** | `--dangerously-skip-permissions` | Auto-approves built-in "Allow this tool?" prompts |
| **Hooks** | `--bare` | Disables custom PreToolUse/PostToolUse/Stop scripts |

**Critical:** `--dangerously-skip-permissions` does NOT bypass hooks. Custom hook `permissionDecision: "deny"` responses still fire and block. This was discovered in kaizen #323 when overnight-dent runs (which use `--dangerously-skip-permissions`) were still blocked by kaizen gates.

`--bare` disables hooks BUT also disables CLAUDE.md, skills, LSP, and other infrastructure. It's a nuclear option, not a surgical one.

### Hook Event Lifecycle

```
User/Agent action
  → PreToolUse hooks fire (can DENY — blocks the action)
  → Tool executes (if not denied)
  → PostToolUse hooks fire (advisory — can set gates but not block retroactively)
  → Stop hooks fire (when agent tries to finish — can block completion)
```

### Gate Pattern

Gates are the primary control flow mechanism:

1. **PostToolUse** creates a state file (e.g., `needs_pr_kaizen`)
2. **PreToolUse** checks for the state file and denies non-allowlisted commands
3. An allowlisted action clears the state file
4. **Stop** hook prevents the agent from finishing with pending gates

This creates a "you must do X before you can do Y" enforcement.

## Writing Hooks

### Language Boundaries

See [`hook-language-boundaries.md`](hook-language-boundaries.md) for the full policy. Summary:

- **TypeScript** is the default for all hook logic. Testable, type-safe, and maintainable.
- **Bash shims** (~5 lines) are the execution entry point that Claude Code invokes. They delegate to TS.
- **Remaining bash hooks** (advisory-only: check-test-coverage, check-verification, etc.) are simple enough to stay in bash. Any hook with branching logic or state management should be in TypeScript.
- Never mix languages within a single hook's logic — use a trampoline.

### Trampoline Pattern

All enforcement hooks use a thin bash wrapper that delegates to TypeScript:

```bash
#!/bin/bash
# kaizen-some-hook-ts.sh — trampoline to TypeScript implementation
source "$(dirname "$0")/lib/scope-guard.sh"
KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec npx --prefix "$KAIZEN_DIR" tsx "$KAIZEN_DIR/src/hooks/some-hook.ts" 2>/dev/null
```

The bash shim handles scope-guard and kaizen dir resolution. The TypeScript file handles all logic, reads stdin JSON, and writes stdout JSON. This makes the logic fully testable with vitest.

### Hook Testability (kaizen #775)

TypeScript hooks follow a pattern that separates the testable core from the entry point:

```typescript
// Testable pure function — injected dependencies, no I/O
export function processHookInput(command: string, branch: string, stateDir?: string): Result { ... }

// Entry point — thin glue, not tested directly
async function main(): Promise<void> {
  const input = await readHookInput();
  const branch = getCurrentBranch();
  const result = processHookInput(input.tool_input?.command ?? '', branch);
  // ... write output
}
```

Shared utilities live in `src/hooks/hook-io.ts` (stdin/stdout, getCurrentBranch), `src/hooks/lib/allowlist.ts` (command allowlists), and `src/hooks/lib/gate-manager.ts` (unified stop gate logic).

### Regex Patterns — The Alternation Trap

**Anti-pattern (kaizen #323):**
```bash
grep -qE "^git[[:space:]]+${subcommand}"
# Where subcommand="diff|log|show|status|branch|fetch"
# Expands to: ^git[[:space:]]+diff|log|show|status|branch|fetch
# The | is top-level alternation! "branch" matches ANYWHERE in the string
```

**Correct pattern:**
```bash
grep -qE "^git[[:space:]]+(${subcommand})"
# Parentheses group the alternation: ^git[[:space:]]+(diff|log|show|...)
```

This bug caused `gh pr merge --delete-branch` to pass through readonly monitoring (the `branch` in `--delete-branch` matched the bare `branch` alternative). Always wrap variable alternation patterns in parentheses.

### Allowlist Design

When a gate blocks commands, it needs an allowlist of commands that ARE permitted during the gate.

**Principles:**
- Allowlist by **intent**, not by syntax. "PR workflow commands" not "commands containing `gh pr`"
- Include **all variants** of an allowed action. `gh pr merge 42`, `gh pr merge URL`, `gh pr merge --squash` are all the same intent
- **Segment-split** before matching (kaizen #172). Commands chained with `|`, `&&`, `;` must have each segment checked independently. Otherwise `npm build && echo KAIZEN_IMPEDIMENTS:` bypasses the gate
- Use `is_gh_pr_command`, `is_git_command` helpers — they handle segment splitting

### State File Conventions

- **Location:** `$STATE_DIR` (defaults to `/tmp/.pr-review-state/`)
- **Format:** `KEY=value` lines (parseable with `grep` + `cut`)
- **Required fields:** `PR_URL`, `STATUS`, `BRANCH`
- **Branch scoping:** State files include `BRANCH=` so hooks can filter to the current worktree
- **Cross-branch lookup:** Active declarations (KAIZEN_IMPEDIMENTS) use `_any_branch` variants since the agent may submit from a different worktree
- **Staleness:** Files older than `MAX_STATE_AGE` (2 hours) are ignored

### Testing Hooks

**TypeScript hooks (preferred):**
- Each TS hook has a co-located `.test.ts` file (e.g., `enforce-pr-review.test.ts`)
- Tests use injected `stateDir` and `currentBranch` params — no real filesystem or git needed
- Run with `npx vitest run src/hooks/`

**Bash hooks (legacy/advisory):**
- Each bash hook has `test-{hook-name}.sh` in `.claude/hooks/tests/`
- Integration tests: `test-hook-interaction-matrix.sh` tests cross-hook behavior
- Run with `npm run test:hooks`

**Shared principles:**
- **Test isolation:** Tests override `STATE_DIR` to a temp directory. Never rely on real state files
- **Mock `gh`:** Create a mock `gh` script in a temp dir and prepend to `PATH`
- **Always test both paths:** the "allowed" path AND the "denied" path
- **Shared lib changes require E2E tests:** Use `SessionSimulator` (`src/e2e/session-simulator.ts`) to fire hooks in session order with controlled environments
- **TypeScript E2E harness:** `src/e2e/hook-runner.ts` provides event builders, `runHook()`, and mock utilities

## Anti-Patterns

### 1. Assuming `--dangerously-skip-permissions` Disables Hooks
It doesn't. See "Two Independent Systems" above.

### 2. Unparenthesized Regex Alternation
`grep -qE "^prefix${var}"` where `var` contains `|` creates top-level alternation. Always use `(${var})`.

### 3. Gate Without Allowlist
A gate that blocks ALL commands forces the agent to clear the gate before doing anything — including commands needed to clear the gate. Always include the clearing action in the allowlist.

### 4. Branch-Scoped Lookup for Active Declarations
When an agent actively submits something (KAIZEN_IMPEDIMENTS), use `_any_branch` variants. The agent may have switched worktrees since the gate was created.

### 5. Testing Against Real State
Tests that don't override `STATE_DIR` will interact with real gates from other sessions, producing flaky results that depend on system state.

### 6. Silent Failures in Advisory Hooks
PostToolUse hooks that set gates should log what they're doing. Silent gate creation leads to mysterious blocks later.

### 7. Heavy Subprocesses in Accumulating Hooks (#474)
Never spawn heavy subprocesses (vitest, tsc, npm test, npx) in hooks that can fire multiple times without blocking the AI. Stop hooks retry on exit 2, PostToolUse hooks fire on every tool call, advisory PreToolUse hooks don't block — all of these can accumulate unboundedly.

**Safe:** PreToolUse hooks that deny (blocks AI, prevents re-invocation).
**Unsafe:** Stop hooks, PostToolUse hooks, any hook that doesn't prevent further invocations.

For unsafe positions, use the **marker pattern**: a skill or explicit tool call does the heavy work and writes a marker file. The hook only checks the marker.

### 8. Blocking ALL Tools to Force a Fix (#758)

A hook that blocks every tool call (including Bash, Edit, Write, and Stop) to force the user to take a corrective action creates an **unescapable deadlock**: the agent cannot run the fix because the fix itself is blocked.

**Wrong:** Detect bad state → print fix instructions → `exit 2` (blocks all tools)

```bash
# WRONG — agent cannot run the fix command; user must escape to a separate terminal
if [ "$bad_state" = "yes" ]; then
  echo "FIX: run python3 ..." >&2
  exit 2   # blocks everything, including the fix command
fi
```

**Correct:** Detect bad state → auto-fix it → warn via stderr → `return 0` (allow through)

```bash
# CORRECT — fix it automatically, warn, continue
if [ "$bad_state" = "yes" ]; then
  python3 -c "...fix script..."   # self-heal
  echo "[kaizen] WARNING: auto-fixed bad state" >&2
  return 0   # allow the tool call through
fi
```

The rule: **if a hook detects a state that needs fixing, fix it — don't just describe the fix and block**. A warning on stderr (exit 0) informs without trapping.

**Also applies to lint rules:** Code quality checks (detecting anti-patterns in source files) belong in **ESLint / `npm run lint` / CI**, never in a PreToolUse(Bash) hook. A hook fires on every tool call; a lint rule fires only when source files change. Wrong tool for the job produces noise and latency without benefit.

## Lessons Learned

| Incident | Lesson | Kaizen |
|----------|--------|--------|
| `--delete-branch` matched `branch` in regex | Always parenthesize regex alternation variables | #323 |
| `--dangerously-skip-permissions` didn't bypass gates | Permissions and hooks are independent systems | #353 |
| Stop hook ran vitest/tsc, OOM in 60s | No heavy subprocesses in hooks that can accumulate | #474 |
| Gate re-fired 3x for same PR in one session | Per-PR reflection markers needed | #288 |
| Cross-worktree gate clearing failed | Active declarations need `_any_branch` lookup | #239 |
| `npm build && echo KAIZEN_IMPEDIMENTS:` bypassed gate | Segment-split before matching | #172 |
| Hook tests flaky due to real state files | Always override `STATE_DIR` in tests | #309 |
| scope-guard blocked ALL tools → 10-message deadlock | Auto-fix bad state; warn don't block; lint ≠ hook | #758 |
