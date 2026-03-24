import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { fileURLToPath } from "url";
import {
  detectInstall,
  generateConfig,
  scaffoldPolicies,
  verifySetup,
  verifyPluginContract,
  postUpdateValidate,
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

  it("reports needsInstall=false when node_modules exists", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
    const result = detectInstall({ cwd: tempDir, env: { CLAUDE_PLUGIN_ROOT: pluginRoot } });
    expect(result.needsInstall).toBe(false);
  });

  it("returns none when CLAUDE_PLUGIN_ROOT is not set", () => {
    const result = detectInstall({ cwd: tempDir, env: {} });
    expect(result).toEqual({ step: "detect", status: "ok", method: "none", root: "" });
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
    generateConfig({ name: "p", repo: "o/r", description: "d", caseCli: "npx tsx src/cli.ts" }, tempDir);
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

  it("sets issues.repo to host repo for host projects", () => {
    generateConfig({ name: "p", repo: "org/host-app", description: "d" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.issues.repo).toBe("org/host-app");
    expect(config.issues.label).toBe("kaizen");
  });

  it("sets empty issues.label for self-dogfood mode", () => {
    generateConfig({ name: "p", repo: "Garsson-io/kaizen", description: "d" }, tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8"));
    expect(config.issues.repo).toBe("Garsson-io/kaizen");
    expect(config.issues.label).toBe("");
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

describe("verifySetup", () => {
  it("reports all failures for empty project", () => {
    const result = verifySetup(tempDir);
    expect(result.status).toBe("failed");
    expect(result.failed).toBeGreaterThan(0);
  });

  it("passes for complete plugin setup", () => {
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Project\n\n## Kaizen\nkaizen stuff");

    const result = verifySetup(tempDir);
    expect(result.status).toBe("ok");
    expect(result.failed).toBe(0);
  });

  it("detects missing config", () => {
    const result = verifySetup(tempDir);
    const configCheck = result.checks.find(c => c.name === "config-exists");
    expect(configCheck?.ok).toBe(false);
  });

  it("detects invalid config JSON", () => {
    writeFileSync(join(tempDir, "kaizen.config.json"), "not json");
    const result = verifySetup(tempDir);
    const configCheck = result.checks.find(c => c.name === "config-valid");
    expect(configCheck?.ok).toBe(false);
  });

  it("detects missing CLAUDE.md", () => {
    const result = verifySetup(tempDir);
    const check = result.checks.find(c => c.name === "claudemd-exists");
    expect(check?.ok).toBe(false);
  });

  it("detects CLAUDE.md without kaizen content", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Project\nNo plugin content here.");
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    const result = verifySetup(tempDir);
    const check = result.checks.find(c => c.name === "claudemd-kaizen");
    expect(check?.ok).toBe(false);
  });

  it("includes plugin contract checks when pluginRoot is provided", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "skills", "my-skill"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude", "hooks", "my-hook.sh"), "#!/bin/bash\nexit 0");
    writeFileSync(join(pluginRoot, ".claude", "skills", "my-skill", "SKILL.md"), "# My Skill");
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      skills: "./.claude/skills/",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/my-hook.sh" }] }],
      },
    }));

    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    expect(result.status).toBe("ok");
    expect(result.checks.some(c => c.name.startsWith("hook-"))).toBe(true);
    expect(result.checks.some(c => c.name.startsWith("skill-"))).toBe(true);
    expect(result.checks.some(c => c.name.startsWith("matcher-"))).toBe(true);
  });
});

describe("verifyPluginContract", () => {
  it("returns failure when plugin.json is missing", () => {
    const result = verifyPluginContract(tempDir);
    expect(result.hookPaths).toHaveLength(1);
    expect(result.hookPaths[0].ok).toBe(false);
    expect(result.hookPaths[0].detail).toContain("not found");
  });

  it("returns failure for invalid plugin.json", () => {
    mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), "not json");
    const result = verifyPluginContract(tempDir);
    expect(result.hookPaths).toHaveLength(1);
    expect(result.hookPaths[0].ok).toBe(false);
    expect(result.hookPaths[0].detail).toContain("invalid JSON");
  });

  it("validates hook command paths exist", () => {
    mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(tempDir, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "hooks", "good-hook.sh"), "#!/bin/bash");
    writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [
          { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/good-hook.sh" },
          { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/missing-hook.sh" },
        ] }],
      },
    }));

    const result = verifyPluginContract(tempDir);
    expect(result.hookPaths).toHaveLength(2);
    expect(result.hookPaths[0].ok).toBe(true);
    expect(result.hookPaths[1].ok).toBe(false);
    expect(result.hookPaths[1].detail).toContain("missing");
  });

  it("validates skill directories contain SKILL.md", () => {
    mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(tempDir, ".claude", "skills", "good-skill"), { recursive: true });
    mkdirSync(join(tempDir, ".claude", "skills", "bad-skill"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "skills", "good-skill", "SKILL.md"), "# Skill");
    writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      skills: "./.claude/skills/",
      hooks: {},
    }));

    const result = verifyPluginContract(tempDir);
    expect(result.skillDirs).toHaveLength(2);
    const good = result.skillDirs.find(c => c.name === "skill-good-skill");
    const bad = result.skillDirs.find(c => c.name === "skill-bad-skill");
    expect(good?.ok).toBe(true);
    expect(bad?.ok).toBe(false);
    expect(bad?.detail).toContain("missing SKILL.md");
  });

  it("validates matcher regex patterns compile", () => {
    mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash|Edit", hooks: [] },
          { matcher: "[invalid(regex", hooks: [] },
        ],
      },
    }));

    const result = verifyPluginContract(tempDir);
    expect(result.matchers).toHaveLength(2);
    expect(result.matchers[0].ok).toBe(true);
    expect(result.matchers[1].ok).toBe(false);
    expect(result.matchers[1].detail).toContain("invalid regex");
  });

  it("reports missing skills directory", () => {
    mkdirSync(join(tempDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(tempDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      skills: "./.claude/skills/",
      hooks: {},
    }));

    const result = verifyPluginContract(tempDir);
    expect(result.skillDirs).toHaveLength(1);
    expect(result.skillDirs[0].ok).toBe(false);
    expect(result.skillDirs[0].detail).toContain("not found");
  });

  it("validates the real kaizen plugin.json", () => {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = resolve(thisFile, "../..");
    const result = verifyPluginContract(projectRoot);
    const failedHooks = result.hookPaths.filter(c => !c.ok);
    const failedSkills = result.skillDirs.filter(c => !c.ok);
    const failedMatchers = result.matchers.filter(c => !c.ok);
    expect(failedHooks).toEqual([]);
    expect(failedSkills).toEqual([]);
    expect(failedMatchers).toEqual([]);
  });
});

