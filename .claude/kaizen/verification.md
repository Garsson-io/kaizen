# Verification Discipline

Learned from kaizen #11, #15, #17. These are mandatory practices for all dev work.

## Pre-Implementation Check — MANDATORY before writing utility code

Before writing ANY code that parses, transforms, or wraps a format/protocol/API, check if the problem is already solved:

```
1. CHECK package.json — is there already a dep for this? (`yaml`, `zod`, `ajv`, etc.)
2. GREP the codebase — does similar code exist? (`grep -r "YAML\|parse\|serialize" src/`)
3. SEARCH npm — is this a well-tested package with widespread adoption?
4. ASK: "What would a senior engineer reach for?" — not "what can I bang out fastest?"
```

**If a library exists in deps or on npm: use it.** Writing a hand-rolled parser, validator, or formatter when a tested library exists is not "keeping deps minimal" — it's creating MORE failure points. Policy #10 ("prefer simpler dependency stacks") means fewer ways to break, not fewer `package.json` entries.

**The anti-pattern:** You need to parse YAML. You think "it's a simple format, I'll use regex." You write 80 lines of fragile parsing. Self-review catches it. You rationalize "keeping deps minimal." You file it as a kaizen impediment instead of fixing it. The hand-rolled parser silently corrupts edge cases. *(This actually happened — kaizen #334.)*

**The fix:** Pause for 30 seconds before writing any utility code. Check what exists. Use it.

## Path Tracing — MANDATORY before any fix

Before writing ANY fix, map the full execution path from trigger to user-visible outcome:

```
1. MAP the chain: input → layer 1 → layer 2 → ... → user-visible outcome
2. For each link: how to verify it works, what artifact/log/query proves it
3. After the fix: verify EVERY link, not just the one you changed
4. Self-review must trace the path — "I changed layer N, what happens at N+1...?"
```

**Never fix a single layer and declare done.** The fix isn't complete until the final outcome is verified end-to-end.

## Invariant Statement — MANDATORY before writing tests

Before writing ANY test, state explicitly:

```
INVARIANT: [what must be true]
SUT: [exact system/function/artifact under test]
VERIFICATION: [how the test proves the invariant holds]
```

**Anti-patterns to avoid:**

- Testing mocks instead of real code (you're proving your mocks work, not your code)
- Testing the wrong artifact (e.g., `/app/dist/` when runtime uses `/tmp/dist/`)
- "All 275 tests pass" when none cover the actual change
- Verifying implementation details (`cpSync was called`) instead of outcomes (`agent has the tool`)
- Hardcoding values that the SUT computes (e.g., `PROJECT_ROOT="$REPO_ROOT"` bypasses testing path resolution)

**Meta tests — MANDATORY for infrastructure scripts:**
Scripts that resolve paths, detect environments, or set up state used by all subsequent logic MUST have tests that verify the resolution/detection itself — not tests that hardcode the resolved value and only test downstream logic. If a test bypasses the setup that the real script performs, it can't catch bugs in that setup. Examples:

- Path resolution: test that the output is absolute, points to the right directory, works from subdirectories and worktrees
- Environment detection: test that detection works in the actual environments it will run in (main checkout, worktree, background process)
- State initialization: test that initialization produces valid state, not just that functions work given pre-initialized state

## Runtime Artifact Verification

Always test the **actual deployed artifact**, not just source presence:

- If code is compiled, test the compiled output
- If code runs in a container, verify inside the container
- If a mount provides a file, verify the mount exists AND the consumer reads it
- "The file exists in the repo" is not verification — "the agent receives it at runtime" is

## Skill Change Policy — MANDATORY before modifying any SKILL.md (kaizen #959)

**Never change a skill without proving the change improves agent behavior.**

A skill change that isn't tested is speculation shipped as code. The structural tests in `src/e2e/skill-change.test.ts` are the enforcement mechanism — they fail until the required content is present.

### Every SKILL.md change requires:

1. **A structural test** — add to `src/e2e/skill-change.test.ts`:
   - Assert the new section/phrase exists in the file after the change
   - Must fail BEFORE the change, pass AFTER (TDD RED-GREEN discipline)

2. **A behavioral smoke test** (for changes that affect agent decision-making):
   - A `it.skipIf(!isLive)(...)` test in `src/e2e/skill-change.test.ts`
   - Uses `KAIZEN_SKILL_TEST=1 npx vitest run src/e2e/skill-change.test.ts`
   - Constructs a synthetic scenario where the OLD skill would fail
   - Runs `claude -p --plugin-dir . "[scenario]"` with the skill loaded
   - Asserts the NEW behavior in the output

3. **Before/after evidence in the PR body** — required sections:
   ```
   ## Skill Change Evidence
   Old behavior: [what the skill did before — quote or describe]
   New behavior: [what the skill does now — confirmed by smoke test run]
   Smoke test output: [paste actual output or link to CI run]
   ```

4. **Dual failure mode documentation** — for behavioral constraints:
   - If absent: [what goes wrong]
   - If present (over-correction risk): [what valid behavior might be blocked]

### Anti-patterns

- "Deferred to #NNN" for behavioral E2E tests — NOT acceptable. If you can't test the change now, don't make the change now.
- "The change is obvious" — obvious changes still need structural tests.
- "I'll add tests in a follow-up" — the follow-up never comes. The test is part of the change.

### Running skill tests

```bash
# Structural only (fast, no LLM, runs in CI):
npx vitest run src/e2e/skill-change.test.ts

# Full behavioral (requires KAIZEN_SKILL_TEST=1, uses haiku, ~$0.01/test):
KAIZEN_SKILL_TEST=1 npx vitest run src/e2e/skill-change.test.ts
```

## Smoke Tests — MANDATORY when review identifies them

When a PR review says a smoke test is needed, **you must perform it before declaring the PR ready**. "Pending manual smoke test" is not an acceptable review outcome — it means the review is incomplete.

Smoke test checklist:

1. **Identify what to smoke test** — the review will name the untested path (e.g., "never hit real GitHub API", "never ran in container")
2. **Run it** — execute the actual end-to-end path. If it requires credentials or infrastructure you don't have, ask the user to provide them or run the test together.
3. **Record the result** — include the smoke test output (success or failure) in the PR or review comment.
4. **If you can't smoke test** — explicitly state what's blocking and ask the user. Don't hand-wave it as "recommended before deploy."

The point of review is to catch gaps. A gap identified but not closed is not a review — it's a TODO list.

## Stall Detection Principle — crashes and stalls need separate handling

Discovered during batch-260321-1108-3ef8 analysis. Stalls and crashes are fundamentally different failure modes requiring separate detection mechanisms. This applies to every autonomous process boundary in the system.

| Property | Crash | Stall |
|----------|-------|-------|
| Signal | Exit code, error message, stack trace | Silence — no output, no exit |
| Self-healing | Failure counters, retry logic, circuit breakers | None without explicit timeout/watchdog |
| Detection | Automatic (process exits, error handlers fire) | Requires liveness probes or timeout wrappers |
| Risk | Known and bounded — system handles it | Unbounded — consumes infinite time silently |
| Analogy | Kubernetes readiness probe fails | Kubernetes liveness probe fails |

**The rule:** Every autonomous process boundary must have BOTH:
1. **Crash handling** — exit code check, retry with backoff, circuit breaker
2. **Stall handling** — timeout wrapper, liveness probe, progress watchdog

**Where this applies in kaizen:**
- **Overnight-dent batch runner:** crash → failure counter → next run; stall → infinite hang → no signal (fixed by timeout wrappers)
- **Hook execution:** crash → error log → hook skipped; stall → blocks all subsequent hooks (need per-hook timeout)
- **Test runners in agents:** crash → test failure reported; stall → agent hangs forever (must use `timeout N` wrapper — see kaizen #359)
- **Container agents:** crash → container restart; hang → needs external watchdog (see kaizen #358)

**The anti-pattern:** Building only crash handling and assuming stalls can't happen. Every I/O boundary (network, filesystem, subprocess) can stall. If you only handle crashes, stalls will be your most expensive failure mode — they waste time silently instead of failing loudly.

**Practical check:** When reviewing any code that spawns subprocesses or makes network calls, ask: "What happens if this never returns?" If the answer is "we wait forever," add a timeout.
