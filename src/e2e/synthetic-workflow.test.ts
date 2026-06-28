/**
 * synthetic-workflow.test.ts — E2E session lifecycle tests.
 *
 * Uses SessionSimulator to model realistic Claude Code sessions. A dedicated
 * smoke test fires ALL registered hooks; repeated behavior tests use narrower
 * representative hook profiles. Tests that:
 *   1. scope-guard auto-fix propagates across a session
 *   2. Hooks compose correctly across event types (SessionStart → PreToolUse → Stop)
 *   3. No hook hangs or crashes in expected environments
 *
 * This is the test that would have caught the #758 deadlock — it detects
 * timeouts across the full session, not just individual hook behavior.
 */

import { describe, it, expect } from "vitest";
import { SessionSimulator } from "./session-simulator.js";

type HookRegistry = SessionSimulator["hooks"];
type HookProfile = "full" | "scope-guard" | "representative";

function hookCount(hooks: HookRegistry): number {
  return Object.values(hooks).reduce((sum, names) => sum + names.length, 0);
}

function profileHooks(profile: HookProfile, hooks: HookRegistry): HookRegistry {
  if (profile === "full") return hooks;

  if (profile === "scope-guard") {
    return {
      SessionStart: ["kaizen-session-cleanup-ts.sh"],
      PreToolUseBash: ["kaizen-block-git-rebase.sh"],
      PreToolUseWrite: ["kaizen-enforce-worktree-writes.sh"],
      PostToolUseBash: ["kaizen-capture-worktree-context.sh"],
      Stop: ["kaizen-verify-before-stop.sh"],
    };
  }

  return {
    SessionStart: ["kaizen-session-cleanup-ts.sh"],
    PreToolUseBash: ["kaizen-block-git-rebase.sh"],
    PreToolUseWrite: ["kaizen-enforce-worktree-writes.sh"],
    PostToolUseBash: ["kaizen-pr-kaizen-clear-fallback.sh"],
    Stop: ["kaizen-verify-before-stop.sh"],
  };
}

function createSession(profile: HookProfile = "full"): SessionSimulator {
  const session = new SessionSimulator();
  session.hooks = profileHooks(profile, session.hooks);
  return session;
}

function withSession<T>(profile: HookProfile, fn: (session: SessionSimulator) => T): T {
  const session = createSession(profile);
  try {
    return fn(session);
  } finally {
    session.cleanup();
  }
}

describe("Synthetic Workflow E2E", () => {
  describe("runtime profile invariant", () => {
    it("keeps repeated behavior profiles narrower than the full wrapper matrix", () => {
      const full = createSession("full");
      const scopeGuard = createSession("scope-guard");
      const representative = createSession("representative");
      try {
        expect(hookCount(full.hooks)).toBeGreaterThan(15);
        expect(hookCount(scopeGuard.hooks)).toBeLessThan(hookCount(full.hooks));
        expect(hookCount(representative.hooks)).toBeLessThan(hookCount(full.hooks));
        expect(scopeGuard.hooks.SessionStart).toEqual(["kaizen-session-cleanup-ts.sh"]);
      } finally {
        full.cleanup();
        scopeGuard.cleanup();
        representative.cleanup();
      }
    });
  });

  describe("scope-guard propagation", () => {
    it.concurrent("auto-fixes on first hook; subsequent representative hooks take fast path", () => withSession("scope-guard", (session) => {
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
    }));

    it.concurrent("clean HOME produces zero warnings", () => withSession("scope-guard", (session) => {
      session.setHome("clean");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.warningCount).toBe(0);
      expect(session.timeoutCount).toBe(0);
    }));

    it.concurrent("counter cap shows manual instructions without auto-fix", () => withSession("scope-guard", (session) => {
      session.setHome("bad_kaizen_install");
      session.setCounter(3);

      session.fireSessionStart();

      expect(session.allStderr).toContain("Manual fix");
      expect(session.homeHasKaizen()).toBe(true);
    }));

    it.concurrent("no settings.json is a graceful noop", () => withSession("scope-guard", (session) => {
      session.setHome("no_settings");

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.warningCount).toBe(0);
      expect(session.timeoutCount).toBe(0);
    }));

    it.concurrent("malformed settings.json doesn't crash any representative hook", () => withSession("scope-guard", (session) => {
      // Has "kaizen@kaizen" as a string but enabledPlugins is not an object
      session.setHomeRaw('{"enabledPlugins": "not_an_object_but_has_kaizen@kaizen"}');

      session.fireSessionStart();
      session.fireBashPre("echo hello");
      session.fireStop();

      expect(session.timeoutCount).toBe(0);
    }));

    it.concurrent("other plugins preserved after auto-fix", () => withSession("scope-guard", (session) => {
      session.setHome("bad_kaizen_install");

      session.fireSessionStart();

      const settings = JSON.parse(session.settingsJson());
      expect(settings.enabledPlugins["other-plugin@1.0"]).toBe(true);
      expect(settings.enabledPlugins).not.toHaveProperty("kaizen@kaizen");
    }));
  });

  describe("session lifecycle composition", () => {
    it("full session completes with no timeouts", () => {
      withSession("full", (session) => {
        session.setHome("clean");

        session.fireSessionStart();
        session.fireBashPre("echo hello");
        session.fireWritePre("src/feature.ts");
        session.fireBashPre("git commit -m 'add feature'");
        session.fireBashPost("gh pr create --title test", "https://github.com/test/repo/pull/1");
        session.fireStop();

        expect(session.timeoutCount).toBe(0);
        expect(session.totalHooksRun).toBeGreaterThan(0);
        expect(hookCount(session.hooks)).toBeGreaterThan(15);
      });
    });

    it.concurrent("different event types fire representative hook sets", () => withSession("representative", (session) => {
      session.setHome("clean");

      const startResult = session.fireSessionStart();
      const bashResult = session.fireBashPre("echo hello");
      const writeResult = session.fireWritePre("src/test.ts");
      const postResult = session.fireBashPost("echo hello", "hello");
      const stopResult = session.fireStop();

      // Each event type still fires at least one real shell hook.
      expect(startResult.results.length).toBeGreaterThan(0);
      expect(bashResult.results.length).toBeGreaterThan(0);
      expect(writeResult.results.length).toBeGreaterThan(0);
      expect(postResult.results.length).toBeGreaterThan(0);
      expect(stopResult.results.length).toBeGreaterThan(0);
    }));

    it.concurrent("hook registry can be customized per test", () => withSession("representative", (session) => {
      session.setHome("clean");

      // Only fire block-git-rebase for PreToolUse Bash
      session.hooks.PreToolUseBash = ["kaizen-block-git-rebase.sh"];

      const result = session.fireBashPre("echo hello");
      expect(result.results.length).toBe(1);
      expect(result.results[0].exitCode).toBe(0);
    }));
  });
});