describe("postUpdateValidate", () => {
  it("succeeds when build and test pass", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      scripts: { build: "echo ok", test: "echo ok" },
    }));

    const result = postUpdateValidate(tempDir);
    expect(result.step).toBe("post-update-validate");
    expect(result.status).toBe("ok");
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toEqual({ name: "build", ok: true });
    expect(result.checks[1]).toEqual({ name: "test", ok: true });
  });

  it("reports failure when build fails", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      scripts: { build: "echo 'compile error' >&2 && exit 1", test: "echo ok" },
    }));

    const result = postUpdateValidate(tempDir);
    expect(result.status).toBe("failed");
    expect(result.checks[0].name).toBe("build");
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].output).toContain("compile error");
  });

  it("reports failure when tests fail", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      scripts: { build: "echo ok", test: "echo 'test failure' >&2 && exit 1" },
    }));

    const result = postUpdateValidate(tempDir);
    expect(result.status).toBe("failed");
    expect(result.checks[0]).toEqual({ name: "build", ok: true });
    expect(result.checks[1].name).toBe("test");
    expect(result.checks[1].ok).toBe(false);
    expect(result.checks[1].output).toContain("test failure");
  });

  it("reports both failures when build and test both fail", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      scripts: { build: "exit 1", test: "exit 1" },
    }));

    const result = postUpdateValidate(tempDir);
    expect(result.status).toBe("failed");
    expect(result.checks.filter(c => !c.ok)).toHaveLength(2);
  });

  it("truncates long error output", () => {
    const longOutput = "x".repeat(1000);
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      scripts: { build: `echo '${longOutput}' >&2 && exit 1`, test: "echo ok" },
    }));

    const result = postUpdateValidate(tempDir);
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].output!.length).toBeLessThanOrEqual(500);
  });
});

describe("verifySetup — skill metadata validation", () => {
  it("detects missing skill dependencies", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "skills", "skill-a"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude", "skills", "skill-a", "SKILL.md"), `---
name: skill-a
description: A skill
depends_on: [skill-b]
---
# Skill A`);
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      version: "1.0.78",
      skills: "./.claude/skills/",
      hooks: {},
    }));

    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    const depCheck = result.checks.find(c => c.name === "skill-dep-skill-a");
    expect(depCheck).toBeDefined();
    expect(depCheck!.ok).toBe(false);
    expect(depCheck!.detail).toContain("skill-b");
  });

  it("passes when skill dependencies are satisfied", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "skills", "skill-a"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "skills", "skill-b"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude", "skills", "skill-a", "SKILL.md"), `---
name: skill-a
description: A
depends_on: [skill-b]
---`);
    writeFileSync(join(pluginRoot, ".claude", "skills", "skill-b", "SKILL.md"), `---
name: skill-b
description: B
---`);
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      version: "1.0.78",
      skills: "./.claude/skills/",
      hooks: {},
    }));

    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    const depCheck = result.checks.find(c => c.name === "skill-dependencies");
    expect(depCheck).toBeDefined();
    expect(depCheck!.ok).toBe(true);
  });

  it("detects incompatible skill versions", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude", "skills", "future-skill"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude", "skills", "future-skill", "SKILL.md"), `---
name: future-skill
description: Needs newer version
min_version: "2.0.0"
---`);
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      version: "1.0.78",
      skills: "./.claude/skills/",
      hooks: {},
    }));

    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".claude", "kaizen"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "kaizen", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    const versionCheck = result.checks.find(c => c.name === "skill-version-future-skill");
    expect(versionCheck).toBeDefined();
    expect(versionCheck!.ok).toBe(false);
    expect(versionCheck!.detail).toContain("2.0.0");
  });
});
