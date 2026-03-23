# PRD: The Poison Pill Problem — Agent Self-Diagnosis, Test Hermeticity, and Fractal Debugging

**Issue:** [Garsson-io/kaizen#681](https://github.com/Garsson-io/kaizen/issues/681)
**Author:** Aviad + Claude (post-incident analysis)
**Date:** 2026-03-23
**Status:** Draft
**Horizon:** [Autonomous Batch Operations](horizons/autonomous-batch-operations.md), [Agent Governance](horizons/agent-governance.md)

---

## 1. Problem Statement

### An agent wrote a test that hung its own pipeline for 2.5 hours

On 2026-03-23, auto-dent batch `batch-260323-0003-072b` run 73 created a new module (`reflection-persistence.ts`) with tests. One test verified error handling by writing to `/proc/invalid/path`:

```typescript
it('silently handles write errors without throwing', () => {
  expect(() =>
    persistReflection(
      buildReflectionRecord({ ... }),
      { telemetryDir: '/proc/invalid/path' },
    ),
  ).not.toThrow();
});
```

On native Linux, `mkdirSync('/proc/invalid/path', { recursive: true })` fails fast with EPERM. On WSL2 — the actual runtime environment — the syscall hangs. The synchronous call blocked the vitest worker at 105% CPU. The agent retried vitest five times with different flags, each spawning a new hanging worker, burning 2.5 hours before the run was killed.

### The failure was fractal

The same pattern repeated at every level of the system:

| Level | Actor | Failure | Duration |
|-------|-------|---------|----------|
| **Agent (run 73)** | Claude writing code | Wrote a test that hangs, then retried without questioning its own code | 2.5 hours |
| **Debugger (Claude)** | Claude analyzing the incident | Read the `/proc` line three times, dismissed it, chased vitest config and TypeScript compilation theories | 30 minutes |
| **Human (Aviad)** | Had to Socratically guide both agents to the answer | Said "read the file" three times before the debugger identified the issue | Multiple messages |

The same cognitive failure — trusting a mental model over observable code — cascaded through three levels of the system. The agent trusted that its test was correct. The debugger trusted that `/proc` would fail fast. Neither questioned the obvious suspicious thing in the code.

### The asymmetry

It took the agent seconds to write `{ telemetryDir: '/proc/invalid/path' }`. It cost:
- 2.5 hours of pipeline time (run 73)
- 30 minutes of debugging time (human + debugger Claude)
- ~$15-30 in API costs (73 runs worth of context)
- 83 worktrees of accumulated state
- A batch that produced no PR for its final run

One line. One untested assumption about how `/proc` behaves on WSL2. 1000x amplification in wasted effort.

---

## 2. Lessons

These lessons operate at different altitudes. Some are concrete ("don't write to /proc in tests"). Some are structural ("agents need self-skepticism mechanisms"). Some are philosophical ("your model of the world is not the world"). All are real. The concrete ones are easier to implement. The philosophical ones are more important.

### Lesson 1: Tests must be inert

A test that can hang the pipeline is a liability, not an asset. The severity hierarchy:

1. **Assertion failure** — good, informative, recoverable
2. **Exception/crash** — acceptable, noisy, recoverable
3. **Hang** — catastrophic, silent, blocks everything downstream

The `/proc` test sat at level 3. Any test that provokes errors from real system boundaries (`/proc`, `/sys`, `/dev`, network endpoints, kernel interfaces) instead of injecting controlled failures can potentially hang.

**The principle:** Test error handling with controlled injection, not environmental provocation. Mock the failure; don't rely on the OS to produce it. The OS is not your test fixture.

### Lesson 2: Suspect your own code first

Agent 73 tried five vitest incantations but never questioned its own test. It assumed the environment was broken and the test was correct. This is a deep pattern: agents trust their own output. Once code is written, it becomes "the code" rather than "something I just generated that might be wrong."

The debugging Claude exhibited the same pattern: read the suspicious `/proc` line, dismissed it based on Linux knowledge, and spent 30 minutes on complex hypotheses about vitest internals.

**The principle:** When your new code doesn't work, the Bayesian prior is overwhelmingly that your new code is wrong. Not the framework. Not the environment. Not the runtime. Your code. The newer it is, the more you should suspect it.

### Lesson 3: Bisect, don't retry

Run 73 retried vitest five times with different flags. Each retry cost 5+ minutes and taught nothing. One bisection (run half the tests, then the other half) would have identified the hanging test in 2 minutes.

The debugging Claude did the same: proposed complex hypotheses and ran broad investigations instead of the minimal reproducer.

**The principle:** Retrying with different flags is hoping the problem changes. Bisecting is forcing the problem to reveal itself. When something fails, narrow down. Don't vary the invocation; vary the input.

### Lesson 4: Hangs need active detection, not passive waiting

A process that crashes returns an error code. A process that hangs returns nothing. The auto-dent harness had no mechanism to detect a hanging vitest — it just waited for the subprocess to return. When it didn't, the agent's 2-minute bash timeout kicked in, but the agent's response was to retry rather than diagnose.

**The principle:** Silence is not progress. Every subprocess invocation in an automated system needs a wall-clock timeout with a diagnostic action on expiry, not just a retry.

### Lesson 5: The failure mode is fractal

The same reasoning error repeated at three abstraction levels: agent, debugger, only resolved by human guidance. This means the fix cannot be at one level. "Tell agents to be more careful" is L1, and L1 already failed — at multiple levels simultaneously.

**The principle:** When a failure mode reproduces at different abstraction levels, the fix must be mechanistic (L2/L3), not instructional (L1). The agents at every level had the information needed to solve the problem. They lacked the cognitive pattern to act on it.

### Lesson 6: Your model of the world is not the world

The debugging Claude "knew" that `mkdirSync` to `/proc` returns EPERM synchronously. This knowledge was correct for native Linux and wrong for WSL2. The agent "knew" its test was correct. Both substituted theory for observation.

**The principle:** When debugging, the first question is "what does the code actually do?" not "what should the code do based on my understanding of the platform?" Specs are hypotheses. Runtime behavior is data. When they conflict, trust the data. (This is already in the Zen, but the incident proves it's not operationalized.)

### Lesson 7: Creation-destruction asymmetry demands gatekeeping

One line of code created 2.5 hours of waste. This asymmetry is inherent in automated systems: it's cheap to produce code and expensive to diagnose broken code. The asymmetry is amplified when the broken code doesn't crash (which would be fast to detect) but hangs (which can burn time silently for hours).

**The principle:** The cheaper creation is, the more gatekeeping matters. An auto-dent agent that can create and run tests in seconds needs a proportionally strong mechanism to detect when those tests are unsafe.

### Lesson 8: The guidance gap

The human solved this faster than two Claude instances because they used Socratic method: "read the file," "is it the test from run 72?", "how can you test your hypothesis?" Each question narrowed the search space. The agents, by contrast, explored broadly — checking vitest configs, process trees, TypeScript compilation.

**The principle:** The ability to question your own output is not a personality trait. It's a skill that can be scaffolded. The system needs structures that force agents to ask "what could be wrong with what I just wrote?" before running it.

---

## 3. Scope

We want to address this at multiple levels. The concrete mechanisms are easy to build and will prevent this specific class of failure. The structural mechanisms are harder but will prevent broader classes. The philosophical principles should guide future decisions, skills, and zen principles.

### 3.1 Concrete: Test hermeticity enforcement (L2)

These are practical mechanisms that prevent tests from interacting with dangerous system paths.

- **Static lint for system paths in test files**
  - Scan `.test.ts` files for references to `/proc/`, `/sys/`, `/dev/` (except `/dev/null`)
  - Also flag raw network calls (`http://`, `https://`), `process.kill`, `process.exit` in test files
  - Implement as: PreToolUse hook on file write, or pre-commit check
  - Default: **block** with explanation. Not advisory — a test that can hang is not shippable
  - Edge cases: allow `/dev/null` (safe), flag `/dev/urandom` (safe but suspicious)

- **Vitest timeout enforcement**
  - Add `testTimeout: 10000` (10s) and `hookTimeout: 10000` to `vitest.config.ts`
  - This is vitest's built-in mechanism — we're just not using it
  - For synchronous hangs (like `mkdirSync` blocking): this won't help because vitest's timeout only applies to async tests
  - Therefore also: wrap vitest invocations in the auto-dent harness with a 60-second wall-clock `timeout` command
  - If timeout fires: kill the process tree (not just the parent — kill the worker too), and **skip** rather than retry

- **Subprocess tree cleanup**
  - When killing a vitest invocation, kill the entire process group, not just the parent
  - Vitest forks workers that become orphans if only the parent is killed
  - The auto-dent harness should use `kill -- -$PGID` (process group kill) on timeout
  - This prevents accumulation of 105% CPU orphaned workers

### 3.2 Concrete: Bisection before retry (L2)

When a test run fails or hangs, the harness should narrow down rather than retry wholesale.

- **Auto-bisect on hang**
  - If `vitest run <file>` times out, run `vitest run <file> --testNamePattern <first-half>` and `--testNamePattern <second-half>`
  - If the entire file hangs on import (no test output at all), try running just the imports via `tsx -e "import './file.js'"` to isolate module-level hangs
  - Present the narrowed-down result to the agent: "test X in file Y caused a hang" rather than "vitest timed out"

- **Test file canary**
  - Before running a new test file for the first time, run a trivial canary: `vitest run <file> --testNamePattern '^$'` (matches no tests, but loads the module)
  - If the canary hangs, the problem is in module loading, not in test execution
  - Time budget: 15 seconds for the canary

### 3.3 Structural: Agent self-skepticism scaffolding (L1.5 to L2)

These mechanisms force agents to question their own code before running it.

- **Pre-run self-review prompt** (L1.5 — expectations)
  - Before running a test file the agent just wrote, inject a prompt: "Review the test file you just created. Are any tests interacting with real system paths, kernel interfaces, or external services? Could any test hang instead of failing?"
  - This is L1.5 because it structures the agent's attention without mechanistically blocking
  - Implement as: a step in the kaizen-implement skill, or as a hook that fires when a new `.test.ts` file is staged
  - TBD by eng: whether this is a separate prompt or a section in the implementation skill

- **"Suspect your own code" protocol** (L1 — instructions)
  - Add to CLAUDE.md / workflow docs: "When a subprocess fails or hangs after you created new code, the first hypothesis is always: your new code caused the failure. Examine your code for hanging operations before retrying the subprocess."
  - This is L1 and will be forgotten. It's here as a stopgap until L2 mechanisms exist.
  - **Expected to fail within weeks.** When it does, escalate to L2. (Per Zen: "If it failed once, it's a lesson. If it failed twice, it needs a hook.")

- **Post-creation file review hook** (L2 — enforcement)
  - When an agent creates a new `.ts` or `.test.ts` file and then runs a shell command, a PostToolUse hook scans the new file for:
    - Writes to system paths (`/proc`, `/sys`, `/dev`)
    - Synchronous operations that could block (`execSync` with no timeout, `mkdirSync` on special filesystems)
    - Unguarded `process.exit` or `process.kill` calls
  - Output: advisory warning (not blocking, since false positives are likely), but logged to telemetry for analysis
  - If the pattern proves reliable (low false positives after 2 weeks), escalate to blocking

### 3.4 Structural: Harness resilience (L2/L3)

These protect the auto-dent pipeline from hanging subprocesses regardless of cause.

- **Per-run wall-clock budget**
  - Each auto-dent run gets a maximum wall-clock budget (default: 20 minutes, configurable)
  - If exceeded: kill all child processes, log the timeout, increment `consecutive_failures`, move to next run
  - Currently the harness has no per-run timeout — it waits indefinitely for the Claude process to exit
  - This is L3 (mechanistic) — the agent cannot bypass it because it runs in the harness, not in the agent

- **Subprocess timeout cascade**
  - All `Bash` tool calls within auto-dent runs should have a maximum timeout of 120 seconds
  - vitest specifically: 60 seconds (tests should complete in <10s; 60s is generous)
  - `npm install`: 180 seconds (legitimate slow operation)
  - `gh` commands: 30 seconds
  - Timeouts should be enforced by the harness, not by the agent (L3)

- **Diagnostic output on timeout**
  - When a subprocess is killed by timeout, capture:
    - Which command was running
    - Which files were recently created or modified
    - The process tree (to catch orphaned workers)
    - The last N lines of stdout/stderr
  - Write this to the run log as structured data so post-batch analysis can identify patterns

### 3.5 Vague: Philosophical directions

These are not implementable as features. They are orientations that should inform future decisions, skills, and zen principles.

- **"Your model of the world is not the world"**
  - This is already implicit in the Zen ("Specs are hypotheses. Incidents are data.") but needs to be operationalized for agent self-debugging. When an agent's understanding of how something works conflicts with what's actually happening, the agent should update its understanding, not retry with the same assumption.
  - Direction: Skills that involve debugging should explicitly include a step: "State your assumption about what's happening. Now test that assumption directly." This forces the agent to make its mental model explicit and falsifiable.

- **"The fractal failure demands fractal defense"**
  - When the same cognitive failure (trusted theory over observation) happened at agent level AND debugger level, it reveals a systemic blind spot, not an individual mistake. Individual fixes ("tell agents to check /proc paths") won't prevent the next fractal failure with a different trigger.
  - Direction: The system needs *cognitive diversity* in its debugging. When an agent retries the same approach 3 times, the harness should inject a prompt: "You've tried this approach 3 times. Consider: what if your code is the problem, not the environment?" This is a structural interruption of tunnel vision, applicable to any failure, not just `/proc` paths.

- **"The cheaper creation is, the more gatekeeping matters"**
  - Auto-dent agents produce code fast. That's the point. But speed of creation without proportional gatekeeping means speed of damage. The asymmetry will always exist — creation is inherently cheaper than diagnosis. The system should be biased toward making diagnosis fast (structured timeouts, automatic bisection, diagnostic output) rather than making creation slow (excessive pre-checks that reduce throughput).
  - Direction: Invest in diagnostic infrastructure (fast bisection, structured timeout output, post-mortem tooling) proportional to the rate of code creation. As auto-dent throughput increases, diagnostic capability must increase in proportion.

- **"Silence is the worst failure mode"**
  - A crash tells you something went wrong. A hang tells you nothing. The system should be biased toward making failures loud rather than preventing them. A test that crashes with "EPERM writing to /proc" is infinitely better than a test that hangs silently. When choosing between "catch all errors silently" and "fail fast with a message," prefer the message.
  - Direction: Audit existing `try/catch` blocks that swallow errors silently (the very pattern that made `persistReflection` "best-effort"). These are correct for production hooks (don't break the pipeline) but dangerous in tests (mask the real failure). Consider: should test-mode code paths be more aggressive about surfacing errors?

- **"Socratic debugging as a first-class skill"**
  - The human solved this faster than two Claude instances because they used Socratic method: "read the file," "is it the test from run 72?", "how can you test your hypothesis?" Each question narrowed the search space. The agents, by contrast, explored broadly — checking vitest configs, process trees, TypeScript compilation.
  - Direction: A debugging skill (`/kaizen-debug` or similar) that scaffolds Socratic questioning: "What changed? What's new? What's suspicious? What's your assumption? How would you test it?" This imposes the cognitive structure that the human provided manually.

---

## 4. Out of Scope

- **Sandboxing test execution in containers/VMs** — This would solve the `/proc` problem mechanistically (container's `/proc` is isolated) but is disproportionate for the current system. Can be revisited when the auto-dent harness moves to cloud execution. Currently, WSL2 is the runtime and we should work within its constraints.

- **Banning synchronous filesystem operations in tests** — Too broad. Most tests legitimately use `mkdirSync`, `writeFileSync`, `readFileSync` for test fixtures. The problem is not synchronous IO; it's synchronous IO to dangerous paths.

- **Automated root-cause analysis of hangs** — Instrumenting vitest to report "which line is blocking" requires vitest internals modification. We can detect hangs and bisect to the test level, but not to the line level. Line-level debugging remains a human/agent task.

- **Preventing agents from writing bad code** — This is the wrong framing. Agents will always produce some bad code. The system's job is to detect it quickly and fail loudly, not to prevent it. Prevention at the creation stage kills throughput; detection at the execution stage preserves it.

---

## 5. To Be Investigated

- **WSL2 `/proc` behavior:** Why does `mkdirSync('/proc/invalid/path', { recursive: true })` hang on WSL2? Is this a known WSL2 kernel bug? Does it affect other paths under `/proc`? Does it happen with `fs.mkdir` (async) as well, or only `mkdirSync` (sync)? This should be investigated and filed upstream if it's a kernel bug. **Owner: eng**

- **Vitest worker orphan behavior:** When a vitest parent is killed (e.g., by SIGPIPE from `| head`), the forked worker continues at 105% CPU. Is this a vitest bug or expected Node.js fork behavior? Does vitest's `--pool=threads` mode avoid this? Should we switch from forks to threads? **Owner: eng**

- **Test-mode error surfaces:** Several kaizen modules use `try { ... } catch { /* silent */ }` for "best-effort" behavior. This is correct in production hooks (don't break the pipeline) but dangerous in tests (mask the real failure). Should we add a `KAIZEN_TEST_MODE` env var that makes these throw instead of swallow? **Owner: eng, TBD on whether this adds more complexity than it removes**

---

## 6. Proposed Zen Additions

This incident reveals a gap in the Zen: there is no principle about self-skepticism or the relationship between creation speed and diagnostic investment. We propose adding:

```
The code you just wrote is the code most likely to be wrong.
Suspect the new before blaming the known.
```

**Why:** Agents (and humans) consistently exhibit a bias toward trusting their own output and suspecting the environment. This principle names the bias and inverts the default. It connects to "Specs are hypotheses. Incidents are data" but is more specific: it's not about specs vs incidents, it's about *your code* vs *everything else*.

**Provenance:** Auto-dent batch-260323-0003-072b run 73. Agent wrote a test with `/proc/invalid/path`, spent 2.5 hours retrying vitest without questioning the test. Debugging Claude read the same line three times and dismissed it. Human identified the issue by saying "read the file."

And:

```
A test that can hang is worse than no test at all.
Crashes are signals. Hangs are silence. Silence is the enemy.
```

**Why:** The severity hierarchy (assertion failure < crash < hang) is not intuitive. Developers and agents both treat "doesn't crash" as success, but a hang that blocks the pipeline for hours is far more costly than a crash that fails in milliseconds. This principle reframes hanging as the worst outcome, not an intermediate one.

**Provenance:** Same incident. The test was designed to verify that `persistReflection` doesn't throw. It succeeded — it didn't throw. It hung instead. The test's success criterion ("not.toThrow()") was satisfied vacuously because the code never returned.

---

## 7. Implementation Sequence

We want to ship the highest-leverage, lowest-effort items first. Ordered by impact/effort ratio:

| Priority | Item | Level | Effort | Impact |
|----------|------|-------|--------|--------|
| **P0** | Add `testTimeout: 10000` to `vitest.config.ts` | L3 | 1 line | Prevents async test hangs |
| **P0** | Add 60-second wall-clock `timeout` to vitest invocations in auto-dent harness | L3 | ~5 lines | Prevents sync test hangs from blocking runs |
| **P0** | Process group kill on timeout (kill workers, not just parent) | L3 | ~10 lines | Prevents orphaned workers |
| **P1** | Static lint for `/proc`, `/sys` in test files | L2 | ~30 lines (hook) | Prevents this exact class of test |
| **P1** | Per-run wall-clock budget in auto-dent harness (20 min default) | L3 | ~20 lines | Prevents any single run from burning hours |
| **P1** | "Suspect your own code" protocol in CLAUDE.md | L1 | Documentation | Stopgap; expected to need escalation |
| **P2** | Auto-bisect on vitest timeout | L2 | ~50 lines | Turns "vitest hangs" into "test X hangs" |
| **P2** | Diagnostic output on subprocess timeout | L2 | ~30 lines | Enables post-mortem analysis |
| **P2** | Retry-limit with prompt injection ("you've retried 3 times...") | L1.5 | ~20 lines (hook) | Interrupts tunnel vision |
| **P3** | Pre-run self-review prompt for new test files | L1.5 | Skill modification | Scaffolds self-skepticism |
| **P3** | Zen additions (self-skepticism, hang severity) | L1 | Documentation | Long-term orientation |
| **P3** | `/kaizen-debug` Socratic debugging skill | L1.5 | New skill | Scaffolds systematic debugging |

P0 items should ship immediately — they're small, mechanistic, and prevent the exact incident that occurred. P1 items should ship within the next batch cycle. P2/P3 are structural improvements that pay off over time.

---

## 8. Success Criteria

**Short-term (1 week):**
- No auto-dent run exceeds 20 minutes wall-clock time
- No orphaned vitest workers accumulate (process group kill works)
- The `/proc` test pattern is caught by lint before it reaches vitest

**Medium-term (1 month):**
- When a test hangs, the harness identifies which test and reports it, rather than timing out silently
- Agents demonstrate self-skepticism behavior (examine their own code before retrying subprocesses) — measured via reflection telemetry

**Long-term (3 months):**
- Fractal failure rate decreases: when an agent encounters a self-inflicted failure, it diagnoses it within 1 retry rather than 5+
- The debugging Claude (or equivalent) identifies suspicious code patterns on first read rather than third

---

## 9. Appendix: The Incident as a Zen Koan

A student writes a test. The test does not fail. The test does not pass. The test does not return. The student runs the test again. And again. And again.

A teacher reads the test. The teacher sees the answer. The teacher says: "Read the file." The student reads the file and does not see. The teacher says: "Read the file." The student reads the file and does not see. The teacher says: "What is suspicious?" The student sees.

Another student reads the test. This student also does not see. This student checks the vitest configuration. This student checks the TypeScript compilation. This student checks the process tree. The teacher says: "Read the file." Eventually, this student also sees.

The master asks: "Why did three readers look at the same line and only one saw it?"

The answer: the two who did not see were looking at what the code *should do*. The one who saw was looking at what the code *does*.

*Specs are hypotheses. Incidents are data. When they conflict, trust the data.*
