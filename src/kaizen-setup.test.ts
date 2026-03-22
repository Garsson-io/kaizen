import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  detectInstall,
  generateConfig,
  scaffoldPolicies,
  setupSymlinks,
  mergeHooks,
  verifySetup,
} from "./kaizen-setup.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kaizen-setup-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("detectInstall", () => {
  it("detects plugin install via CLAUDE_PLUGIN_ROOT", () => {
    const result = detectInstall({ cwd: tempDir, env: { CLAUDE_PLUGIN_ROOT: "/plugins/kaizen" } });
    expect(result).toEqual({ step: "detect", status: "ok", method: "plugin", root: "/plugins/kaizen", needsInstall: true });
  });

  it("detects submodule via .kaizen/.claude-plugin", () => {
    mkdirSync(join(tempDir, ".kaizen", ".claude-plugin"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result).toEqual({ step: "detect", status: "ok", method: "submodule", root: ".kaizen", needsInstall: true });
  });

  it("detects submodule via .kaizen/.claude", () => {
    mkdirSync(join(tempDir, ".kaizen", ".claude"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result).toEqual({ step: "detect", status: "ok", method: "submodule", root: ".kaizen", needsInstall: true });
  });

  it("reports needsInstall=false when node_modules exists", () => {
    mkdirSync(join(tempDir, ".kaizen", ".claude"), { recursive: true });
    mkdirSync(join(tempDir, ".kaizen", "node_modules"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result.needsInstall).toBe(false);
  });

  it("returns none when nothing found", () => {
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result).toEqual({ step: "detect", status: "ok", method: "none", root: "" });
  });

  it("plugin takes priority over submodule", () => {
    mkdirSync(join(tempDir, ".kaizen", ".claude-plugin"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: { CLAUDE_PLUGIN_ROOT: "/plugins/kaizen" } });
    expect(result.method).toBe("plugin");
  });
});

describe("generateConfig", () => {
  it("generates valid JSON config", () => {
    const result = generateConfig({ name: "my-project", repo: "org/my-project", description: "A test project" }, tempDir);
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.name).toBe("my-project");
    expect(config.host.repo).toBe("org/my-project");
    expect(config.kaizen.repo).toBe("Garsson-io/kaizen");
    expect(config.notifications.channel).toBe("none");
  });

  it("handles special characters in name", () => {
    const result = generateConfig({ name: 'project "with quotes"', repo: "org/repo", description: "has 'quotes' and \"doubles\"" }, tempDir);
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.name).toBe('project "with quotes"');
  });

  it("includes caseCli when provided", () => {
    const result = generateConfig({ name: "p", repo: "o/r", description: "d", caseCli: "npx tsx src/cli.ts" }, tempDir);
    expect(result.status).toBe("ok");

    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host.caseCli).toBe("npx tsx src/cli.ts");
  });

  it("omits caseCli when not provided", () => {
    generateConfig({ name: "p", repo: "o/r", description: "d" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.host).not.toHaveProperty("caseCli");
  });

  it("errors on missing required fields", () => {
    const result = generateConfig({ name: "", repo: "o/r", description: "d" }, tempDir);
    expect(result.status).toBe("error");
  });

  it("uses custom kaizen repo", () => {
    generateConfig({ name: "p", repo: "o/r", description: "d", kaizenRepo: "other/kaizen" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.kaizen.repo).toBe("other/kaizen");
  });
});

describe("scaffoldPolicies", () => {
  it("creates policies-local.md", () => {
    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("ok");
    expect(existsSync(join(tempDir, ".claude", "kaizen", "policies-local.md"))).toBe(true);
  });

  it("skips if already exists", () => {
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "existing content");

    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("skipped");

    const content = readFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "utf-8");
    expect(content).toBe("existing content");
  });
});

