import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import {
  detectInstall,
  generateConfig,
  scaffoldPolicies,
  verifySetup,
  verifyPluginContract,
  postUpdateValidate,
  enablePlugin,
  checkPreconditions,
  injectInstructions,
} from "./kaizen-setup.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kaizen-setup-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("setup JSON file parsing", () => {
  it("delegates runtime JSON object file reads and writes to the shared file helper", () => {
    const source = readFileSync(new URL("./kaizen-setup.ts", import.meta.url), "utf-8");

    expect(source).toContain("readJsonObjectFile");
    expect(source).toContain("writeJsonObjectFile");
    expect(source).not.toContain("JSON.parse(readFileSync");
    expect(source).not.toContain("function readJsonObjectFile");
    expect(source).not.toContain("parseJsonObject(readFileSync");
    expect(source).not.toContain("JSON.stringify(config, null, 2)");
    expect(source).not.toContain("JSON.stringify(data, null, 2)");
  });
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
    expect(readFileSync(join(tempDir, "kaizen.config.json"), "utf-8")).toMatch(/\n$/);
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
    expect(existsSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"))).toBe(true);
  });

  it("adds every kaizen session-local directory to .gitignore, including telemetry", () => {
    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("ok");

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/review-fix/");
    expect(gitignore).toContain(".claude/audit/");
    expect(gitignore).toContain(".agents/kaizen/local/audit/");
    expect(gitignore).toContain(".claude/worktrees/");
    expect(gitignore).toContain("data/telemetry/");
  });

  it("skips if already exists", () => {
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "existing content");

    const result = scaffoldPolicies(tempDir);
    expect(result.status).toBe("skipped");

    const content = readFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "utf-8");
    expect(content).toBe("existing content");
  });
});

describe("checkPreconditions (#1085 — project-scope install can be silently hidden)", () => {
  it("returns ok when no .gitignore exists", () => {
    expect(checkPreconditions(tempDir)).toEqual({ step: "precondition", status: "ok", warnings: [] });
  });

  it("warns when .gitignore broadly ignores .claude/", () => {
    writeFileSync(join(tempDir, ".gitignore"), ".claude/\n");
    const result = checkPreconditions(tempDir);
    expect(result.status).toBe("warn");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(".claude/settings.json");
    expect(result.warnings[0]).toContain(".claude/review-fix/");
  });

  it("warns for leading-slash and no-slash variants", () => {
    writeFileSync(join(tempDir, ".gitignore"), "/.claude\n");
    expect(checkPreconditions(tempDir).status).toBe("warn");
  });

  it("does not warn for narrow session-local ignores", () => {
    writeFileSync(
      join(tempDir, ".gitignore"),
      ".claude/review-fix/\n.claude/audit/\n.claude/worktrees/\n.claude/settings.local.json\n",
    );
    expect(checkPreconditions(tempDir).status).toBe("ok");
  });
});

describe("injectInstructions (#1085 — no manual {{KAIZEN_ROOT}} substitution)", () => {
  function makePluginRoot(fragment: string): string {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".agents", "kaizen"), { recursive: true });
    writeFileSync(join(pluginRoot, ".agents", "kaizen", "instructions-fragment.md"), fragment);
    return pluginRoot;
  }

  it("creates CLAUDE.md from the fragment and replaces the root placeholder", () => {
    const pluginRoot = makePluginRoot("Kaizen root: {{KAIZEN_ROOT}}\n");
    const result = injectInstructions({ cwd: tempDir, pluginRoot });
    expect(result).toMatchObject({ step: "inject-instructions", status: "ok", path: join(tempDir, "CLAUDE.md") });

    const content = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain(`Kaizen root: ${pluginRoot}`);
    expect(content).not.toContain("{{KAIZEN_ROOT}}");
  });

  it("appends idempotently with a blank-line separator", () => {
    const pluginRoot = makePluginRoot("<!-- BEGIN KAIZEN PLUGIN -->\n## Kaizen\n<!-- END KAIZEN PLUGIN -->\n");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Existing");

    const first = injectInstructions({ cwd: tempDir, pluginRoot });
    const afterFirst = readFileSync(first.path!, "utf-8");
    const second = injectInstructions({ cwd: tempDir, pluginRoot });

    expect(afterFirst).toBe("# Existing\n\n<!-- BEGIN KAIZEN PLUGIN -->\n## Kaizen\n<!-- END KAIZEN PLUGIN -->\n");
    expect(second.status).toBe("skipped");
    expect(readFileSync(second.path!, "utf-8")).toBe(afterFirst);
  });

  it("falls back to AGENTS.md when CLAUDE.md is absent", () => {
    const pluginRoot = makePluginRoot("## Kaizen\n");
    writeFileSync(join(tempDir, "AGENTS.md"), "# Agents\n");
    const result = injectInstructions({ cwd: tempDir, pluginRoot });
    expect(result.path).toBe(join(tempDir, "AGENTS.md"));
    expect(readFileSync(join(tempDir, "AGENTS.md"), "utf-8")).toContain("## Kaizen");
  });

  it("honors an explicit target", () => {
    const pluginRoot = makePluginRoot("## Kaizen\n");
    const target = join(tempDir, "CUSTOM.md");
    const result = injectInstructions({ cwd: tempDir, pluginRoot, target });
    expect(result.path).toBe(target);
    expect(readFileSync(target, "utf-8")).toContain("## Kaizen");
  });

  it("CLI smoke exposes precondition and inject-instructions as JSON steps", () => {
    const pluginRoot = makePluginRoot("<!-- BEGIN KAIZEN PLUGIN -->\nKaizen {{KAIZEN_ROOT}}\n<!-- END KAIZEN PLUGIN -->\n");
    writeFileSync(join(tempDir, ".gitignore"), ".claude/\n");
    const setupScript = fileURLToPath(new URL("./kaizen-setup.ts", import.meta.url));

    const precondition = JSON.parse(execFileSync(
      "npx",
      ["tsx", setupScript, "--step", "precondition", "--cwd", tempDir],
      { encoding: "utf-8" },
    ));
    expect(precondition).toMatchObject({ step: "precondition", status: "warn" });

    const injected = JSON.parse(execFileSync(
      "npx",
      ["tsx", setupScript, "--step", "inject-instructions", "--cwd", tempDir, "--plugin-root", pluginRoot],
      { encoding: "utf-8" },
    ));
    expect(injected).toMatchObject({ step: "inject-instructions", status: "ok" });
    const content = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain(pluginRoot);
    expect(content).not.toContain("{{KAIZEN_ROOT}}");
  });
});

