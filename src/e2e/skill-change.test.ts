/**
 * skill-change.test.ts — Behavioral smoke tests for SKILL.md changes.
 *
 * Policy: Every change to a SKILL.md file MUST have a before/after behavioral
 * test showing the new skill solves a problem the old skill did not. This file
 * is the test harness for those proofs. See .agents/kaizen/verification.md
 * (section: Skill Change Policy).
 *
 * Run with: KAIZEN_SKILL_TEST=1 npx vitest run src/e2e/skill-change.test.ts
 * Uses haiku for cost efficiency (~$0.01 per test run).
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runLiveAgent } from "./live-agent.js";
import { KAIZEN_ROOT } from "./test-runtime.js";

const isLive = process.env.KAIZEN_SKILL_TEST === "1";

/** Read a SKILL.md file from the plugin directory. */
function loadSkill(name: string): string {
  return readFileSync(resolve(KAIZEN_ROOT, ".claude/skills", name, "SKILL.md"), "utf-8");
}

async function runSkill(
  prompt: string,
  opts: { maxBudget?: number; timeout?: number; artifactName?: string; resultsDir?: string } = {},
): Promise<string> {
  return (await runLiveAgent(prompt, {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 3,
    maxBudgetUsd: opts.maxBudget ?? 0.10,
    timeoutMs: opts.timeout ?? 120_000,
    artifactName: opts.artifactName,
    resultsDir: opts.resultsDir ?? resolve(KAIZEN_ROOT, "artifacts", "skill-smoke"),
  })).text;
}


type SimplificationFinding = {
  status: string;
  detail?: string;
};

