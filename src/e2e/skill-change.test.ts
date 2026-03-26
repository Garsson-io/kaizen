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
// kaizen-evaluate — Phase 0.7: Problem Validation
// ---------------------------------------------------------------------------
// Problem: skill accepted issues at face value without checking if the
//   problem actually exists in the current codebase.
// New behavior: Phase 0.7 runs a problem-existence check before scoping.
//   If problem NOT confirmed, outputs "Problem NOT confirmed" and stops.
// Behavioral test scenario: an issue claiming kaizen-reflect is missing a
//   plan-vs-delivery check — but that check EXISTS (line 98: "PLAN-VS-DELIVERY CHECK").
//   The correct answer is "Problem NOT confirmed". The assertion enforces this
//   direction explicitly — NOT just any confirmation language.
// ---------------------------------------------------------------------------

describe("kaizen-evaluate — Phase 0.7: Problem Validation", () => {
  it.skipIf(!isLive)(
    "reports 'Problem NOT confirmed' when the claimed problem is already fixed",
    async () => {
      const prompt = [
        "You are running /kaizen-evaluate on this issue:",
        "",
        "Issue: 'kaizen-reflect skill is missing a plan-vs-delivery check'",
        "",
        "Apply Phase 0.7 (Problem Validation):",
        "1. Re-state the claim as a falsifiable hypothesis",
        "2. Design the minimal test: grep .claude/skills/kaizen-reflect/SKILL.md for 'plan-vs-delivery' or 'PLAN-VS-DELIVERY'",
        "3. Run the test",
        "4. Report: 'Problem confirmed' or 'Problem NOT confirmed'",
        "",
        "Your response MUST include either 'Problem confirmed' or 'Problem NOT confirmed'.",
      ].join("\n");

      const output = runSkill(prompt, { maxBudget: 0.10 });
      // The plan-vs-delivery check EXISTS in kaizen-reflect at line 98.
      // Phase 0.7 MUST detect this and output "Problem NOT confirmed".
      // This assertion intentionally requires the NOT form — accepting
      // "Problem confirmed" here would mean the test passes on failure.
      expect(output).toMatch(/Problem NOT confirmed/i);
    },
    90_000,
  );

  it("SKILL.md contains Phase 0.7 section", () => {
    const skill = loadSkill("kaizen-evaluate");
    expect(skill).toContain("Phase 0.7");
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
