/**
 * enforce-plan-stored.test.ts — E2E adversarial test for the plan enforcement hook.
 *
 * Scenario: An agent tries to create a PR without storing a plan first.
 * The hook should DENY `gh pr create` when no plan exists on the linked issue.
 *
 * This test runs the actual hook shell shim (kaizen-enforce-plan-stored-ts.sh)
 * via the hook-runner, simulating what Claude Code does when the agent calls
 * the Bash tool with `gh pr create`.
 *
 * The gh mock returns no plan comments for the issue, simulating an agent
 * that skipped the planning step entirely (the #1054 incident).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";

import {
  runHook,
  bashPre,
  denies,
  allows,
  denyReason,
  createMockDir,
  createStateDir,
  type MockDir,
  type StateDir,
} from "./hook-runner.js";
import { isDocsOnly } from "../hooks/enforce-plan-stored.js";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const HOOKS_DIR = join(KAIZEN_ROOT, ".claude", "hooks");

function hookPath(name: string): string {
  return join(HOOKS_DIR, name);
}

let mockDir: MockDir;
let stateDir: StateDir;

function hookEnv(): Record<string, string> {
  return {
    STATE_DIR: stateDir.path,
    AUDIT_DIR: join(stateDir.path, "audit"),
    PATH: mockDir.pathWithMocks,
    DEBUG_LOG: "/dev/null",
    IPC_DIR: join(stateDir.path, "ipc"),
    HOOK_TIMING_SENTINEL_DISABLED: "true",
    KAIZEN_HOOK_TRACE: "0",
  };
}

function addGitMockForPlan(mockDir: MockDir, branch: string): void {
  const script = `#!/bin/bash
if echo "$@" | grep -q "rev-parse --abbrev-ref"; then
  echo "${branch}"
  exit 0
fi
if echo "$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/kaizen.git"
  exit 0
fi
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/hooks/new-feature.ts"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --show-toplevel"; then
  pwd
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-dir"; then
  echo ".git/worktrees/test"
  exit 0
fi
if echo "$@" | grep -q "rev-parse --git-common-dir"; then
  echo ".git"
  exit 0
fi
if echo "$@" | grep -q "log main..HEAD"; then
  exit 0
fi
if echo "$@" | grep -q "config --get kaizen.issue"; then
  # No declared issue — forces fallback path in the hook
  exit 1
fi
/usr/bin/git "$@" 2>/dev/null
`;
  writeFileSync(join(mockDir.path, "git"), script);
  chmodSync(join(mockDir.path, "git"), 0o755);
}

/**
 * gh mock that returns NO plan comments for any issue.
 * This simulates the agent skipping store-plan entirely.
 */
function addGhMockNoPlan(mockDir: MockDir): void {
  const script = `#!/bin/bash
# Return empty comments for issue view (no plan stored)
if echo "$@" | grep -q "issue view"; then
  if echo "$@" | grep -q "comments"; then
    echo ""
    exit 0
  fi
fi
# Return empty for API calls (no plan attachment)
if echo "$@" | grep -q "api.*comments"; then
  echo "[]"
  exit 0
fi
exit 0
`;
  writeFileSync(join(mockDir.path, "gh"), script);
  chmodSync(join(mockDir.path, "gh"), 0o755);
}

beforeEach(() => {
  mockDir = createMockDir();
  stateDir = createStateDir();
});

afterEach(() => {
  mockDir?.cleanup();
  stateDir?.cleanup();
});

describe("E2E: enforce-plan-stored hook — adversarial scenario", () => {
  it("DENIES gh pr create when agent skips storing a plan (the #1054 scenario)", () => {
    addGitMockForPlan(mockDir, "k1055-enforce-plan");
    addGhMockNoPlan(mockDir);

    const event = bashPre(
      'gh pr create --title "feat: new feature" --body "$(cat <<\'EOF\'\n## Summary\nDid stuff\n\nCloses #1055\nEOF\n)"',
    );

    const result = runHook(
      hookPath("kaizen-enforce-plan-stored-ts.sh"),
      event,
      { env: hookEnv() },
    );

    expect(denies(result), `Hook should deny: stdout='${result.stdout}'`).toBe(true);
    const reason = denyReason(result);
    expect(reason).toContain("BLOCKED");
    expect(reason).toContain("plan");
    expect(reason).toContain("/kaizen-write-plan");
  });

  it("ALLOWS non-pr-create commands even without a plan", () => {
    addGitMockForPlan(mockDir, "k1055-enforce-plan");
    addGhMockNoPlan(mockDir);

    const event = bashPre("npm test");
    const result = runHook(
      hookPath("kaizen-enforce-plan-stored-ts.sh"),
      event,
      { env: hookEnv() },
    );

    expect(allows(result), `Hook should allow npm test: stdout='${result.stdout}'`).toBe(true);
  });

  it("DENIES gh pr create without Closes #N (no issue link)", () => {
    addGitMockForPlan(mockDir, "random-branch-no-issue");
    addGhMockNoPlan(mockDir);

    const event = bashPre(
      'gh pr create --title "sneaky" --body "no issue link here"',
    );
    const result = runHook(
      hookPath("kaizen-enforce-plan-stored-ts.sh"),
      event,
      { env: hookEnv() },
    );

    expect(denies(result), `Hook should deny no-issue PR: stdout='${result.stdout}'`).toBe(true);
    expect(denyReason(result)).toContain("no issue declared");
  });
});

// ── Negative control: removing the hook must break the enforcement guarantee ──
// This test codifies the PR-body claim "removing the hook makes tests fail".
// If the hook shim is disabled, the tests above would pass through — which is
// exactly the failure mode I8 exists to prevent. This test ensures the hook is
// LOAD-BEARING, not decorative.

describe("E2E: negative control — the hook IS the enforcement", () => {
  it("without the hook shim, gh pr create is NOT denied (proves hook is load-bearing)", () => {
    addGitMockForPlan(mockDir, "k1055-enforce-plan");
    addGhMockNoPlan(mockDir);

    const event = bashPre(
      'gh pr create --title "x" --body "Closes #1055"',
    );

    // Run a no-op shim (empty script). This simulates "hook removed".
    const noopShim = `${mockDir.path}/noop-hook.sh`;
    require("node:fs").writeFileSync(noopShim, "#!/bin/bash\nexit 0\n");
    require("node:fs").chmodSync(noopShim, 0o755);

    const noopResult = runHook(noopShim, event, { env: hookEnv() });
    expect(allows(noopResult)).toBe(true);

    // Now run the real hook against the same event → DENY.
    const realResult = runHook(hookPath("kaizen-enforce-plan-stored-ts.sh"), event, { env: hookEnv() });
    expect(denies(realResult), `real hook should deny: stdout='${realResult.stdout}'`).toBe(true);
  });
});

// ── Loophole: single-source-file + docs is NOT docs-only ──
// Regression test for the claim: `isDocsOnly` returns false when ANY source
// file is in the changeset, even if docs are present.

describe("E2E: single source + docs bypass attempt", () => {
  it("mixed changeset (1 source + many docs) is NOT exempt from plan gate", () => {
    // We unit-test this property directly — E2E repro would require running
    // with a real diff, but the unit-level invariant is what closes the loophole.
    expect(isDocsOnly(["README.md", "docs/a.md", "src/just-one.ts"])).toBe(false);
    expect(isDocsOnly(["README.md", "docs/a.md"])).toBe(true);
    expect(isDocsOnly([])).toBe(false); // empty → not docs-only (conservative)
  });
});
