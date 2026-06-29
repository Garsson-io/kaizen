import { describe, expect, it } from "vitest";

import { allows, bashPre, denies, denyReason, runHook } from "./hook-runner.js";

const HOOK = ".claude/hooks/kaizen-block-git-rebase.sh";

function runCommand(command: string) {
  return runHook(HOOK, bashPre(command), {
    env: {
      ...process.env,
      DEBUG_LOG: "/dev/null",
      HOOK_TIMING_SENTINEL_DISABLED: "true",
      SEND_TELEGRAM_IPC_DISABLED: "true",
      KAIZEN_TEST_RUNNER: "1",
    },
  });
}

describe("kaizen-block-git-rebase live wrapper", () => {
  it.each([
    "git rebase origin/main",
    "git rebase main",
    "git rebase -i HEAD~3",
    "git rebase --onto main feature",
    "git -C /some/path rebase origin/main",
    "echo 'hello' && git rebase origin/main",
  ])("blocks dangerous rebase command: %s", (command) => {
    const result = runCommand(command);

    expect(denies(result), `${command}: ${result.stdout}`).toBe(true);
  });

  it("suggests the merge alternative for a blocked rebase", () => {
    const result = runCommand("git rebase origin/main");

    expect(denies(result), result.stdout).toBe(true);
    expect(denyReason(result)).toContain("git merge origin/main");
  });

  it.each([
    "git rebase --abort",
    "git rebase --continue",
    "git rebase --skip",
    "git merge origin/main",
    "git push origin feature",
    "git log --oneline -5",
    "npm run build",
  ])("allows recovery or non-rebase command: %s", (command) => {
    const result = runCommand(command);

    expect(allows(result), `${command}: ${result.stdout}`).toBe(true);
  });

  it("explains force-push risk in the blocking message", () => {
    const result = runCommand("git rebase origin/main");

    expect(denyReason(result)).toContain("force-push");
  });

  it.each([
    "echo 'use git rebase to fix it'",
    "# git rebase origin/main",
  ])("does not block textual mention: %s", (command) => {
    const result = runCommand(command);

    expect(allows(result), `${command}: ${result.stdout}`).toBe(true);
  });
});
