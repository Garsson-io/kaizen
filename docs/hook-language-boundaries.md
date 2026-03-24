# Hook Language Boundaries — Decision Framework

> **Living document.** Updated as hooks are migrated and new patterns emerge.
> Epic: [Garsson-io/kaizen#223](https://github.com/Garsson-io/kaizen/issues/223)

## The Decision Rule

**If a script needs arithmetic on command output, error recovery from multi-step pipelines, or its own test file with assertions — it has crossed the boundary.** Move it to TypeScript.

**The strongest signal:** If you find yourself hand-rolling error handling or assertions in bash, you've reimplemented `try/catch` + `expect()` badly. That's TypeScript's job.

## Complexity Taxonomy

| Level                       | Characteristic                                                         | Language       | Examples                                                        |
| --------------------------- | ---------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| **L1: Guards**              | Check condition, pass/block. No data transformation.                   | Bash           | File exists? Branch has case? Working dir clean?                |
| **L2: Pattern matching**    | grep/sed on command output, simple conditionals                        | Bash           | Check if branch is merged, find files matching pattern          |
| **L3: Data transformation** | Arithmetic, counting, aggregation, multi-step pipelines with fallbacks | **TypeScript** | Branch statistics, disk usage calculation, error classification |
| **L4: Testable logic**      | Needs assertions, mocking, shared utilities, error recovery            | **TypeScript** | Test runners, complex validation, anything with >1 test file    |

## Why TypeScript (not other languages)

| Language         | Startup | Type safety | Test framework       | Already in stack | Verdict           |
| ---------------- | ------- | ----------- | -------------------- | ---------------- | ----------------- |
| Bash             | 0ms     | None        | None (hand-roll)     | Yes              | Keep for L1-L2    |
| TypeScript (tsx) | ~200ms  | Full        | vitest (1100+ tests) | Yes              | Use for L3-L4     |
| Python           | ~50ms   | Optional    | pytest               | No               | Adds a dependency |
| Deno             | ~100ms  | TypeScript  | Built-in             | No               | Another runtime   |

TypeScript wins: already the primary language, established test framework, ~200ms startup is irrelevant for hooks that run a few times per session.

## Current Hook Inventory

### Bash — Appropriate (L1-L2)

| Hook                          | Lines | Level | Notes                                    |
| ----------------------------- | ----- | ----- | ---------------------------------------- |
| `enforce-case-worktree.sh`    | 41    | L1    | Simple guard — advisory only             |
| `check-cleanup-on-stop.sh`    | 43    | L1    | Advisory worktree cleanup reminder       |
| `verify-before-stop.sh`       | 43    | L1    | Advisory test/typecheck reminder         |
| `capture-worktree-context.sh` | 69    | L1    | Writes `.worktree-context.json`          |
| `block-git-rebase.sh`         | 78    | L2    | Command interception                     |
| `pr-kaizen-clear-fallback.sh` | 81    | L2    | Fallback for clear gate edge cases       |
| `enforce-worktree-writes.sh`  | 82    | L2    | Path matching                            |
| `enforce-case-exists.sh`      | 114   | L2    | Git/case system integration              |
| `search-before-file.sh`       | 122   | L2    | Regex matching, config parsing           |
| `check-wip.sh`                | 145   | L2    | Multi-source WIP check                   |

### TypeScript — Migrated (L3-L4)

| Hook                     | Lines (TS) | Level | Migration                                                     |
| ------------------------ | ---------- | ----- | ------------------------------------------------------------- |
| `stop-gate.ts`           | 64         | L3    | Unified stop gate. #775. Wrapper: `kaizen-stop-gate.sh`       |
| `session-cleanup.ts`     | 71         | L2    | Stale state cleanup. #786. Wrapper: `kaizen-session-cleanup-ts.sh` |
| `enforce-pr-reflect.ts`  | 91         | L3    | Reflection gate enforcement. #775                             |
| `bump-plugin-version.ts` | 97         | L1    | Auto-bumps version before PR. #775                            |
| `post-merge-clear.ts`    | 121        | L2    | Clears post-merge gate. #786                                  |
| `enforce-pr-review.ts`   | 135        | L3    | Blocks all tools during review (Bash, Edit, Write, Agent). #775 |
| `check-dirty-files.ts`   | 192        | L3    | Dirty file check (block PR create, warn push). #775           |
| `pr-review-loop.ts`      | 336        | L4    | Multi-round PR self-review state machine. #320                |
| `kaizen-reflect.ts`      | 427        | L3    | Triggers reflection, sets gates, Telegram IPC. #320           |
| `pr-quality-checks.ts`   | 438        | L2    | Consolidated PR quality advisories (#8, #10, #89, #210). #800 |
| `pr-kaizen-clear.ts`     | 774        | L3    | Clears reflection gate on valid impediments JSON. #320        |

### Bash — Candidates for TypeScript Migration (L3-L4)

| Hook/Script              | Lines | Level | Migration Signal                                  |
| ------------------------ | ----- | ----- | ------------------------------------------------- |
| `scripts/worktree-du.sh` | ~300  | L3    | Arithmetic, data aggregation, caused an incident  |

### Shared Bash Libraries

| Library                        | Lines | Status                                    |
| ------------------------------ | ----- | ----------------------------------------- |
| `hooks/lib/read-config.sh`     | 36    | L1 — reads `kaizen.config.json`           |
| `hooks/lib/input-utils.sh`     | 69    | L1 — `read_hook_input`, `get_command`     |
| `hooks/lib/allowlist.sh`       | 74    | L2 — pattern matching, appropriate        |
| `hooks/lib/hook-output.sh`     | 66    | L1 — `emit_deny`, `render_prompt`         |
| `hooks/lib/scope-guard.sh`     | 79    | L1 — double-install protection            |
| `hooks/lib/hook-telemetry.sh`  | 102   | L1 — telemetry reporting                  |
| `hooks/lib/hook-timing-sentinel.sh` | 139 | L1 — performance monitoring            |
| `hooks/lib/parse-command.sh`   | 181   | L2 — regex matching, appropriate for bash |

### TypeScript Shared Libraries (new)

| Library                   | Lines | Purpose                                         |
| ------------------------- | ----- | ----------------------------------------------- |
| `src/hooks/hook-io.ts`    | ~35   | Read stdin JSON, write stdout — hook I/O layer  |
| `src/hooks/parse-command.ts` | ~100 | TS port of parse-command.sh — proper string ops |
| `src/hooks/state-utils.ts`  | ~130 | TS port of state-utils.sh — typed state files  |

## Migration Strategy

### Phase 1: Consolidate test infrastructure (DONE)

- [x] Extract shared test utils into `scripts/tests/lib/test-utils.sh`
- [x] DRY up duplicated assertions in `test-worktree-du.sh` and `test-resolve-cli-kaizen.sh`

### Phase 2: Document decision framework (DONE)

- [x] This document (`docs/hook-language-boundaries.md`)
- [x] CLAUDE.md policy section

### Phase 3: Migrate highest-value targets (DONE)

All high-complexity hooks migrated across kaizen #320, #775, #786, #800:

1. **`pr-review-loop.sh` (452 lines)** — **MIGRATED** → `src/hooks/pr-review-loop.ts` (336 lines) + vitest tests.
2. **`pr-kaizen-clear.sh` (290 lines)** — **MIGRATED** → `src/hooks/pr-kaizen-clear.ts` (774 lines) + typed JSON validation.
3. **`kaizen-reflect.sh` (197 lines)** — **MIGRATED** → `src/hooks/kaizen-reflect.ts` (427 lines) + Telegram IPC.
4. **`enforce-pr-review.sh` + `enforce-pr-review-tools.sh`** — **MIGRATED** → `src/hooks/enforce-pr-review.ts` (135 lines). Unified Bash/Edit/Write/Agent blocking.
5. **`enforce-pr-kaizen.sh`** — **MIGRATED** → `src/hooks/enforce-pr-reflect.ts` (91 lines).
6. **`check-dirty-files.sh`** — **MIGRATED** → `src/hooks/check-dirty-files.ts` (192 lines).
7. **3 stop hooks consolidated** — **MIGRATED** → `src/hooks/stop-gate.ts` (64 lines) + `src/hooks/lib/gate-manager.ts`.
8. **`post-merge-clear.sh`** — **MIGRATED** → `src/hooks/post-merge-clear.ts` (121 lines).
9. **PR quality checks (4 hooks)** — **MIGRATED** → `src/hooks/pr-quality-checks.ts` (438 lines). Consolidated.
10. **`worktree-du.sh` (~300 lines)** — Not yet migrated. Lower priority because bugs were fixed.

Shared infrastructure created:
- `src/hooks/hook-io.ts` — Stdin JSON parsing, git helpers, shell execution
- `src/hooks/parse-command.ts` — Command parsing (port of lib/parse-command.sh)
- `src/hooks/state-utils.ts` — State file management with atomic writes

Migration approach per script:

- Create TypeScript module in `src/hooks/`
- Port logic with proper types and error handling
- Add vitest tests (replacing hand-rolled bash tests)
- Thin bash wrapper (`-ts.sh`) calls `npx tsx` — registered in `plugin.json`
- Old bash scripts deleted after migration is wired up

### Phase 4: Evaluate escalation to L2

- Track incidents per language after migrations
- If agents still create complex bash scripts despite this doc, add a hook that checks script complexity

### Phase 5: Consider native TypeScript hooks

- When Claude Code supports TypeScript hooks natively (no bash wrapper needed)
- Eliminates the ~200ms tsx startup overhead
- Until then, bash wrappers are the interface layer

## Evidence That Motivated This

| Evidence                                                | What it proves                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `grep -cv \|\| echo "0"` produced `"0\n0"`              | Bash error handlers can corrupt data silently — no type system catches it                   |
| `run_capturing()` needed in tests                       | Bash has no native way to capture stdout, stderr, and exit code separately                  |
| `assert_eq`/`assert_contains` duplicated in 3 locations | No shared test utilities — each file rebuilt from scratch                                   |
| `SCRIPT_ERROR_PATTERN` regex scanning stderr            | Error detection is heuristic ("does stderr contain 'syntax error'?") not mechanistic        |
| `pr-review-loop.sh` at 452 lines                        | State machines in bash require manual round-tracking, file-based state, hand-rolled parsing |

## Design Decisions

**Q: Should TypeScript hooks use `tsx` (dev) or compiled JS (prod)?**
A: `tsx` — hooks aren't latency-sensitive, and it avoids build step complexity. If startup becomes a problem, compile as an optimization later.

**Q: Should we migrate `claude-wt.sh`?**
A: Not yet. It's L2-L3 boundary — orchestration but mostly delegating. Migrate when it breaks or grows.

**Q: Shared bash test utils: single file or library dir?**
A: Single file (`scripts/tests/lib/test-utils.sh`). Not enough variety for a directory yet.

**Q: Should the decision framework be enforced (L2 hook) or documented (L1)?**
A: Start L1 (this doc). Escalate to L2 if agents repeatedly create complex bash scripts.