describe("setupSymlinks", () => {
  let kaizenDir: string;

  beforeEach(() => {
    // Create a fake kaizen repo structure
    kaizenDir = join(tempDir, ".kaizen");
    mkdirSync(join(kaizenDir, ".claude", "skills", "kaizen-reflect"), { recursive: true });
    mkdirSync(join(kaizenDir, ".claude", "skills", "kaizen-pick"), { recursive: true });
    mkdirSync(join(kaizenDir, ".claude", "kaizen"), { recursive: true });
    mkdirSync(join(kaizenDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(kaizenDir, ".claude", "skills", "kaizen-reflect", "SKILL.md"), "# Reflect");
    writeFileSync(join(kaizenDir, ".claude", "skills", "kaizen-pick", "SKILL.md"), "# Pick");
    writeFileSync(join(kaizenDir, ".claude", "kaizen", "zen.md"), "# Zen");
    writeFileSync(join(kaizenDir, ".claude", "agents", "kaizen-bg.md"), "# Agent");
  });

  it("creates symlinks for skills, docs, and agents", () => {
    const result = setupSymlinks(tempDir, ".kaizen");
    expect(result.status).toBe("ok");
    expect(result.created).toBeGreaterThanOrEqual(4); // 2 skills + kaizen docs + 1 agent

    expect(lstatSync(join(tempDir, ".claude", "skills", "kaizen-reflect")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(tempDir, ".claude", "skills", "kaizen-pick")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(tempDir, ".claude", "skills", "kaizen-reflect", "SKILL.md"))).toBe(true);
  });

  it("is idempotent — re-running replaces existing symlinks", () => {
    setupSymlinks(tempDir, ".kaizen");
    const result = setupSymlinks(tempDir, ".kaizen");
    expect(result.status).toBe("ok");
    expect(result.errors).toHaveLength(0);
  });

  it("errors when kaizen source doesn't exist", () => {
    const result = setupSymlinks(tempDir, ".nonexistent");
    expect(result.status).toBe("error");
  });
});

describe("mergeHooks", () => {
  let kaizenDir: string;

  beforeEach(() => {
    kaizenDir = join(tempDir, ".kaizen");
    mkdirSync(join(kaizenDir, ".claude"), { recursive: true });
    writeFileSync(
      join(kaizenDir, ".claude", "settings-fragment.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "kaizen-check.sh" }] },
          ],
        },
      })
    );
  });

  it("creates settings.json when none exists", () => {
    const result = mergeHooks(tempDir, ".kaizen");
    expect(result.status).toBe("ok");
    expect(result.hookCount).toBe(1);

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("merges into existing settings without duplication", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tempDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "host-check.sh" }] },
          ],
        },
      })
    );

    const result = mergeHooks(tempDir, ".kaizen");
    expect(result.status).toBe("ok");

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toHaveLength(2); // host + kaizen
  });

  it("is idempotent — re-running doesn't duplicate", () => {
    mergeHooks(tempDir, ".kaizen");
    mergeHooks(tempDir, ".kaizen");

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1); // not 2
  });

  it("rewrites hook paths for self-dogfood (kaizenRoot = '.')", () => {
    // Fragment uses .kaizen/ prefix by default
    writeFileSync(
      join(kaizenDir, ".claude", "settings-fragment.json"),
      JSON.stringify({
        _install_prefix: ".kaizen/.claude/hooks/",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "./.kaizen/.claude/hooks/kaizen-stop.sh" }] },
          ],
        },
      })
    );

    // Self-dogfood: kaizenRoot is "." but fragment lives in .kaizen/
    // We need the fragment to exist at the resolved path, so create it at "." too
    const selfDir = tempDir;
    mkdirSync(join(selfDir, ".claude"), { recursive: true });
    writeFileSync(
      join(selfDir, ".claude", "settings-fragment.json"),
      JSON.stringify({
        _install_prefix: ".kaizen/.claude/hooks/",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "./.kaizen/.claude/hooks/kaizen-stop.sh" }] },
          ],
        },
      })
    );

    const result = mergeHooks(tempDir, ".");
    expect(result.status).toBe("ok");

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("./.claude/hooks/kaizen-stop.sh");
  });

  it("keeps .kaizen/ prefix for host projects (kaizenRoot = '.kaizen')", () => {
    writeFileSync(
      join(kaizenDir, ".claude", "settings-fragment.json"),
      JSON.stringify({
        _install_prefix: ".kaizen/.claude/hooks/",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "./.kaizen/.claude/hooks/kaizen-stop.sh" }] },
          ],
        },
      })
    );

    const result = mergeHooks(tempDir, ".kaizen");
    expect(result.status).toBe("ok");

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("./.kaizen/.claude/hooks/kaizen-stop.sh");
  });

  it("preserves existing non-hook settings", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["npm"] } }));

    mergeHooks(tempDir, ".kaizen");

    const settings = JSON.parse(readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("npm");
  });
});

describe("verifySetup", () => {
  it("reports all failures for empty project", () => {
    const result = verifySetup(tempDir, "plugin");
    expect(result.status).toBe("failed");
    expect(result.failed).toBeGreaterThan(0);
  });

  it("passes for complete plugin setup", () => {
    // Create expected files
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Project\n\n## Kaizen\nkaizen stuff");

    const result = verifySetup(tempDir, "plugin");
    expect(result.status).toBe("ok");
    expect(result.failed).toBe(0);
  });

  it("checks symlinks and hooks for submodule installs", () => {
    const result = verifySetup(tempDir, "submodule");
    // Should have extra checks for symlinks and hooks
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("skill-symlinks");
    expect(checkNames).toContain("hooks-registered");
  });
});
