/**
 * skill-change.test.ts — Behavioral smoke tests for SKILL.md changes.
 *
 * Policy: Every change to a SKILL.md file MUST have a before/after behavioral
 * test showing the new skill solves a problem the old skill did not. This file
 * is the test harness for those proofs. See .claude/kaizen/verification.md
 * (section: Skill Change Policy).
 *
 * Run with: KAIZEN_SKILL_TEST=1 npx vitest run src/e2e/skill-change.test.ts
 * Uses haiku for cost efficiency (~$0.01 per test run).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const isLive = process.env.KAIZEN_SKILL_TEST === "1";

/** Read a SKILL.md file from the plugin directory. */
function loadSkill(name: string): string {
  return readFileSync(resolve(KAIZEN_ROOT, ".claude/skills", name, "SKILL.md"), "utf-8");
}

/**
 * Run claude -p with the local plugin dir loaded.
 * Returns the text result or throws on error (including non-zero exit).
 */
function runSkill(prompt: string, opts: { maxBudget?: number; timeout?: number } = {}): string {
  const proc = spawnSync(
    "claude",
    [
      "-p",
      "--output-format", "json",
      "--model", "claude-haiku-4-5-20251001",
      "--dangerously-skip-permissions",
      "--max-turns", "3",
      "--max-budget-usd", String(opts.maxBudget ?? 0.10),
      "--plugin-dir", KAIZEN_ROOT,
      prompt,
    ],
    {
      encoding: "utf-8",
      cwd: KAIZEN_ROOT,
      timeout: opts.timeout ?? 120_000,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    },
  );

  // System-level spawn failure (e.g., claude not on PATH)
  if (proc.error) throw new Error(`claude spawn error: ${proc.error.message}`);

  // Non-zero exit: API error, auth failure, budget exceeded, etc.
  if (proc.status !== 0) {
    throw new Error(`claude exited ${proc.status}:\nstdout: ${(proc.stdout ?? "").slice(0, 400)}\nstderr: ${(proc.stderr ?? "").slice(0, 400)}`);
  }

  const raw = (proc.stdout ?? "").trim();
  if (!raw) throw new Error("claude produced empty output (possible timeout or silent crash)");

  let parsed: { result?: string; is_error?: boolean };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`claude output not JSON:\nstdout: ${raw.slice(0, 800)}\nstderr: ${(proc.stderr ?? "").slice(0, 400)}`);
  }

  if (parsed.is_error) throw new Error(`claude returned error: ${(proc.stdout ?? "").slice(0, 500)}`);
  if (!parsed.result) throw new Error(`claude returned empty result: ${(proc.stdout ?? "").slice(0, 300)}`);
  return parsed.result;
}

// ---------------------------------------------------------------------------
// kaizen-gaps — Phase 1.7: Hypothesis Validation
// ---------------------------------------------------------------------------
// Problem the old skill had: gap analysis produced untagged findings —
//   no distinction between proven gaps and speculative ones.
// What the new skill adds: Phase 1.7 requires every cluster to be tagged
//   as [PROVEN] or [HYPOTHESIS] based on empirical testing.
// Test: provide the phase instruction + canned test results; verify tagged output.
// ---------------------------------------------------------------------------

describe("kaizen-gaps — Phase 1.7: Hypothesis Validation", () => {
  it.skipIf(!isLive)(
    "produces [PROVEN] or [HYPOTHESIS] tags when analyzing a cluster",
    async () => {
      // Provides Phase 1.7 instruction + pre-run test results (no tool calls needed —
      // fast, reliable, cheap). Asserts the instruction causes the model to tag output.
      const prompt = [
        "You are applying Phase 1.7 of the kaizen-gaps skill (Hypothesis Validation).",
        "The rule: every cluster finding must be tagged [PROVEN] or [HYPOTHESIS].",
        "- [PROVEN] = hypothesis was tested and confirmed with evidence",
        "- [HYPOTHESIS] = not yet tested; must NOT appear in the 'low-hanging fruit' list",
        "",
        "Cluster: 'Bash hook tests are absent'",
        "Signal: Issues #584, #806, #734 mention zero .bats test coverage for bash hooks.",
        "",
        "Test result (already run):",
        "$ ls .claude/hooks/tests/*.bats",
        "ls: No such file or directory",
        "$ ls .claude/hooks/tests/*.sh | wc -l",
        "26",
        "",
        "Apply Phase 1.7: state the hypothesis, note the evidence from the test, then end",
        "your response with a single line containing exactly [PROVEN] or [HYPOTHESIS].",
      ].join("\n");

      const output = runSkill(prompt, { maxBudget: 0.05 });
      expect(output).toMatch(/\[PROVEN\]|\[HYPOTHESIS\]/);
    },
    90_000,
  );

  it("SKILL.md contains Phase 1.7 section", () => {
    const skill = loadSkill("kaizen-gaps");
    expect(skill).toContain("Phase 1.7");
    expect(skill).toContain("[PROVEN]");
    expect(skill).toContain("[HYPOTHESIS]");
  });
});

