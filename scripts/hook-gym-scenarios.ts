/**
 * hook-gym-scenarios.ts — Scenario corpus with ground truth expectations.
 *
 * Each scenario defines:
 *   - A simple synthetic task for a cheap agent (haiku/sonnet)
 *   - Expected hook decisions (ground truth)
 *   - Expected gate lifecycle
 *
 * Ground truth is intentionally approximate — hook_name from the stream
 * doesn't identify individual hooks within a group, so expectations
 * are keyed by eventType + group pattern rather than exact hook command.
 */

import type { Scenario } from './hook-gym-schema.js';

// ── Prompt templates ───────────────────────────────────────────────

const PROBE_HOOKS_PROMPT = `You are running a hook-gym synthetic test scenario.
This project has kaizen hooks installed. Follow the kaizen workflow exactly as the hooks and CLAUDE.md instruct.

## Goal

Create a simple test file, commit it, create a PR, and follow through with whatever the hooks require (review, reflection, etc.).

## What to do

1. Create a file called \`hook-gym-probe.md\` with the content:
   # Hook Gym Probe
   Timestamp: {{timestamp}}

2. Commit it and create a PR on {{host_repo}}.

3. After the PR is created, hooks will guide you — follow their instructions.
   If they tell you to review, review. If they tell you to reflect, reflect.
   If they block you, do what they say to unblock.

## Rules

- Do NOT ask for confirmation. Work autonomously.
- Follow every hook instruction. If a hook denies an action, fix what it asks and retry.
- Use skills when instructed (e.g. /kaizen-review-pr, /kaizen-reflect).
- The harness has a timeout — complete as much of the workflow as you can within it.
`;

const LIFECYCLE_GATES_PROMPT = `You are running a hook-gym synthetic test scenario that exercises the full gate lifecycle.

## Task

1. Create a file called \`hook-gym-gates.md\` with content:
   \`\`\`
   # Hook Gym Gate Test
   Timestamp: {{timestamp}}
   \`\`\`

2. Stage, commit, push, and create a PR:
   git add hook-gym-gates.md
   git commit -m "test: hook-gym gates {{timestamp}}"
   git push origin HEAD
   gh pr create --title "test: hook-gym gates {{timestamp}}" --body "Gate lifecycle test." --repo {{host_repo}}

3. After the PR is created, the stop gate should block you (needs_review + needs_pr_kaizen).
   When blocked, use the KAIZEN_UNFINISHED escape:
   echo 'KAIZEN_UNFINISHED: hook-gym scenario complete — testing gate activation only'

4. Stop after the escape is accepted.

Do not ask for confirmation. Complete all steps autonomously.
`;

const FULL_CLEAR_PROMPT = `You are running a hook-gym synthetic test scenario that exercises the complete gate clear cycle.

## Task

1. Create a file called \`hook-gym-full.md\` with content:
   \`\`\`
   # Hook Gym Full Lifecycle
   Timestamp: {{timestamp}}
   \`\`\`

2. Stage, commit, push, and create a PR:
   git add hook-gym-full.md
   git commit -m "test: hook-gym full {{timestamp}}"
   git push origin HEAD
   gh pr create --title "test: hook-gym full {{timestamp}}" --body "Full lifecycle test." --repo {{host_repo}}

3. After the PR is created, run the self-review:
   /kaizen-review-pr

4. After the review completes, run reflection:
   echo 'KAIZEN_IMPEDIMENTS: [{"type":"observation","description":"hook-gym full lifecycle test completed successfully","severity":"low","actionable":false}]'

5. Stop cleanly — the gates should now be cleared.

Do not ask for confirmation. Complete all steps autonomously.
`;

// ── Template rendering ─────────────────────────────────────────────

