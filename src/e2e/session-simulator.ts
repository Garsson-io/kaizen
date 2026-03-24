/**
 * session-simulator.ts — Session-level hook simulation harness.
 *
 * Builds on hook-runner.ts to simulate complete Claude Code sessions:
 * fires all registered hooks for each event type in sequence, collects
 * per-step and session-wide results, and provides environment presets
 * for testing shared lib interactions (scope-guard, telemetry, state).
 *
 * Usage:
 *   const session = new SessionSimulator();
 *   session.setHome("bad_kaizen_install");
 *   session.fireSessionStart();
 *   session.fireBashPre("echo hello");
 *   session.fireStop();
 *   expect(session.warningCount).toBe(1);
 *   session.cleanup();
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  runHook,
  bashPre,
  bashPost,
  writePre,
  stopEvent,
  createMockDir,
  addGitMock,
  addGhMock,
  type HookResult,
  type HookEvent,
  type MockDir,
} from "./hook-runner.js";

// ── Constants ──

const KAIZEN_ROOT = resolve(__dirname, "../..");
const HOOKS_DIR = join(KAIZEN_ROOT, ".claude", "hooks");
// ── Hook Registry (matches plugin.json) ──

const DEFAULT_HOOKS = {
  SessionStart: [
    "kaizen-check-wip.sh",
    "kaizen-session-cleanup.sh",
  ],
  PreToolUseBash: [
    "kaizen-enforce-pr-review-ts.sh",
    "kaizen-enforce-case-worktree.sh",
    "kaizen-check-test-coverage.sh",
    "kaizen-check-verification.sh",
    "kaizen-check-dirty-files-ts.sh",
    "kaizen-enforce-pr-reflect-ts.sh",
    "kaizen-warn-code-quality.sh",
    "kaizen-check-practices.sh",
    "kaizen-block-git-rebase.sh",
    "kaizen-search-before-file.sh",
  ],
  PreToolUseWrite: [
    "kaizen-enforce-worktree-writes.sh",
    "kaizen-enforce-case-exists.sh",
    "kaizen-enforce-pr-review-ts.sh",
  ],
  PostToolUseBash: [
    "kaizen-post-merge-clear.sh",
    "kaizen-pr-kaizen-clear-fallback.sh",
    "kaizen-capture-worktree-context.sh",
  ],
  Stop: [
    "kaizen-stop-gate.sh",
    "kaizen-verify-before-stop.sh",
    "kaizen-check-cleanup-on-stop.sh",
  ],
};

// ── Types ──

export type HomePreset = "bad_kaizen_install" | "clean" | "no_settings";

export interface StepResult {
  eventType: string;
  results: HookResult[];
}

export interface MockCommandOpts {
  exit?: number;
  stdout?: string;
  script?: string;
}

// ── SessionSimulator ──

export class SessionSimulator {
  /** Hook registry — modify to include/exclude hooks per test. */
  hooks = structuredClone(DEFAULT_HOOKS);

  private fakeHome: string;
  private stateDir: string;
  private auditDir: string;
  private counterFile: string;
  private mockDir: MockDir;
  private steps: StepResult[] = [];
  private hookTimeout: number;

  constructor(opts?: { hookTimeout?: number }) {
    this.hookTimeout = opts?.hookTimeout ?? 5000;
    this.fakeHome = mkdtempSync(join(tmpdir(), "ses-home-"));
    this.stateDir = mkdtempSync(join(tmpdir(), "ses-state-"));
    this.auditDir = mkdtempSync(join(tmpdir(), "ses-audit-"));
    // Each session gets its own counter file to avoid parallel test interference
    this.counterFile = join(this.stateDir, ".scope-guard-counter");
    this.mockDir = createMockDir();

    // Default mocks so hooks that call git/gh don't crash
    addGitMock(this.mockDir);
    addGhMock(this.mockDir);

    // Clean counter file
    this.removeCounter();

    // Create minimal HOME structure
    mkdirSync(join(this.fakeHome, ".claude"), { recursive: true });
  }

  // ── Environment Presets ──

  setHome(preset: HomePreset): void {
    const settingsPath = join(this.fakeHome, ".claude", "settings.json");
    switch (preset) {
      case "bad_kaizen_install":
        writeFileSync(settingsPath, JSON.stringify({
          enabledPlugins: { "kaizen@kaizen": true, "other-plugin@1.0": true },
        }, null, 2));
        break;
      case "clean":
        writeFileSync(settingsPath, JSON.stringify({
          enabledPlugins: { "other-plugin@1.0": true },
        }, null, 2));
        break;
      case "no_settings":
        if (existsSync(settingsPath)) unlinkSync(settingsPath);
        break;
    }
  }

  setHomeRaw(content: string): void {
    writeFileSync(join(this.fakeHome, ".claude", "settings.json"), content);
  }

  setCounter(value: number): void {
    writeFileSync(this.counterFile, String(value));
  }

  mockCommand(name: string, opts: MockCommandOpts): void {
    let script = "#!/bin/bash\n";
    if (opts.script) {
      script += opts.script;
    } else if (opts.stdout !== undefined) {
      script += `echo "${opts.stdout}"\n`;
    }
    if (opts.exit !== undefined) {
      script += `exit ${opts.exit}\n`;
    }
    const path = join(this.mockDir.path, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  injectState(filename: string, content: string): void {
    writeFileSync(join(this.stateDir, filename), content);
  }

  // ── Event Firing ──

  fireSessionStart(): StepResult {
    const event = {
      session_id: `test-session-${process.pid}`,
      transcript_path: "/tmp/test-transcript.txt",
      cwd: process.cwd(),
      permission_mode: "default",
      hook_event_name: "SessionStart" as const,
    };
    return this.fireEvent("SessionStart", this.hooks.SessionStart, event);
  }

  fireBashPre(command: string): StepResult {
    return this.fireEvent("PreToolUse Bash", this.hooks.PreToolUseBash, bashPre(command));
  }

  fireWritePre(filePath: string): StepResult {
    return this.fireEvent("PreToolUse Write", this.hooks.PreToolUseWrite, writePre(filePath));
  }

  fireBashPost(command: string, stdout: string, opts?: { exitCode?: string }): StepResult {
    return this.fireEvent(
      "PostToolUse Bash",
      this.hooks.PostToolUseBash,
      bashPost(command, stdout, { exitCode: opts?.exitCode }),
    );
  }

  fireStop(): StepResult {
    return this.fireEvent("Stop", this.hooks.Stop, stopEvent());
  }

  // ── Session-wide Queries ──

  get warningCount(): number {
    return this.allStderr.split("\n")
      .filter(line => line.includes("[kaizen] WARNING")).length;
  }

  get timeoutCount(): number {
    return this.steps
      .flatMap(s => s.results)
      .filter(r => r.timedOut).length;
  }

  get totalHooksRun(): number {
    return this.steps.reduce((sum, s) => sum + s.results.length, 0);
  }

  get allStderr(): string {
    return this.steps
      .flatMap(s => s.results)
      .map(r => r.stderr)
      .join("\n");
  }

  get allResults(): HookResult[] {
    return this.steps.flatMap(s => s.results);
  }

  stepStderr(index: number): string {
    const step = this.steps[index];
    if (!step) return "";
    return step.results.map(r => r.stderr).join("\n");
  }

  homeHasKaizen(): boolean {
    const settingsPath = join(this.fakeHome, ".claude", "settings.json");
    if (!existsSync(settingsPath)) return false;
    return readFileSync(settingsPath, "utf-8").includes('"kaizen@kaizen"');
  }

  settingsJson(): string {
    const settingsPath = join(this.fakeHome, ".claude", "settings.json");
    if (!existsSync(settingsPath)) return "";
    return readFileSync(settingsPath, "utf-8");
  }

  counterExists(): boolean {
    return existsSync(this.counterFile);
  }

  counterValue(): number {
    if (!existsSync(this.counterFile)) return 0;
    return parseInt(readFileSync(this.counterFile, "utf-8").trim(), 10) || 0;
  }

  // ── Cleanup ──

  cleanup(): void {
    rmSync(this.fakeHome, { recursive: true, force: true });
    rmSync(this.stateDir, { recursive: true, force: true });
    rmSync(this.auditDir, { recursive: true, force: true });
    this.mockDir.cleanup();
  }

  // ── Internals ──

  private fireEvent(eventType: string, hookNames: string[], event: HookEvent | Record<string, unknown>): StepResult {
    const results: HookResult[] = [];

    for (const hookName of hookNames) {
      const hookPath = join(HOOKS_DIR, hookName);
      if (!existsSync(hookPath)) continue;

      const result = runHook(hookPath, event as HookEvent, {
        timeout: this.hookTimeout,
        env: {
          HOME: this.fakeHome,
          KAIZEN_TELEMETRY_DISABLED: "1",
          KAIZEN_SCOPE_GUARD_COUNTER: this.counterFile,
          AUDIT_LOG: "/dev/null",
          AUDIT_DIR: this.auditDir,
          STATE_DIR: this.stateDir,
          DEBUG_LOG: "/dev/null",
          PATH: this.mockDir.pathWithMocks,
        },
      });
      results.push(result);
    }

    const step: StepResult = { eventType, results };
    this.steps.push(step);
    return step;
  }

  private removeCounter(): void {
    try { unlinkSync(this.counterFile); } catch { /* ignore */ }
  }
}