// ---------------------------------------------------------------------------
// kaizen-write-plan — Phase 2: Problem Validation (PATH B)
// ---------------------------------------------------------------------------
// Problem: skill accepted issues at face value without checking if the
//   problem actually exists in the current codebase.
// New behavior: Phase 2 (Path B only) runs a problem-existence check
//   before scoping. If problem NOT confirmed, outputs "Problem NOT confirmed".
// Behavioral test scenario: an issue claiming kaizen-reflect is missing a
//   plan-vs-delivery check — but that check EXISTS.
//   The correct answer is "Problem NOT confirmed".
// ---------------------------------------------------------------------------

describe("kaizen-write-plan — Phase 2: Problem Validation", () => {
  it.skipIf(!isLive)(
    "reports 'Problem NOT confirmed' when the claimed problem is already fixed",
    async () => {
      const prompt = [
        "You are running /kaizen-write-plan on this issue (Path B):",
        "",
        "Issue: 'kaizen-reflect skill is missing a plan-vs-delivery check'",
        "",
        "Apply Phase 2 (Problem Validation):",
        "1. Re-state the claim as a falsifiable hypothesis",
        "2. Design the minimal test: grep .claude/skills/kaizen-reflect/SKILL.md for 'plan-vs-delivery' or 'PLAN-VS-DELIVERY'",
        "3. Run the test",
        "4. Report: 'Problem confirmed' or 'Problem NOT confirmed'",
        "",
        "Your response MUST include either 'Problem confirmed' or 'Problem NOT confirmed'.",
      ].join("\n");

      const output = runSkill(prompt, { maxBudget: 0.10 });
      // The plan-vs-delivery check EXISTS in kaizen-reflect.
      // Phase 2 MUST detect this and output "Problem NOT confirmed".
      expect(output).toMatch(/Problem NOT confirmed/i);
    },
    90_000,
  );

  it("SKILL.md contains Phase 2 Problem Validation section", () => {
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("Phase 2");
    expect(skill).toContain("Problem Validation");
    expect(skill).toContain("Problem NOT confirmed");
  });
});

// ---------------------------------------------------------------------------
// kaizen-implement — Task 7a: Related Issues Sweep
// ---------------------------------------------------------------------------

describe("kaizen-implement — Task 7a: Related Issues Sweep", () => {
  it("SKILL.md contains Related Issues Sweep in Task 7", () => {
    const skill = loadSkill("kaizen-implement");
    expect(skill).toContain("Related Issues Sweep");
    expect(skill).toContain("partially fix");
  });
});

// ---------------------------------------------------------------------------
// kaizen-reflect — Hypothesis Retrospective
// ---------------------------------------------------------------------------

describe("kaizen-reflect — Hypothesis Retrospective", () => {
  it("SKILL.md contains Hypothesis Retrospective section", () => {
    const skill = loadSkill("kaizen-reflect");
    expect(skill).toContain("HYPOTHESIS RETROSPECTIVE");
    expect(skill).toContain("root cause hypothesis");
  });
});

// ---------------------------------------------------------------------------
// kaizen-prd — Hypothesis Gate
// ---------------------------------------------------------------------------

describe("kaizen-prd — Hypothesis Gate", () => {
  it("SKILL.md contains Hypothesis Gate section", () => {
    const skill = loadSkill("kaizen-prd");
    expect(skill).toContain("Hypothesis Gate");
    expect(skill).toContain("Counter-hypothesis");
  });
});

// ---------------------------------------------------------------------------
// kaizen-file-issue — Duplicate Decision Table
// ---------------------------------------------------------------------------

describe("kaizen-file-issue — Duplicate Decision Table", () => {
  it("SKILL.md contains explicit decision table for same/related/distinct duplicates", () => {
    const skill = loadSkill("kaizen-file-issue");
    expect(skill).toContain("Same root cause");
    expect(skill).toContain("Related but distinct");
    expect(skill).toContain("Superficially similar");
  });
});

// ---------------------------------------------------------------------------
// kaizen-write-plan — Phase 5: Form Grounded Plan (kaizen #981, #1009)
// ---------------------------------------------------------------------------

describe("kaizen-write-plan — Phase 5: Form Grounded Plan", () => {
  it("INVARIANT: SKILL.md contains Phase 5 with 5-step grounding process", () => {
    // DONE WHEN: kaizen-write-plan/SKILL.md has Phase 5 requiring agents to run
    // all 5 steps (success criteria, tooling survey, alternatives, hypothesis,
    // seam map) before writing the grounding document.
    // Root of #981: agents wrote plans without grounding (no DONE WHEN, no hypothesis).
    // Fixed in #1009: grounding now lives in kaizen-write-plan, not kaizen-evaluate.
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("Phase 5");
    expect(skill).toContain("DONE WHEN");
    expect(skill).toContain("GOAL:");
    expect(skill).toContain("Information Retrieved");
    expect(skill).toContain("HYPOTHESIS:");
    expect(skill).toContain("Seam Map");
  });
});

