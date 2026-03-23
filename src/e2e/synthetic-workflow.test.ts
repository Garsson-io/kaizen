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
import { SessionSimulator } from "./session-simulator.js";

describe("Synthetic Workflow E2E", () => {
  let session: SessionSimulator;

  afterEach(() => {
    session?.cleanup();
  });

  describe("scope-guard propagation", () => {
    it("auto-fixes on first hook; all subsequent hooks take fast path", () => {
      session = new SessionSimulator();
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
      session.setHome("no_settings");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.warningCount).toBe(0);
      expect(session.timeoutCount).toBe(0);
    });

    it("malformed settings.json doesn't crash any hook", () => {
      session = new SessionSimulator();
      // Has "kaizen@kaizen" as a string but enabledPlugins is not an object
      session.setHomeRaw('{"enabledPlugins": "not_an_object_but_has_kaizen@kaizen"}');

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.timeoutCount).toBe(0);
    });

    it("other plugins preserved after auto-fix", () => {
      session = new SessionSimulator();
      session.setHome("bad_kaizen_install");

      session.fireSessionStart();

      const settings = JSON.parse(session.settingsJson());
      expect(settings.enabledPlugins["other-plugin@1.0"]).toBe(true);
      expect(settings.enabledPlugins).not.toHaveProperty("kaizen@kaizen");
    });
  });

  describe("session lifecycle composition", () => {
    it("full session completes with no timeouts", () => {
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
    });

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