describe("setup docs contracts (#1085/#1080)", () => {
  it("README recommends project-scoped install for team enforcement", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    expect(readme).toContain("/plugin marketplace add Garsson-io/kaizen --scope project");
    expect(readme).toContain("/plugin install kaizen@kaizen --scope project");
    expect(readme).toContain("Use the default user scope only");
  });

  it("setup skill uses mechanistic precondition and injection steps", () => {
    const skill = readFileSync(new URL("../.agents/skills/kaizen-setup/SKILL.md", import.meta.url), "utf-8");
    expect(skill).toContain("--step precondition");
    expect(skill).toContain("--step inject-instructions");
    expect(skill).not.toContain("If `CLAUDE_PLUGIN_ROOT` is empty, the plugin isn't installed");
  });

  it("instruction fragment has no raw root placeholder", () => {
    const fragment = readFileSync(new URL("../.agents/kaizen/instructions-fragment.md", import.meta.url), "utf-8");
    expect(fragment).not.toContain("{{KAIZEN_ROOT}}");
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
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
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
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    expect(result.status).toBe("ok");
    expect(result.checks.some(c => c.name.startsWith("hook-"))).toBe(true);
    expect(result.checks.some(c => c.name.startsWith("skill-"))).toBe(true);
    expect(result.checks.some(c => c.name.startsWith("matcher-"))).toBe(true);
  });

  it("reports invalid plugin.json during setup verification without reparsing it", () => {
    const pluginRoot = join(tempDir, "plugin");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "not json");
    writeFileSync(join(tempDir, "kaizen.config.json"), JSON.stringify({ host: { name: "p", repo: "o/r" }, kaizen: { repo: "g/k" } }));
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    const pluginJsonCheck = result.checks.find(c => c.name === "plugin-json");
    expect(result.status).toBe("failed");
    expect(pluginJsonCheck).toMatchObject({ ok: false, detail: "invalid JSON" });
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
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
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
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
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
    mkdirSync(join(tempDir, ".agents", "kaizen", "local"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"), "# Policies");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# kaizen");

    const result = verifySetup(tempDir, { pluginRoot });
    const versionCheck = result.checks.find(c => c.name === "skill-version-future-skill");
    expect(versionCheck).toBeDefined();
    expect(versionCheck!.ok).toBe(false);
    expect(versionCheck!.detail).toContain("2.0.0");
  });
});

describe("enablePlugin (#1063 — --step enable)", () => {
  it("creates .claude/settings.json with enabledPlugins when missing", () => {
    const r = enablePlugin(tempDir);
    expect(r).toEqual({ step: "enable", status: "ok", path: join(tempDir, ".claude/settings.json"), changed: true });
    const parsed = JSON.parse(readFileSync(r.path!, "utf-8"));
    expect(parsed.enabledPlugins["kaizen@kaizen"]).toBe(true);
    expect(readFileSync(r.path!, "utf-8")).toMatch(/\n$/);
  });

  it("adds enabledPlugins to an existing settings.json without clobbering other keys", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tempDir, ".claude/settings.json"),
      JSON.stringify({ env: { FOO: "bar" }, permissions: { allow: ["Bash(git status)"] } }),
    );
    const r = enablePlugin(tempDir);
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(r.path!, "utf-8"));
    expect(parsed.env).toEqual({ FOO: "bar" });
    expect(parsed.permissions.allow).toEqual(["Bash(git status)"]);
    expect(parsed.enabledPlugins["kaizen@kaizen"]).toBe(true);
  });

  it("is idempotent — second call returns changed:false", () => {
    enablePlugin(tempDir);
    const r = enablePlugin(tempDir);
    expect(r.changed).toBe(false);
    expect(r.status).toBe("ok");
  });

  it("preserves other enabledPlugins entries", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tempDir, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "other@x": true } }),
    );
    enablePlugin(tempDir);
    const parsed = JSON.parse(readFileSync(join(tempDir, ".claude/settings.json"), "utf-8"));
    expect(parsed.enabledPlugins).toEqual({ "other@x": true, "kaizen@kaizen": true });
  });

  it("accepts a custom plugin name", () => {
    const r = enablePlugin(tempDir, "my-plugin@foo");
    const parsed = JSON.parse(readFileSync(r.path!, "utf-8"));
    expect(parsed.enabledPlugins["my-plugin@foo"]).toBe(true);
  });

  it("returns error on malformed settings.json instead of overwriting", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(join(tempDir, ".claude/settings.json"), "{{{ not json");
    const r = enablePlugin(tempDir);
    expect(r.status).toBe("error");
    expect(r.error).toContain("parse error");
  });
});