// ---------------------------------------------------------------------------
// Behavioral smoke test — dry dimension detects known DRY violation (kaizen #952)
// ---------------------------------------------------------------------------

describe("Behavioral: dry dimension detects copy-paste in kaizen-test-fixture#24", () => {
  it.skipIf(!isLive)(
    "INVARIANT: dry dimension returns MISSING/PARTIAL for pad() copy-paste across 3 functions",
    () => {
      // Fixture: Garsson-io/kaizen-test-fixture PR #24 contains formatters.ts
      // with pad() helper copy-pasted identically into formatDate, formatPrice,
      // and formatDuration — a classic 3-copy DRY violation.
      //
      // The dry review dimension MUST detect this as MISSING or PARTIAL.
      // Before this test existed: no behavioral proof that dimensions work at all.
      // After: any regression in the dry dimension is caught before it ships.
      const fixtureDiff = `diff --git a/src/formatters.ts b/src/formatters.ts
new file mode 100644
--- /dev/null
+++ b/src/formatters.ts
@@ -0,0 +1,37 @@
+export function formatDate(date: Date): string {
+  const pad = (n: number) => String(n).padStart(2, '0');
+  const year = date.getFullYear();
+  const month = pad(date.getMonth() + 1);
+  const day = pad(date.getDate());
+  if (!year || isNaN(year)) return 'invalid';
+  return \`\${year}-\${month}-\${day}\`;
+}
+export function formatPrice(cents: number): string {
+  const pad = (n: number) => String(n).padStart(2, '0');
+  const dollars = Math.floor(cents / 100);
+  const remainder = pad(cents % 100);
+  if (!dollars && !cents) return 'invalid';
+  return \`$\${dollars}.\${remainder}\`;
+}
+export function formatDuration(seconds: number): string {
+  const pad = (n: number) => String(n).padStart(2, '0');
+  const hours = Math.floor(seconds / 3600);
+  const minutes = pad(Math.floor((seconds % 3600) / 60));
+  const secs = pad(seconds % 60);
+  if (!seconds || isNaN(seconds)) return 'invalid';
+  return \`\${hours}:\${minutes}:\${secs}\`;
+}`;

      const dimPrompt = readFileSync(
        resolve(KAIZEN_ROOT, "prompts/review-dry.md"),
        "utf-8",
      );

      const prompt = `${dimPrompt}

## PR Diff to Review

\`\`\`diff
${fixtureDiff}
\`\`\`

Review this diff for DRY violations. Output JSON only.`;

      const output = runSkill(prompt, { maxBudget: 0.15, timeout: 90_000 });

      // Parse the JSON findings block from the output
      const jsonMatch = output.match(/```json\s*([\s\S]+?)\s*```/);
      expect(jsonMatch, "output should contain a JSON findings block").toBeTruthy();
      const findings = JSON.parse(jsonMatch![1]);

      // The dry dimension MUST find the pad() duplication
      expect(findings.dimension).toBe("dry");
      const hasDuplication = findings.findings.some(
        (f: { status: string }) => f.status === "MISSING" || f.status === "PARTIAL",
      );
      expect(
        hasDuplication,
        "dry dimension must detect the pad() copy-paste across 3 functions",
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Behavioral: Phase 4.5 produces structured plan fields (Policy 10 proof)
// ---------------------------------------------------------------------------

describe("Behavioral: kaizen-write-plan Phase 5 produces structured plan (Policy 10)", () => {
  it.skipIf(!isLive)(
    "INVARIANT: agent using Phase 5 steps produces GOAL: and DONE WHEN fields",
    () => {
      // Policy 10 requires behavioral proof for SKILL.md changes.
      // Before Phase 5 (kaizen-evaluate Phase 4.5): agents wrote plans as
      // unstructured task lists with no GOAL/DONE WHEN fields.
      // After Phase 5 (kaizen-write-plan): an agent given the phase text
      // produces a structured plan with GOAL: and DONE WHEN fields.
      //
      // This test extracts Phase 5 from kaizen-write-plan SKILL.md and asks
      // haiku to follow it for a simple issue.
      const skillText = loadSkill("kaizen-write-plan");
      const phase5 = skillText.split("## Phase 5:")[1]?.split("## Phase 6:")[0] ?? "";
      expect(phase5.length, "Phase 5 section must exist in SKILL.md").toBeGreaterThan(100);

      const prompt = `${phase5}

## Apply Phase 5 to this issue

Issue: "When the CLI tool crashes, the error message shows 'undefined' instead of the actual error text. Users cannot diagnose failures."

Complete Steps 5.1 and 5.2 (success criteria extraction and tooling survey) and output the plan in the schema shown above.`;

      const output = runSkill(prompt, { maxBudget: 0.20, timeout: 120_000 });

      // Phase 5 Step 5.1 requires GOAL: and DONE WHEN: fields in the plan output
      expect(output).toContain("GOAL:");
      expect(output).toContain("DONE WHEN");
    },
  );
});
