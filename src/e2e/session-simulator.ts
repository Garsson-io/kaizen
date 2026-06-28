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
  readdirSync,
  existsSync,
  rmSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { KAIZEN_PLUGIN_SOURCE } from "../kaizen-plugin-identity.js";
import { KAIZEN_ROOT, resolveTypeScriptHookRunner } from "./test-runtime.js";

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

const HOOKS_DIR = join(KAIZEN_ROOT, ".claude", "hooks");

// ── Hook Registry (derived from plugin.json) ──

export interface SessionHookRegistry {
  SessionStart: string[];
  PreToolUseBash: string[];
  PreToolUseWrite: string[];
  PostToolUseBash: string[];
  Stop: string[];
}

export interface PluginHookCommand {
  command?: string;
}

export interface PluginHookGroup {
  matcher?: string;
  hooks?: PluginHookCommand[];
}

export interface PluginManifest {
  hooks?: Record<string, PluginHookGroup[]>;
}

const PLUGIN_JSON_PATH = join(KAIZEN_ROOT, ".claude-plugin", "plugin.json");

function hookFilename(command: string): string | null {
  const match = command.match(/\.claude\/hooks\/([^"\s]+)$/);
  if (match?.[1]) return match[1];
  const name = basename(command);
  return name.endsWith(".sh") ? name : null;
}

function hookNames(groups: PluginHookGroup[] | undefined, matcher?: RegExp): string[] {
  const names: string[] = [];
  for (const group of groups ?? []) {
    if (matcher && !matcher.test(group.matcher ?? "")) continue;
    for (const hook of group.hooks ?? []) {
      if (!hook.command) continue;
      const name = hookFilename(hook.command);
      if (name) names.push(name);
    }
  }
  return names;
}

export function buildHookRegistryFromManifest(manifest: PluginManifest): SessionHookRegistry {
  const hooks = manifest.hooks ?? {};
  return {
    SessionStart: hookNames(hooks.SessionStart),
    PreToolUseBash: hookNames(hooks.PreToolUse, /(^|\|)Bash(\||$)/),
    PreToolUseWrite: hookNames(hooks.PreToolUse, /(^|\|)(Edit|Write|NotebookEdit)(\||$)/),
    PostToolUseBash: hookNames(hooks.PostToolUse, /(^|\|)Bash(\||$)/),
    Stop: hookNames(hooks.Stop),
  };
}

export function loadDefaultHookRegistry(): SessionHookRegistry {
  const manifest = JSON.parse(readFileSync(PLUGIN_JSON_PATH, "utf-8")) as PluginManifest;
  return buildHookRegistryFromManifest(manifest);
}

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
  hooks = loadDefaultHookRegistry();

  private fakeHome: string;
  private stateDir: string;
  private auditDir: string;
  private counterFile: string;
  private mockDir: MockDir;
  private steps: StepResult[] = [];
  private hookTimeout: number;
  private typeScriptRunnerBin: string | undefined;

  constructor(opts?: { hookTimeout?: number }) {
    this.hookTimeout = opts?.hookTimeout ?? 5000;
    this.typeScriptRunnerBin = resolveTypeScriptHookRunner()?.command;
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
          enabledPlugins: { [KAIZEN_PLUGIN_SOURCE]: true, "other-plugin@1.0": true },
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

  stateFiles(): string[] {
    try {
      return readdirSync(this.stateDir).sort();
    } catch {
      return [];
    }
  }

  stateFileContents(filename: string): string {
    return readFileSync(join(this.stateDir, filename), "utf-8");
  }

  stateFilesContaining(content: string): string[] {
    return this.stateFiles().filter(filename =>
      this.stateFileContents(filename).includes(content),
    );
  }

  stateSummary(): string {
    const files = this.stateFiles();
    if (files.length === 0) return "(no state files)";
    return files
      .map(filename => `--- ${filename} ---\n${this.stateFileContents(filename)}`)
      .join("\n");
  }

  stepStderr(index: number): string {
    const step = this.steps[index];
    if (!step) return "";
    return step.results.map(r => r.stderr).join("\n");
  }

  homeHasKaizen(): boolean {
    const settingsPath = join(this.fakeHome, ".claude", "settings.json");
    if (!existsSync(settingsPath)) return false;
    return readFileSync(settingsPath, "utf-8").includes(`"${KAIZEN_PLUGIN_SOURCE}"`);
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
          HOOK_TIMING_SENTINEL_DISABLED: "true",
          SEND_TELEGRAM_IPC_DISABLED: "true",
          ...(this.typeScriptRunnerBin ? { KAIZEN_TSX_BIN: this.typeScriptRunnerBin } : {}),
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
