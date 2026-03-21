# Test Side Effects & Kaizen Escalation — Specification

## 1. Problem Statement

### A. Test side effects: tracked file mutation

Tests that invoke CLI scripts or build tools can overwrite tracked files as a side effect. For example, a test that runs a code generation script may overwrite a checked-in output file with a fresh timestamp. The surfaces are identical, but the timestamp diff leaves a dirty working tree.

**Who experiences the problem:** Dev agents. A `check-dirty-files` hook blocks `git push` when tracked files have uncommitted changes. The agent must manually `git checkout -- <file>` before every push — and if they forget, the hook blocks them.

**What happened:** This exact pattern blocked pushes **twice in the same session**. Both times, the kaizen reflection correctly identified the root cause. Neither time was the fix applied — the agent just restored the file and moved on.

**Cost of not solving it:** Every future test run dirties the tracked file. Every future push requires manual cleanup. The hook fires, the agent writes a kaizen reflection, restores the file, and pushes again. Wasted cycles, every time.

### B. Kaizen reflection doesn't escalate repeat issues

The kaizen reflection process asks three questions: what happened, what gap led to it, what would prevent it. The agent answered correctly both times. But answering correctly and fixing the problem are different things.

**The gap in the gap-analysis:** When the same root cause appears in multiple kaizen reflections within a session, the process should escalate. The kaizen policy already says:

> "Has this type of failure happened before? If yes, the previous level wasn't enough — escalate."

But there's no mechanism to enforce it. The reflection is Level 1 (instructions). Repeated Level 1 reflections on the same issue should trigger Level 2 (a hook or automation that prevents the problem) or Level 3 (a code fix that eliminates the problem class entirely).

## 2. This Incident as a Case Study for Autonomous Kaizen

This incident is a textbook example of why autonomous kaizen escalation is needed. Let's trace what happened through the lens of a 7-step enhanced reflection protocol:

| Step | What should have happened | What actually happened |
|------|--------------------------|----------------------|
| **1. What happened?** | Test overwrites tracked file | Correctly identified both times |
| **2. What class?** | `test_side_effect` — test modifies tracked artifacts | Not classified. Treated as one-off both times |
| **3. Root cause chain** | Test calls CLI → CLI writes file → file is tracked → working tree dirty | Identified but stopped at "the test does it" |
| **4. Blast radius** | Are there other tests that write to tracked files? | Never asked |
| **5. Fix vs Prevent** | Fix: restore file. Prevent: export function, test in-memory | Fix applied (restore). Prevention described but not implemented |
| **6. What level?** | L3 — code fix (export function) eliminates the class | Stayed at L1 (instruction to self: "fix it later") |
| **7. Meta: Did kaizen fail?** | Yes — the reflection protocol produced correct analysis twice but no escalation | Not asked |

### What an autonomous kaizen system would have done differently

1. **Structured incident record** — First occurrence would have been captured with `bug_class: test_side_effect`, not as ephemeral text in a conversation.

2. **Recurrence detection** — Second occurrence would have matched the first by class. The system would flag: "This is recurring. L1 failed. Escalate."

3. **Escalation enforcement** — Instead of allowing the agent to write another reflection and move on, the system would require implementing the prevention before unblocking the push.

4. **Blast radius scan** — "Where else do tests write to tracked files?" — would have been asked automatically as part of the protocol.

The key insight: **the current kaizen system treats reflections as outputs. An autonomous kaizen system treats them as inputs to a learning loop.** A reflection that doesn't change the system is noise, not signal.

### How the kaizen system should improve itself

This incident reveals a specific gap in the kaizen process:

**Current state:** Kaizen reflections are fire-and-forget. The agent writes one, the hook unblocks, and the reflection evaporates. No memory, no recurrence detection, no escalation.

**What's needed:**
- **Incident store** — reflections are written to persistent storage, not just to conversation text
- **Recurrence detection** — same `bug_class` appearing twice triggers escalation
- **Escalation enforcement** — the hook can query the incident store and refuse to unblock if the agent hasn't escalated a recurring issue

## 3. Immediate Fix: Isolate the test

The autonomous kaizen system is the systemic solution. But the specific bug should still be fixed now. This is the "fix the instance AND prevent the class" principle.

**Example pattern** — a test that runs a code generator:
```typescript
function getGeneratedOutput() {
  execSync('tsx scripts/generate-output.ts', { cwd: ROOT, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
}
```

**Fix options:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A1: Restore after test | Save file content before, restore in `afterAll` | Minimal change | Still writes to tracked file during run — race conditions with parallel test runners |
| A2: Write to temp dir | Pass output path as env var or arg; test uses temp dir | Clean isolation, no tracked file mutation | Requires small refactor to generator script |
| A3: Export and call directly | Import the generate function, compare in memory | No file I/O in tests, fastest | Requires refactoring generator to export function |

**Lean: A3** — export the generator function, import it in the test, and compare the result in memory. This eliminates the side effect entirely.

## 4. Implementation Sequencing

```
Fix A (test isolation)        — standalone, ~15min, fixes the instance
Autonomous kaizen Phase 1     — fixes the class (incident store + recurrence detection)
```

Fix A eliminates this specific recurring trigger. Phase 1 of autonomous kaizen (incident store + enhanced reflection + recurrence detection) prevents the meta-failure pattern across all future kaizen reflections — not just this one.