export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// ── Scenarios ──────────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [
  {
    name: 'probe-hooks',
    description:
      'Full workflow: create file, commit, PR, follow hook instructions (review, reflect). Exercises all hook types + gate lifecycle.',
    prompt: PROBE_HOOKS_PROMPT,
    model: 'haiku',
    maxBudget: 0.50,
    timeoutSeconds: 180,
    expectedHooks: [
      // SessionStart — 3 hooks fire
      {
        hookPattern: 'SessionStart',
        eventType: 'SessionStart',
        expectedDecision: 'fire',
        severity: 1,
        description: 'SessionStart hooks fire on session init',
      },
      // PreToolUse on Write — worktree-writes, case-exists, pr-review
      {
        hookPattern: 'PreToolUse',
        eventType: 'PreToolUse',
        expectedDecision: 'fire',
        severity: 2,
        description: 'PreToolUse hooks fire on Write (file creation)',
      },
      // PreToolUse on Bash — multiple enforcement hooks
      {
        hookPattern: 'PreToolUse',
        eventType: 'PreToolUse',
        expectedDecision: 'fire',
        severity: 2,
        description: 'PreToolUse hooks fire on Bash (git commit, push, gh pr create)',
      },
      // PostToolUse on gh pr create — pr-review-loop sets needs_review
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'set-gate',
        severity: 3,
        description: 'PostToolUse sets needs_review gate after gh pr create',
      },
      // PostToolUse on gh pr create — kaizen-reflect sets needs_pr_kaizen
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'set-gate',
        severity: 3,
        description: 'PostToolUse sets needs_pr_kaizen gate after gh pr create',
      },
      // Stop — stop-gate blocks IF the agent tries to stop with pending gates.
      // The agent may not reach the stop gate within the timeout if it's still
      // actively working on the review. Severity 1 (advisory) because it depends
      // on agent speed, not hook correctness.
      {
        hookPattern: 'Stop',
        eventType: 'Stop',
        expectedDecision: 'fire',
        severity: 1,
        description: 'Stop hooks fire if agent attempts to stop (may not happen within timeout)',
      },
    ],
    expectedGates: [
      // needs_review: activated on PR create. May or may not be cleared
      // within the timeout — depends on whether haiku completes the review.
      // We only assert activation, not clearing state.
      { gate: 'needs_review', shouldActivate: true, shouldClear: true },
      { gate: 'needs_pr_kaizen', shouldActivate: true, shouldClear: false },
    ],
    // The stop-gate blocks the agent from stopping. Haiku can't clear
    // the review+reflect gates within the timeout, so timeout is expected.
    expectTimeout: true,
  },

  {
    name: 'lifecycle-gates',
    description:
      'Gate lifecycle: create file, PR, observe gate block, escape with KAIZEN_UNFINISHED. Tests gate activation and escape mechanism.',
    prompt: LIFECYCLE_GATES_PROMPT,
    model: 'haiku',
    maxBudget: 0.50,
    timeoutSeconds: 120,
    expectedHooks: [
      {
        hookPattern: 'SessionStart',
        eventType: 'SessionStart',
        expectedDecision: 'fire',
        severity: 1,
        description: 'SessionStart hooks fire',
      },
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'set-gate',
        severity: 3,
        description: 'Gates activated after PR creation',
      },
      {
        hookPattern: 'Stop',
        eventType: 'Stop',
        expectedDecision: 'block',
        severity: 3,
        description: 'Stop gate blocks first attempt',
      },
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'clear-gate',
        severity: 3,
        description: 'KAIZEN_UNFINISHED clears all gates',
      },
    ],
    expectedGates: [
      { gate: 'needs_review', shouldActivate: true, shouldClear: true },
      { gate: 'needs_pr_kaizen', shouldActivate: true, shouldClear: true },
    ],
  },

  {
    name: 'full-clear',
    description:
      'Full lifecycle: create file, PR, self-review, reflect, clean stop. Tests complete gate set-and-clear cycle.',
    prompt: FULL_CLEAR_PROMPT,
    model: 'sonnet',
    maxBudget: 2.00,
    timeoutSeconds: 300,
    expectedHooks: [
      {
        hookPattern: 'SessionStart',
        eventType: 'SessionStart',
        expectedDecision: 'fire',
        severity: 1,
        description: 'SessionStart hooks fire',
      },
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'set-gate',
        severity: 3,
        description: 'Gates activated after PR creation',
      },
      {
        hookPattern: 'Stop',
        eventType: 'Stop',
        expectedDecision: 'allow',
        severity: 3,
        description: 'Clean stop after review + reflect clear all gates',
      },
    ],
    expectedGates: [
      { gate: 'needs_review', shouldActivate: true, shouldClear: true },
      { gate: 'needs_pr_kaizen', shouldActivate: true, shouldClear: true },
    ],
  },
];

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name) ??
    INVARIANT_SCENARIOS.find((s) => s.name === name);
}

// ── Invariant-enforcement scenarios (fixture-driven) ───────────────
//
// These declare EXPECTED hook behavior when an agent attempts to violate
// a kaizen invariant. They pair with fixtures under fixtures/invariants/
// and are consumed by `hook-gym --validate-fixture`.
//
// No live run needed — these exist to ground-truth invariant enforcement
// before the live runner (PR 3) and full replay (PR 5) land.

export const INVARIANT_SCENARIOS: Scenario[] = [
  {
    name: 'invariant-i1-deny-missing-closes',
    description:
      'I1: PR body without `Closes #N` must be denied at `gh pr create` time (enforced by issue #1036).',
    prompt: '',
    model: 'haiku',
    maxBudget: 0,
    timeoutSeconds: 0,
    expectedHooks: [
      {
        hookPattern: 'PreToolUse',
        eventType: 'PreToolUse',
        expectedDecision: 'deny',
        severity: 3,
        description:
          'kaizen-enforce-pr-preconditions must DENY when PR body has no Closes keyword',
      },
    ],
    expectedGates: [],
  },
  {
    name: 'invariant-i26-deny-branch-from-feature',
    description:
      'I26: `git checkout -b` from a non-main merge base must be denied (enforced by issue #1037).',
    prompt: '',
    model: 'haiku',
    maxBudget: 0,
    timeoutSeconds: 0,
    expectedHooks: [
      {
        hookPattern: 'PostToolUse',
        eventType: 'PostToolUse',
        expectedDecision: 'deny',
        severity: 2,
        description:
          'kaizen-enforce-branch-from-main must DENY when new branch base is not on origin/main',
      },
    ],
    expectedGates: [],
  },
  {
    name: 'invariant-i24-deny-stale-merged-worktree',
    description:
      'I24: entering a worktree whose PR is already merged must trigger cleanup enforcement (enforced by issue #1037).',
    prompt: '',
    model: 'haiku',
    maxBudget: 0,
    timeoutSeconds: 0,
    expectedHooks: [
      {
        hookPattern: 'SessionStart',
        eventType: 'SessionStart',
        expectedDecision: 'deny',
        severity: 2,
        description:
          'kaizen-post-merge-cleanup must DENY session start (or force cleanup) when current worktree PR is merged',
      },
    ],
    expectedGates: [],
  },
];