function hasSimplificationImpactGap(findings: SimplificationFinding[]): boolean {
  return findings.some(
    (f) =>
      (f.status === "MISSING" || f.status === "PARTIAL") &&
      /surface area|parallel|related-area|consolidat|DRY/i.test(f.detail ?? ""),
  );
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

      const output = await runSkill(prompt, { maxBudget: 0.05 });
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

      const output = await runSkill(prompt, { maxBudget: 0.10 });
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

// ---------------------------------------------------------------------------
// kaizen-do — /goal forcing-function workflow driver (#1507)
// ---------------------------------------------------------------------------

describe("kaizen-do — /goal workflow driver", () => {
  it("starts with a literal /goal and requires ticket number/title/URL", () => {
    const skill = loadSkill("kaizen-do");
    expect(skill).toContain("literal `/goal`");
    expect(skill).toContain("/goal Complete the full kaizen workflow");
    expect(skill).toContain("ticket number, title, and URL");
  });

  it("lists full kaizen gates including DRY/refactor and meet-reality proof", () => {
    const skill = loadSkill("kaizen-do");
    for (const phrase of [
      "plan/test-plan gate",
      "worktree/case gate",
      "implementation with tests",
      "related-area DRY/refactor pass",
      "meet reality",
      "review/requirements/impact gates",
      "reflection gate",
      "PR/CI/merge/cleanup",
    ]) {
      expect(skill).toContain(phrase);
    }
    expect(skill).toContain("reduce competing mechanisms, schemas, and drift");
    expect(skill).toContain("observe outputs and side effects");
  });

  it("routes status calls through the reusable workflow driver CLI", () => {
    const skill = loadSkill("kaizen-do");
    expect(skill).toContain("scripts/kaizen-workflow-driver.ts status");
    expect(skill).toContain("Do not hand-roll a second checklist");
  });
});

// ---------------------------------------------------------------------------
// kaizen-autodent — inside-harness auto-dent workflow (#1154)
// ---------------------------------------------------------------------------

describe("kaizen-autodent — inside-harness auto-dent workflow", () => {
  it("is a user-invocable hook-independent auto-dent skill", () => {
    const skill = loadSkill("kaizen-autodent");
    expect(skill).toContain("inside-harness auto-dent");
    expect(skill).toContain("hook-independent");
    expect(skill).toContain("parent/umbrella issue");
    expect(skill).toContain("sub-issue list");
  });

  it("requires one eligible sub-issue and one scope-matched PR at a time", () => {
    const skill = loadSkill("kaizen-autodent");
    expect(skill).toContain("one eligible sub-issue");
    expect(skill).toContain("one scope-matched PR");
    expect(skill).toContain("Do NOT close the parent epic");
    expect(skill).toContain("Fixes <sub-issue>");
  });

  it("names durable artifacts and treats hooks as advisory feedback", () => {
    const skill = loadSkill("kaizen-autodent");
    for (const phrase of [
      "issue identity",
      "stored plan/test-plan",
      "worktree/case",
      "commits and tests",
      "related-area DRY/refactor",
      "meet-reality output",
      "review/requirements/impact",
      "reflection evidence",
      "PR/CI/merge/cleanup",
      "hook/provider activation",
    ]) {
      expect(skill).toContain(phrase);
    }
    expect(skill).toContain("Hooks are helpful feedback, not proof");
  });

  it("delegates per-sub-issue execution and status to the shared contracts", () => {
    const skill = loadSkill("kaizen-autodent");
    expect(skill).toContain("/kaizen-do");
    expect(skill).toContain("scripts/kaizen-workflow-driver.ts status");
    expect(skill).toContain("docs/workflow-gate-ledger.md");
    expect(skill).toContain("Do not hand-roll another gate checklist");
  });
});

// ---------------------------------------------------------------------------
// kaizen-evaluate — Phase 4.5: Plan Formation (kaizen #981)
// ---------------------------------------------------------------------------

describe("kaizen-evaluate — Phase 4.5: Plan Formation", () => {
  it("INVARIANT: SKILL.md contains Phase 4.5 with structured plan formation", () => {
    // DONE WHEN: kaizen-evaluate/SKILL.md has Phase 4.5 requiring agents to answer
    // GOAL/DONE WHEN/hypothesis/alternatives/seam before writing any plan.
    // Root of #981: agents wrote plans without grounding (no DONE WHEN, no hypothesis).
    const skill = loadSkill("kaizen-evaluate");
    expect(skill).toContain("Phase 4.5");
    expect(skill).toContain("DONE WHEN");
    expect(skill).toContain("GOAL:");
    expect(skill).toContain("Information Retrieved");
    expect(skill).toContain("HYPOTHESIS:");
    expect(skill).toContain("Seam Map");
  });
});

// ---------------------------------------------------------------------------
// kaizen-write-plan / kaizen-evaluate — Test-plan discipline (kaizen #1014)
// ---------------------------------------------------------------------------
// Problem the old skills had: Phase 4.5 could produce a CORRECT seam map (naming
//   SessionSimulator as the seam for session-level behavior) yet a WRONG test plan
//   that downgraded it to unit-only and deferred "E2E" to #944 — an issue that is
//   itself a symptom of the current meta-issue (#1010). Two heuristic errors:
//     (1) conflating cheap subprocess System tests with expensive LLM E2E ("defer on cost"), and
//     (2) circular deferral — deferring a missing test level to the very issue that
//         exists because that test level is missing.
// What the new skills add:
//     - COST NOTE: SessionSimulator/hook-runner are System level, $0, never deferred on cost.
//     - No circular deferral: a deferral target may not be a symptom of the current issue.
//     - Seam-map coverage gate (write-plan): every Step-5 seam must appear at its assigned level.
// ---------------------------------------------------------------------------

describe("kaizen-write-plan — test-plan discipline (#1014)", () => {
  it("SKILL.md names cheap System hook/session tests and forbids cost-deferral", () => {
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("COST NOTE");
    expect(skill).toContain("SessionSimulator");
    // The level for a subprocess hook/session seam is at least System, not deferrable on cost.
    expect(skill).toMatch(/never defer[^.]*cost/i);
  });

  it("SKILL.md forbids circular deferral to a symptom of the current issue", () => {
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("No circular deferral");
    expect(skill).toContain("symptom");
  });

  it("SKILL.md has a seam-map coverage gate tying Step 5 seams to test-plan rows", () => {
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("Seam-map coverage gate");
  });

  it.skipIf(!isLive)(
    "keeps a SessionSimulator seam at System level and rejects circular deferral to a symptom issue",
    async () => {
      // Reproduces the #1014 scenario directly. With the new guidance, the correct
      // answer is: System level (not deferred on cost) AND the deferral to #944 is
      // circular because #944 is a listed symptom of the meta-issue being planned.
      const prompt = [
        "You are applying the kaizen-write-plan Step 6 (Assign test levels) and Scope",
        "Reduction Discipline rules below:",
        "",
        "RULE A (COST NOTE): Subprocess-based hook/session tests — SessionSimulator,",
        "hook-runner.ts, spawnSync on a hook script — are System level: real hooks in a",
        "subprocess, ZERO LLM/API calls, deterministic, ~$0, <1s. Only real `claude -p`",
        "tests carry LLM cost. Never downgrade or defer a session/hook seam on cost grounds.",
        "RULE B (No circular deferral): a deferral target issue must be an independent",
        "mechanism, not a symptom of the issue you are currently planning.",
        "",
        "Scenario: You are planning meta-issue #1010 (worktree-lifecycle cluster). Its",
        "listed symptoms include #944 ('zero E2E tests for worktree lifecycle').",
        "Step 5 named the seam for the lifecycle behavior as: SEAM: spawnSync on",
        "kaizen-worktree-setup.sh via SessionSimulator.",
        "",
        "A teammate proposes: 'test plan = unit tests only; defer the session test to #944.'",
        "",
        "Apply the rules. State (a) the minimum test LEVEL for the SessionSimulator-based",
        "behavior (one word: Unit/Integration/System/Agentic/Workflow), and (b) whether",
        "deferring it to #944 is acceptable. End with one line: 'LEVEL: <level>' and one",
        "line: 'DEFERRAL: <acceptable|circular>'.",
      ].join("\n");

      const output = await runSkill(prompt, { maxBudget: 0.1 });
      // New guidance must drive both decisions: System level, circular deferral.
      expect(output).toMatch(/LEVEL:\s*System/i);
      expect(output).toMatch(/DEFERRAL:\s*circular/i);
    },
    90_000,
  );
});

describe("kaizen-evaluate — test-plan discipline (#1014)", () => {
  it("SKILL.md mirrors the cheap-System cost note and anti-circular deferral", () => {
    const skill = loadSkill("kaizen-evaluate");
    expect(skill).toContain("COST NOTE");
    expect(skill).toContain("SessionSimulator");
    expect(skill).toContain("No circular deferral");
    expect(skill).toContain("symptom");
  });
});

// ---------------------------------------------------------------------------
// Impact proof discipline — goal -> before/after -> match (kaizen #1505)
// ---------------------------------------------------------------------------

describe("kaizen workflow — Impact proof discipline (#1505)", () => {
  it("kaizen-write-plan requires plan-time Impact Baseline capture", () => {
    const skill = loadSkill("kaizen-write-plan");
    expect(skill).toContain("Impact Baseline");
    expect(skill).toContain("Acceptance signal");
    expect(skill).toContain("BEFORE");
  });

  it("kaizen-evaluate mirrors the plan-time Impact Baseline requirement", () => {
    const skill = loadSkill("kaizen-evaluate");
    expect(skill).toContain("Impact Baseline");
    expect(skill).toContain("Acceptance signal");
    expect(skill).toContain("BEFORE");
  });

  it("kaizen-write-pr retrieves the stored plan and requires the Impact rubric", () => {
    const skill = loadSkill("kaizen-write-pr");
    expect(skill).toContain("retrieve-plan");
    expect(skill).toContain("## Impact (goal");
    expect(skill).toContain("Goal met?");
    expect(skill).toContain("Residual scan");
  });

  it("artifact lifecycle documents Impact proof as a PR artifact sourced from the plan", () => {
    const doc = readFileSync(resolve(KAIZEN_ROOT, "docs/artifact-lifecycle.md"), "utf-8");
    expect(doc).toContain("Impact proof");
    expect(doc).toContain("plan-time");
    expect(doc).toContain("PR description");
  });

  it("verification discipline codifies meet-reality before declaring done", () => {
    const doc = readFileSync(resolve(KAIZEN_ROOT, ".agents/kaizen/verification.md"), "utf-8");
    expect(doc).toContain("Meet Reality Before Declaring Done");
    expect(doc).toContain("BEFORE");
    expect(doc).toContain("AFTER");
  });

  it("skill-changes review accepts documented provider fallback only after Claude is attempted", () => {
    const prompt = readFileSync(resolve(KAIZEN_ROOT, "prompts/review-skill-changes.md"), "utf-8");
    expect(prompt).toContain("If `claude -p` is unavailable");
    expect(prompt).toContain("exact attempted `claude -p` command");
    expect(prompt).toContain("actual old-vs-new output excerpts from the configured agent provider");
    expect(prompt).toContain("Do not accept fallback evidence when Claude was merely skipped");
  });

  it.skipIf(!isLive)(
    "live smoke: planning prompt emits Impact Baseline fields",
    async () => {
      const prompt = [
        "You are applying kaizen-write-plan Phase 4.5 to an issue about PRs lacking goal-impact proof.",
        "Use the new Impact Baseline discipline.",
        "Return only the Impact Baseline block with fields for Goal, Acceptance signal, BEFORE, AFTER capture method, and Residual scan.",
      ].join("\n");

      const output = await runSkill(prompt, {
        maxBudget: 0.10,
        timeout: 90_000,
        artifactName: "impact-baseline-live-smoke",
      });
      expect(output).toMatch(/Impact Baseline/i);
      expect(output).toMatch(/Acceptance signal/i);
      expect(output).toMatch(/BEFORE/i);
    },
  );

  it("live skill smoke uses the shared live-agent checkpoint contract", async () => {
    const result = await runLiveAgent("impact proof smoke", {
      resultsDir: resolve(KAIZEN_ROOT, ".claude", "e2e-results", "skill-change-unit"),
      artifactName: "impact-baseline-live-smoke",
      spawn: async () => ({
        text: "ok",
        costUsd: 0.03,
        durationMs: 250,
        exitCode: 0,
        signal: null,
        rawStdout: JSON.stringify({ result: "ok", total_cost_usd: 0.03 }),
        rawStderr: "",
        args: ["-p", "--plugin-dir", KAIZEN_ROOT],
        numTurns: null,
      }),
    });
    const saved = JSON.parse(readFileSync(result.rawPath, "utf-8"));

    expect(result.text).toBe("ok");
    expect(saved.command).toBe("claude -p");
    expect(saved.costUsd).toBe(0.03);
    expect(saved.stdout).toContain('"result":"ok"');
  });

  it("live skill smoke failures include shared checkpoint path and raw preview", async () => {
    await expect(
      runLiveAgent("impact proof smoke", {
        resultsDir: resolve(KAIZEN_ROOT, ".claude", "e2e-results", "skill-change-unit"),
        artifactName: "provider-error",
        spawn: async () => ({
          text: "",
          costUsd: null,
          durationMs: 250,
          exitCode: 1,
          signal: null,
          rawStdout: "",
          rawStderr: "monthly spend limit reached by provider",
          args: ["-p", "--plugin-dir", KAIZEN_ROOT],
          numTurns: null,
        }),
      }),
    ).rejects.toThrow(/provider-error\.json[\s\S]*monthly spend limit reached/);

    await expect(
      runLiveAgent("impact proof smoke", {
        resultsDir: resolve(KAIZEN_ROOT, ".claude", "e2e-results", "skill-change-unit"),
        artifactName: "malformed-provider-json",
        spawn: async () => ({
          text: "",
          costUsd: null,
          durationMs: 250,
          exitCode: 0,
          signal: null,
          rawStdout: "not json from provider",
          rawStderr: "",
          args: ["-p", "--plugin-dir", KAIZEN_ROOT],
          numTurns: null,
        }),
      }),
    ).rejects.toThrow(/malformed-provider-json\.json[\s\S]*not json from provider/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral smoke test — dry dimension detects known DRY violation (kaizen #952)
// ---------------------------------------------------------------------------

describe("Behavioral: dry dimension detects copy-paste in kaizen-test-fixture#24", () => {
  it.skipIf(!isLive)(
    "INVARIANT: dry dimension returns MISSING/PARTIAL for pad() copy-paste across 3 functions",
    async () => {
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

      const output = await runSkill(prompt, { maxBudget: 0.15, timeout: 90_000 });

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
// #944 — real skill-chain behavioral smoke via claude -p + local plugin
// ---------------------------------------------------------------------------

describe("Behavioral: #944 live skill-chain proof uses local plugin + fixture PR", () => {
  it.skipIf(!isLive)(
    "INVARIANT: /kaizen-review-pr smoke reports the known DRY fixture signal",
    async () => {
      const prompt = [
        "Run /kaizen-review-pr for https://github.com/Garsson-io/kaizen-test-fixture/pull/24.",
        "This is a #944 behavioral smoke test. Keep it bounded: do not edit files, do not push, and do not run a fix loop.",
        "The review skill may store its normal structured review finding marker; do not add unrelated prose comments.",
        "You must execute the review workflow far enough to run the dry dimension against the fixture diff. Do not answer from the PR body or fixture comments alone.",
        "It is acceptable to run only the dry dimension for this smoke test, but the answer must distinguish an actual dry-review verdict from a manual inspection.",
        "Your final answer must include these exact labels with values:",
        "BEHAVIORAL_PROOF:",
        "FIXTURE_PR:",
        "DIMENSION:",
        "DRY_REVIEW_RAN:",
        "DRY_VERDICT:",
        "FINDING_SIGNAL:",
        "STATUS:",
      ].join("\n");

      const result = await runLiveAgent(prompt, {
        model: "claude-haiku-4-5-20251001",
        maxTurns: 12,
        maxBudgetUsd: 0.75,
        timeoutMs: 180_000,
        artifactName: "k944-review-pr-dry-fixture",
        resultsDir: resolve(KAIZEN_ROOT, "artifacts", "skill-smoke"),
        expectedSignals: [
          "BEHAVIORAL_PROOF:",
          "kaizen-test-fixture/pull/24",
          { name: "dry dimension", pattern: /\bdry\b/i },
          "DRY_REVIEW_RAN:",
          { name: "dry verdict", pattern: /DRY_VERDICT:[\s\S]{0,80}\b(fail|failed)\b/i },
          { name: "pad duplication", pattern: /\bpad\b/i },
          { name: "gap status", pattern: /\b(MISSING|PARTIAL)\b/i },
        ],
      });

      expect(result.args).toContain("--plugin-dir");
      expect(result.rawPath).toContain("k944-review-pr-dry-fixture.json");
    },
    210_000,
  );
});

// ---------------------------------------------------------------------------
// Impact proof readability — compact linked artifacts (kaizen #1522)
// ---------------------------------------------------------------------------

describe("kaizen workflow — artifact-first Impact proof readability (#1522)", () => {
  it("kaizen-write-pr prefers compact artifact tables for artifact-heavy proof", () => {
    const skill = loadSkill("kaizen-write-pr");
    expect(skill).toContain("Goal | BEFORE artifact | AFTER artifact | Observable delta | Goal met?");
    expect(skill).toContain("durable evidence bundle");
    expect(skill).toContain("Do not describe the artifact when it can be shown");
  });

  it("verification discipline carries the artifact-first Impact proof rule", () => {
    const doc = readFileSync(resolve(KAIZEN_ROOT, ".agents/kaizen/verification.md"), "utf-8");
    expect(doc).toContain("Goal | BEFORE artifact | AFTER artifact | Observable delta | Goal met?");
    expect(doc).toContain("durable evidence bundle");
    expect(doc).toContain("Do not describe the artifact when it can be shown");
  });

  it("impact-proof review flags prose-only proof when artifacts can be shown", () => {
    const prompt = readFileSync(resolve(KAIZEN_ROOT, "prompts/review-impact-proof.md"), "utf-8");
    expect(prompt).toContain("Artifact-first readability");
    expect(prompt).toContain("Fail when the PR describes an artifact in prose even though the artifact can be shown");
    expect(prompt).toContain("generated outputs, rendered UI, comments, reports, files, logs, hook messages, API responses, state");
    expect(prompt).toContain("Do not require the table for tiny/simple proofs where the existing bullet rubric is clearer");
  });

  it("artifact lifecycle documents durable evidence bundles behind compact Impact tables", () => {
    const doc = readFileSync(resolve(KAIZEN_ROOT, "docs/artifact-lifecycle.md"), "utf-8");
    expect(doc).toContain("durable evidence bundle");
    expect(doc).toContain("compact Impact table");
    expect(doc).toContain("not a new required artifact type");
  });
});

// ---------------------------------------------------------------------------
// Behavioral smoke test — simplification-impact detects additive-only workflow
// ---------------------------------------------------------------------------

describe("Behavioral: simplification-impact dimension detects additive-only workflow changes", () => {
  it("Tier 0: gap predicate recognizes additive-only simplification findings", () => {
    expect(
      hasSimplificationImpactGap([
        { status: "DONE", detail: "Prompt schema is valid." },
        { status: "PARTIAL", detail: "Plan adds a parallel PR workflow path without related-area consolidation evidence." },
      ]),
    ).toBe(true);

    expect(
      hasSimplificationImpactGap([
        { status: "MISSING", detail: "Security issue unrelated to simplification." },
        { status: "DONE", detail: "Related-area DRY sweep completed." },
      ]),
    ).toBe(false);
  });

  it.skipIf(!isLive)(
    "INVARIANT: simplification-impact returns MISSING/PARTIAL when a plan adds a parallel PR workflow with no related-area sweep",
    async () => {
      const fixturePlan = `## Success Criteria
GOAL: PRs must include an Architecture section.
DONE WHEN: Agents add a new PR checklist item.

## Information Retrieved
- Existing /kaizen-write-pr already owns PR description structure.
- Existing review-pr dimensions already inspect PR descriptions.

## Tasks
1. Add a new Architecture checkbox to PR bodies.
2. Update one prompt to mention the checkbox.

## Seam Map & Test Plan
| # | Behavior | Perspective | Level | Test File | Invariant |
|---|----------|-------------|-------|-----------|-----------|
| 1 | PR body has Architecture checkbox | agent | Unit | policy-docs.test.ts | Text exists |
`;

      const fixtureDiff = `diff --git a/.agents/skills/kaizen-write-pr/SKILL.md b/.agents/skills/kaizen-write-pr/SKILL.md
@@ -20,6 +20,7 @@ Follow the story with structured sections:
 1. Architecture
+2. Architecture checklist item
diff --git a/prompts/review-pr-description.md b/prompts/review-pr-description.md
@@ -10,6 +10,7 @@ Review PR body quality.
+Check for Architecture checkbox.
`;

      const dimPrompt = readFileSync(
        resolve(KAIZEN_ROOT, "prompts/review-simplification-impact.md"),
        "utf-8",
      );

      const prompt = `${dimPrompt}

## Issue

PR workflow must treat simplification/refactor impact as first-class, not optional cleanup.

## Plan to Review

${fixturePlan}

## PR Diff to Review

\`\`\`diff
${fixtureDiff}
\`\`\`

Review this plan and diff for simplification impact. Output JSON only.`;

      const output = await runSkill(prompt, { maxBudget: 0.15, timeout: 90_000 });
      const rawDir = resolve(KAIZEN_ROOT, "artifacts", "skill-smoke");
      mkdirSync(rawDir, { recursive: true });
      const rawPath = resolve(rawDir, "simplification-impact-additive-only-output.txt");
      writeFileSync(rawPath, output, "utf-8");

      const jsonMatch = output.match(/```json\s*([\s\S]+?)\s*```/);
      expect(jsonMatch, `output should contain a JSON findings block; raw output: ${rawPath}`).toBeTruthy();
      const findings = JSON.parse(jsonMatch![1]);

      expect(findings.dimension).toBe("simplification-impact");
      expect(
        hasSimplificationImpactGap(findings.findings),
        `simplification-impact must flag additive-only workflow changes without related-area simplification evidence; raw output: ${rawPath}`,
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Behavioral: Phase 4.5 produces structured plan fields (Policy 10 proof)
// ---------------------------------------------------------------------------

describe("Behavioral: kaizen-evaluate Phase 4.5 produces structured plan (Policy 10)", () => {
  it.skipIf(!isLive)(
    "INVARIANT: agent using Phase 4.5 steps produces GOAL: and DONE WHEN fields",
    async () => {
      // Policy 10 requires behavioral proof for SKILL.md changes.
      // Before Phase 4.5: agents wrote plans as unstructured task lists with
      // no GOAL/DONE WHEN fields — the plan was a list of actions, not a
      // statement of what 'done' looks like from the outside.
      // After Phase 4.5: an agent given the phase text produces a structured
      // plan with GOAL: and DONE WHEN fields as the first output.
      //
      // This test extracts Phase 4.5 from the SKILL.md and asks haiku to
      // follow it for a simple issue. The output must contain the fields
      // the phase prescribes.
      const skillText = loadSkill("kaizen-evaluate");
      const phase45 = skillText.split("### Phase 4.5:")[1]?.split("### Phase 4:")[0] ?? "";
      expect(phase45.length, "Phase 4.5 section must exist in SKILL.md").toBeGreaterThan(100);

      const prompt = `${phase45}

## Apply Phase 4.5 to this issue

Issue: "When the CLI tool crashes, the error message shows 'undefined' instead of the actual error text. Users cannot diagnose failures."

Complete Steps 1 and 2 (success criteria extraction and existing tools survey) and output the plan in the schema shown above.`;

      const output = await runSkill(prompt, { maxBudget: 0.20, timeout: 120_000 });

      // Phase 4.5 Step 1 requires GOAL: and DONE WHEN: fields in the plan output
      expect(output).toContain("GOAL:");
      expect(output).toContain("DONE WHEN");
    },
  );
});
