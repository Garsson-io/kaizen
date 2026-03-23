/**
 * scope-guard.test.ts — Unit tests for .claude/hooks/lib/scope-guard.sh
 *
 * Tests the shared lib in isolation by running `bash scope-guard.sh` with
 * different HOME environments. scope-guard auto-runs on source (line 75),
 * so running it as a standalone script exercises the full path.
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
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const KAIZEN_ROOT = resolve(__dirname, "../..");
const SCOPE_GUARD = join(KAIZEN_ROOT, ".claude", "hooks", "lib", "scope-guard.sh");
const COUNTER_FILE = "/tmp/.kaizen-scope-guard-fix-attempts";

function runScopeGuard(home: string): { stderr: string; exitCode: number } {
  const result = spawnSync("bash", [SCOPE_GUARD], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, PATH: process.env.PATH },
    timeout: 5000,
  });
  return {
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? 1,
  };
}

function removeCounter(): void {
  try { unlinkSync(COUNTER_FILE); } catch { /* ignore */ }
}

describe("scope-guard.sh", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "sg-test-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    removeCounter();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    removeCounter();
  });

  it("no settings.json — noop, no warning", () => {
    // Don't create settings.json
    const { stderr, exitCode } = runScopeGuard(fakeHome);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("clean settings (no kaizen@kaizen) — fast grep exit, no warning", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard(fakeHome);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("kaizen@kaizen as string value (not in enabledPlugins) — grep matches but no fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ someKey: "kaizen@kaizen", enabledPlugins: { "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard(fakeHome);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // settings.json unchanged
    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.enabledPlugins).toEqual({ "other@1.0": true });
  });

  it("bad install — auto-fixes and emits warning", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true, "other@1.0": true } }),
    );
    const { stderr, exitCode } = runScopeGuard(fakeHome);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("auto-removed");

    // settings.json fixed
    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.enabledPlugins).not.toHaveProperty("kaizen@kaizen");
    expect(settings.enabledPlugins).toHaveProperty("other@1.0");
  });

  it("counter cleaned up after successful fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    runScopeGuard(fakeHome);
    expect(existsSync(COUNTER_FILE)).toBe(false);
  });

  it("counter cap at 3 — manual instructions, no auto-fix", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    writeFileSync(COUNTER_FILE, "3");

    const { stderr, exitCode } = runScopeGuard(fakeHome);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Manual fix");
    expect(stderr).toContain("persists after 3");

    // settings.json NOT fixed
    const content = readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8");
    expect(content).toContain("kaizen@kaizen");
  });

  it("counter resets between successful fixes", () => {
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "kaizen@kaizen": true } }),
    );
    writeFileSync(COUNTER_FILE, "1");

    runScopeGuard(fakeHome);
    // Successful fix should clean counter
    expect(existsSync(COUNTER_FILE)).toBe(false);
  });
});
