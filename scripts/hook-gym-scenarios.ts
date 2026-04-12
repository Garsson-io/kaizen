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

## Task

Create a simple test file, commit it, and create a PR. Follow these exact steps:

1. Create a file called \`hook-gym-probe.md\` with content:
   \`\`\`
   # Hook Gym Probe
   Timestamp: {{timestamp}}
   \`\`\`

2. Stage and commit:
   git add hook-gym-probe.md
   git commit -m "test: hook-gym probe {{timestamp}}"

3. Push and create PR:
   git push origin HEAD
   gh pr create --title "test: hook-gym probe {{timestamp}}" --body "Synthetic hook-gym scenario. Auto-close after capture." --repo {{host_repo}}

4. After creating the PR, stop. Do NOT merge, do NOT run review, do NOT reflect.
   The harness will capture hook behavior and clean up.

Do not ask for confirmation. Complete all steps autonomously.
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
      'Minimal: create file, commit, PR. Exercises SessionStart, PreToolUse (Write+Bash), PostToolUse (PR create), Stop gate.',
    prompt: PROBE_HOOKS_PROMPT,
    model: 'haiku',
    maxBudget: 0.50,
    timeoutSeconds: 120,
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
      // Stop — stop-gate blocks with pending gates
      {
        hookPattern: 'Stop',
        eventType: 'Stop',
        expectedDecision: 'block',
        severity: 3,
        description: 'Stop gate blocks with 2 pending gates (needs_review + needs_pr_kaizen)',
      },
    ],
    expectedGates: [
      { gate: 'needs_review', shouldActivate: true, shouldClear: false },
      { gate: 'needs_pr_kaizen', shouldActivate: true, shouldClear: false },
    ],
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
  return SCENARIOS.find((s) => s.name === name);
}
