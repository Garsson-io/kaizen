/**
 * synthetic-workflow.test.ts — E2E session lifecycle tests.
 *
 * Uses SessionSimulator to model realistic Claude Code sessions, firing
 * ALL registered hooks for each event type. Tests that:
 *   1. scope-guard auto-fix propagates across all hooks in a session
 *   2. Hooks compose correctly across event types (SessionStart → PreToolUse → Stop)
 *   3. No hook hangs or crashes in expected environments
 *
 * This is the test that would have caught the #758 deadlock — it detects
 * timeouts across the full session, not just individual hook behavior.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildHookRegistryFromManifest, SessionSimulator, type PluginManifest } from "./session-simulator.js";
import { resolveTsxBin } from "./test-runtime.js";

describe("Synthetic Workflow E2E", () => {
  let session: SessionSimulator;

  afterEach(() => {
    session?.cleanup();
  });

  function useScopeGuardFocusedHooks(session: SessionSimulator): void {
    session.hooks.SessionStart = ["kaizen-check-wip.sh"];
    session.hooks.PreToolUseBash = [
      "kaizen-enforce-case-worktree.sh",
      "kaizen-block-git-rebase.sh",
      "kaizen-search-before-file.sh",
    ];
    session.hooks.PreToolUseWrite = [
      "kaizen-enforce-worktree-writes.sh",
      "kaizen-enforce-case-exists.sh",
    ];
    session.hooks.Stop = [
      "kaizen-verify-before-stop.sh",
      "kaizen-check-cleanup-on-stop.sh",
    ];
  }

  function expectStateFilesContaining(session: SessionSimulator, content: string, count: number): void {
    const files = session.stateFilesContaining(content);
    expect(files, `Expected ${count} state file(s) containing ${content}\n${session.stateSummary()}`).toHaveLength(count);
  }

  function expectTsxAvailable(): void {
    expect(resolveTsxBin(), "tsx is required for PR workflow outcome E2E tests").toBeTruthy();
  }

  describe("scope-guard propagation", () => {
    it("auto-fixes on first hook; all subsequent hooks take fast path", () => {
      session = new SessionSimulator();
      useScopeGuardFocusedHooks(session);
      session.setHome("bad_kaizen_install");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireWritePre("src/test.ts");
      session.fireBashPre("git commit -m test");
      session.fireStop();

      expect(session.warningCount).toBe(1);
      expect(session.homeHasKaizen()).toBe(false);
      expect(session.settingsJson()).toContain("other-plugin@1.0");
      expect(session.counterExists()).toBe(false);
      expect(session.timeoutCount).toBe(0);
    });

    it("clean HOME produces zero warnings", () => {
      session = new SessionSimulator();
      useScopeGuardFocusedHooks(session);
      session.setHome("clean");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.warningCount).toBe(0);
      expect(session.timeoutCount).toBe(0);
    });

    it("counter cap shows manual instructions without auto-fix", () => {
      session = new SessionSimulator();
      session.setHome("bad_kaizen_install");
      session.setCounter(3);

      session.fireSessionStart();

      expect(session.allStderr).toContain("Manual fix");
      expect(session.homeHasKaizen()).toBe(true);
    });

    it("no settings.json is a graceful noop", () => {
      session = new SessionSimulator();
      useScopeGuardFocusedHooks(session);
      session.setHome("no_settings");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.warningCount).toBe(0);
      expect(session.timeoutCount).toBe(0);
    });

    it("malformed settings.json doesn't crash any hook", () => {
      session = new SessionSimulator();
      useScopeGuardFocusedHooks(session);
      // Has "kaizen@kaizen" as a string but enabledPlugins is not an object
      session.setHomeRaw('{"enabledPlugins": "not_an_object_but_has_kaizen@kaizen"}');

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.timeoutCount).toBe(0);
    });

    it("other plugins preserved after auto-fix", () => {
      session = new SessionSimulator();
      useScopeGuardFocusedHooks(session);
      session.setHome("bad_kaizen_install");

      session.fireSessionStart();

      const settings = JSON.parse(session.settingsJson());
      expect(settings.enabledPlugins["other-plugin@1.0"]).toBe(true);
      expect(settings.enabledPlugins).not.toHaveProperty("kaizen@kaizen");
    });
  });

  describe("session lifecycle composition", () => {
    it("fires the manifest PR workflow hooks in PostToolUse Bash sessions", () => {
      session = new SessionSimulator();

      expect(session.hooks.PostToolUseBash).toEqual(
        expect.arrayContaining([
          "pr-review-loop-ts.sh",
          "kaizen-reflect-ts.sh",
          "pr-kaizen-clear-ts.sh",
        ]),
      );
    });

    it("reports state files and contents for assertion diagnostics", () => {
      session = new SessionSimulator();
      session.injectState("gate-a", "STATUS=needs_review\nPR_URL=https://example.test/pr/1\n");

      expect(session.stateFiles()).toEqual(["gate-a"]);
      expect(session.stateFilesContaining("STATUS=needs_review")).toEqual(["gate-a"]);
      expect(session.stateSummary()).toContain("--- gate-a ---");
      expect(session.stateSummary()).toContain("PR_URL=https://example.test/pr/1");
    });

    it("classifies hook registry groups from a synthetic manifest fixture", () => {
      const manifest: PluginManifest = {
        hooks: {
          SessionStart: [
            { hooks: [{ command: ".claude/hooks/session-start.sh" }] },
          ],
          PreToolUse: [
            { matcher: "Bash", hooks: [{ command: ".claude/hooks/bash-only.sh" }] },
            { matcher: "Bash|Edit", hooks: [{ command: ".claude/hooks/bash-and-edit.sh" }] },
            { matcher: "NotebookEdit|Write", hooks: [{ command: ".claude/hooks/write-family.sh" }] },
            { matcher: "Read", hooks: [{ command: ".claude/hooks/read-only.sh" }] },
          ],
          PostToolUse: [
            { matcher: "Edit", hooks: [{ command: ".claude/hooks/post-edit.sh" }] },
            { matcher: "Bash|Write", hooks: [{ command: ".claude/hooks/post-bash.sh" }] },
          ],
          Stop: [
            { hooks: [{ command: "bash .claude/hooks/stop.sh" }] },
          ],
        },
      };

      expect(buildHookRegistryFromManifest(manifest)).toEqual({
        SessionStart: ["session-start.sh"],
        PreToolUseBash: ["bash-only.sh", "bash-and-edit.sh"],
        PreToolUseWrite: ["bash-and-edit.sh", "write-family.sh"],
        PostToolUseBash: ["post-bash.sh"],
        Stop: ["stop.sh"],
      });
    });

    it("does not set PR workflow gates for failed PR creation outcomes", () => {
      expectTsxAvailable();
      session = new SessionSimulator();
      session.setHome("clean");

      session.fireBashPost("gh pr create --title test", "", {
        exitCode: "1",
      });

      expectStateFilesContaining(session, "STATUS=needs_review", 0);
      expectStateFilesContaining(session, "STATUS=needs_pr_kaizen", 0);
    });

    it("sets persisted PR workflow gates for successful PR creation outcomes", () => {
      expectTsxAvailable();
      session = new SessionSimulator();
      session.setHome("clean");

      session.fireBashPost(
        "gh pr create --title test",
        "https://github.com/Garsson-io/kaizen/pull/943",
      );

      expectStateFilesContaining(session, "STATUS=needs_review", 1);
      expectStateFilesContaining(session, "STATUS=needs_pr_kaizen", 1);

      const stopResult = session.fireStop();
      expect(stopResult.results.some((result) => result.stdout.includes('"decision":"block"'))).toBe(true);
      expect(stopResult.results.some((result) => result.stdout.includes("PR REVIEW"))).toBe(true);
      expect(stopResult.results.some((result) => result.stdout.includes("KAIZEN REFLECTION"))).toBe(true);
    });

    it("full manifest session completes with no hook timeouts", () => {
      expectTsxAvailable();
      session = new SessionSimulator();
      session.setHome("clean");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireWritePre("src/feature.ts");
      session.fireBashPre("git commit -m 'add feature'");
      session.fireBashPost("gh pr create --title test", "https://github.com/test/repo/pull/1");
      session.fireStop();

      expect(session.timeoutCount).toBe(0);
      expect(session.totalHooksRun).toBeGreaterThan(0);
    }, 30_000);

    it("different event types fire different hook sets", () => {
      session = new SessionSimulator();
      session.setHome("clean");

      const startResult = session.fireSessionStart();
      const bashResult = session.fireBashPre("echo hello");
      const writeResult = session.fireWritePre("src/test.ts");
      const stopResult = session.fireStop();

      // Each event type fires a different number of hooks
      // (exact counts depend on which hooks exist on disk)
      expect(startResult.results.length).toBeGreaterThan(0);
      expect(bashResult.results.length).toBeGreaterThan(0);
      expect(writeResult.results.length).toBeGreaterThan(0);
      expect(stopResult.results.length).toBeGreaterThan(0);
    });

    it("hook registry can be customized per test", () => {
      session = new SessionSimulator();
      session.setHome("clean");

      // Only fire block-git-rebase for PreToolUse Bash
      session.hooks.PreToolUseBash = ["kaizen-block-git-rebase.sh"];

      const result = session.fireBashPre("echo hello");
      expect(result.results.length).toBe(1);
      expect(result.results[0].exitCode).toBe(0);
    });
  });
});
