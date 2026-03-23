/**
 * scope-guard.test.ts — Unit tests for .claude/hooks/lib/scope-guard.sh
 *
 * Tests the shared lib in isolation by running `bash scope-guard.sh` with
 * different HOME environments. scope-guard auto-runs on source (line 75),
 * so running it as a standalone script exercises the full path.
 *
 * Each test gets its own counter file via KAIZEN_SCOPE_GUARD_COUNTER env var
 * to avoid interference when vitest runs test files in parallel.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const SCOPE_GUARD = join(KAIZEN_ROOT, ".claude", "hooks", "lib", "scope-guard.sh");

describe("scope-guard.sh", () => {
  let fakeHome: string;
  let counterFile: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "sg-test-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    counterFile = join(fakeHome, ".scope-guard-counter");
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // projectDir simulates a project that has its own plugin.json (double-install scenario)
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "sg-project-"));
    mkdirSync(join(projectDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(projectDir, ".claude-plugin", "plugin.json"), '{"name":"kaizen"}');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function runScopeGuard(opts?: { noProjectPlugin?: boolean }): { stderr: string; exitCode: number } {
    const result = spawnSync("bash", [SCOPE_GUARD], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: fakeHome,
        KAIZEN_SCOPE_GUARD_COUNTER: counterFile,
        CLAUDE_PROJECT_DIR: opts?.noProjectPlugin ? fakeHome : projectDir,
        PATH: process.env.PATH,
      },
      timeout: 5000,
    });
    return {
      stderr: (result.stderr ?? "").trim(),
      exitCode: result.status ?? 1,
    };
  }

  it("no settings.json — noop, no warning", () => {
    const { stderr, exitCode } = runScopeGuard();
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("clean settings (no kaizen@kaizen) — fast grep exit, no warning", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard();
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("kaizen@kaizen as string value (not in enabledPlugins) — grep matches but no fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ someKey: "kaizen@kaizen", enabledPlugins: { "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard();
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.enabledPlugins).toEqual({ "other@1.0": true });
  });

  it("user-level only (no project plugin) — leaves kaizen@kaizen alone", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true, "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard({ noProjectPlugin: true });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // kaizen@kaizen should still be there
    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.enabledPlugins).toHaveProperty("kaizen@kaizen");
  });

  it("double-install — auto-fixes and emits warning", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true, "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("double kaizen install detected");

    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.enabledPlugins).not.toHaveProperty("kaizen@kaizen");
    expect(settings.enabledPlugins).toHaveProperty("other@1.0");
  });

  it("counter cleaned up after successful fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    runScopeGuard();
    expect(existsSync(counterFile)).toBe(false);
  });

  it("counter cap at 3 — manual instructions, no auto-fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    writeFileSync(counterFile, "3");

    const { stderr, exitCode } = runScopeGuard();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Manual fix");
    expect(stderr).toContain("persists after 3");

    const content = readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8");
    expect(content).toContain("kaizen@kaizen");
  });

  it("counter resets between successful fixes", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    writeFileSync(counterFile, "1");

    runScopeGuard();
    expect(existsSync(counterFile)).toBe(false);
  });
});
