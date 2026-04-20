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
  enablePlugin,
  checkPreconditions,
  injectClaudeMd,
  registerCeremony,
  storeCeremonyPlan,
  renderCeremonyIssueBody,
  renderCeremonyPlan,
  type ExecFileSyncLike,
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

  it("returns none when CLAUDE_PLUGIN_ROOT is not set AND `claude` CLI is absent", () => {
    // The `claude plugin list --json` fallback (#1085) invokes the
    // `claude` CLI. In the unit test we pass env: {} which doesn't
    // include a PATH capable of finding `claude`; the fallback's
    // try/catch swallows the error and returns `method: "none"`.
    const result = detectInstall({ cwd: tempDir, env: { PATH: "" } });
    expect(result).toEqual({ step: "detect", status: "ok", method: "none", root: "" });
  });
});

describe("checkPreconditions (#1085 item 2 — gitignored .claude/ silently defeats project-scope)", () => {
  it("returns ok when no .gitignore exists", () => {
    const result = checkPreconditions(tempDir);
    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  it("returns ok when .gitignore narrowly ignores session-local paths only", () => {
    writeFileSync(
      join(tempDir, ".gitignore"),
      ".claude/review-fix/\n.claude/audit/\n.claude/worktrees/\n.claude/settings.local.json\n",
    );
    const result = checkPreconditions(tempDir);
    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  it("warns when .gitignore broadly ignores `.claude/`", () => {
    writeFileSync(join(tempDir, ".gitignore"), ".claude/\n");
    const result = checkPreconditions(tempDir);
    expect(result.status).toBe("warn");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(".claude/settings.json");
    expect(result.warnings[0]).toContain("Replace `.claude/`");
  });

  it("warns for `.claude` without trailing slash", () => {
    writeFileSync(join(tempDir, ".gitignore"), ".claude\n");
    expect(checkPreconditions(tempDir).status).toBe("warn");
  });

  it("warns for leading-slash variant `/.claude/`", () => {
    writeFileSync(join(tempDir, ".gitignore"), "/.claude/\n");
    expect(checkPreconditions(tempDir).status).toBe("warn");
  });

  it("ignores commented lines", () => {
    writeFileSync(join(tempDir, ".gitignore"), "# .claude/\n");
    expect(checkPreconditions(tempDir).status).toBe("ok");
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
    expect(existsSync(join(tempDir, ".agents", "kaizen", "local", "policies-local.md"))).toBe(true);
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

describe("injectClaudeMd (#1081 Step 6 — mechanistic fragment append)", () => {
  const fragmentBody = "<!-- BEGIN KAIZEN PLUGIN -->\nkaizen section body\n<!-- END KAIZEN PLUGIN -->\n";
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = join(tempDir, "plugin-root");
    mkdirSync(join(pluginRoot, ".agents/kaizen"), { recursive: true });
    writeFileSync(join(pluginRoot, ".agents/kaizen/instructions-fragment.md"), fragmentBody);
  });

  it("creates CLAUDE.md and appends fragment when neither CLAUDE.md nor AGENTS.md exists", () => {
    const result = injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(result.status).toBe("ok");
    expect(result.path).toBe(join(tempDir, "CLAUDE.md"));
    expect(readFileSync(result.path!, "utf-8")).toBe(fragmentBody);
  });

  it("appends to existing CLAUDE.md with a \\n\\n separator when file lacks a trailing newline", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Existing");
    injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(readFileSync(join(tempDir, "CLAUDE.md"), "utf-8")).toBe("# Existing\n\n" + fragmentBody);
  });

  it("appends with an added \\n when file ends in exactly one \\n (→ \\n\\n gap before fragment)", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Existing\n");
    injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(readFileSync(join(tempDir, "CLAUDE.md"), "utf-8")).toBe("# Existing\n\n" + fragmentBody);
  });

  it("appends with no separator when file ends in \\n\\n", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Existing\n\n");
    injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(readFileSync(join(tempDir, "CLAUDE.md"), "utf-8")).toBe("# Existing\n\n" + fragmentBody);
  });

  it("is idempotent — second call returns status:skipped and does not duplicate the fragment", () => {
    injectClaudeMd({ cwd: tempDir, pluginRoot });
    const afterFirst = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    const result = injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("already present");
    expect(readFileSync(join(tempDir, "CLAUDE.md"), "utf-8")).toBe(afterFirst);
  });

  it("prefers CLAUDE.md over AGENTS.md when both exist", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# C\n");
    writeFileSync(join(tempDir, "AGENTS.md"), "# A\n");
    const result = injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(result.path).toBe(join(tempDir, "CLAUDE.md"));
    expect(readFileSync(join(tempDir, "AGENTS.md"), "utf-8")).toBe("# A\n");
  });

  it("falls back to AGENTS.md when CLAUDE.md is absent but AGENTS.md exists", () => {
    writeFileSync(join(tempDir, "AGENTS.md"), "# A\n");
    const result = injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(result.path).toBe(join(tempDir, "AGENTS.md"));
    expect(readFileSync(join(tempDir, "AGENTS.md"), "utf-8")).toBe("# A\n\n" + fragmentBody);
  });

  it("honors an explicit target override", () => {
    const custom = join(tempDir, "MY-AGENTS.md");
    writeFileSync(custom, "x\n");
    injectClaudeMd({ cwd: tempDir, pluginRoot, target: custom });
    expect(readFileSync(custom, "utf-8")).toBe("x\n\n" + fragmentBody);
  });

  it("returns status:error when the fragment file is missing", () => {
    rmSync(join(pluginRoot, ".agents/kaizen/instructions-fragment.md"));
    const result = injectClaudeMd({ cwd: tempDir, pluginRoot });
    expect(result.status).toBe("error");
    expect(result.error).toContain("fragment not found");
  });
});

describe("renderCeremonyIssueBody / renderCeremonyPlan — pure renderers", () => {
  it("issue body interpolates hostName into the Problem section", () => {
    const body = renderCeremonyIssueBody({ hostRepo: "org/app", hostName: "app" });
    expect(body).toContain("**app** repo needs kaizen's enforcement hooks");
    expect(body).toContain("Host: `org/app`");
    expect(body).toContain("`--scope project`");
  });

  it("issue body includes the verify-gate acceptance criterion", () => {
    const body = renderCeremonyIssueBody({ hostRepo: "o/r", hostName: "r" });
    expect(body).toMatch(/npx kaizen-setup --step verify/);
  });

  it("plan includes the four on-disk artifact DONE-WHEN items", () => {
    const plan = renderCeremonyPlan({ hostRepo: "org/app", hostName: "app" });
    expect(plan).toContain("kaizen.config.json");
    expect(plan).toContain("policies-local.md");
    expect(plan).toContain("CLAUDE.md");
    expect(plan).toContain(".gitignore");
    expect(plan).toContain("pre-push");
  });

  it("plan declares ceremony path, not direct implementation", () => {
    const plan = renderCeremonyPlan({ hostRepo: "o/r", hostName: "r" });
    expect(plan).toContain("ceremony");
    expect(plan).toContain("#1085");
  });
});

describe("registerCeremony (#1085 — tracking-issue gateway)", () => {
  function makeExec(
    calls: Array<{ file: string; args: string[]; input?: string }>,
    responses: string[],
  ): ExecFileSyncLike {
    return (file, args, opts) => {
      calls.push({ file, args, input: opts.input });
      if (responses.length === 0) throw new Error("no more responses queued");
      return responses.shift()!;
    };
  }

  it("returns skipped with the existing issue when search finds the same title", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const existingUrl = "https://github.com/org/app/issues/42";
    const exec = makeExec(calls, [
      JSON.stringify([
        { number: 42, title: "chore(kaizen): configure kaizen plugin for app", url: existingUrl },
      ]),
    ]);

    const result = registerCeremony({ cwd: tempDir, hostRepo: "org/app", hostName: "app", exec });

    expect(result.status).toBe("skipped");
    expect(result.issueNumber).toBe(42);
    expect(result.issueUrl).toBe(existingUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("gh");
    // Arg array form — hostRepo and search are separate argv entries, not shell-interpolated.
    expect(calls[0].args).toEqual([
      "issue", "list",
      "--repo", "org/app",
      "--state", "open",
      "--search", "chore(kaizen): configure kaizen plugin",
      "--json", "number,title,url",
      "--limit", "5",
    ]);
  });

  it("creates a new issue when search returns no matches and pluginRoot is empty (no plan stored)", () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const newUrl = "https://github.com/org/app/issues/101";
    const exec = makeExec(calls, [
      "[]",           // gh issue list — empty
      newUrl + "\n",  // gh issue create — url on its own line
    ]);

    const result = registerCeremony({
      cwd: tempDir, hostRepo: "org/app", hostName: "app", exec,
      // pluginRoot omitted and CLAUDE_PLUGIN_ROOT unset → storeCeremonyPlan is a no-op
    });

    expect(result.status).toBe("ok");
    expect(result.issueNumber).toBe(101);
    expect(result.issueUrl).toBe(newUrl);
    expect(result.planUrl).toBeUndefined();
    expect(result.reason).toMatch(/plan attachment failed/);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([
      "issue", "create",
      "--repo", "org/app",
      "--title", "chore(kaizen): configure kaizen plugin for app",
      "--body-file", "-",
    ]);
    // Issue body piped via stdin, not embedded in argv.
    expect(calls[1].input).toContain("**app** repo needs kaizen's enforcement hooks");
  });

  it("returns error when gh issue list throws (gh not authed / not installed)", () => {
    const exec: ExecFileSyncLike = () => { throw new Error("gh: command not found"); };
    const result = registerCeremony({ cwd: tempDir, hostRepo: "o/r", hostName: "r", exec });
    expect(result.status).toBe("error");
    expect(result.error).toContain("gh issue list failed");
    expect(result.error).toContain("gh: command not found");
  });

  it("returns error when gh issue create throws", () => {
    const exec = makeExec([], ["[]"]);
    const throwingExec: ExecFileSyncLike = (file, args, opts) => {
      if (args[1] === "create") throw new Error("boom");
      return exec(file, args, opts);
    };
    const result = registerCeremony({ cwd: tempDir, hostRepo: "o/r", hostName: "r", exec: throwingExec });
    expect(result.status).toBe("error");
    expect(result.error).toContain("gh issue create failed");
  });

  it("returns error when the issue URL doesn't parse to a number", () => {
    const exec = makeExec([], [
      "[]",
      "https://github.com/org/app/pull/without-number\n",
    ]);
    const result = registerCeremony({ cwd: tempDir, hostRepo: "o/r", hostName: "r", exec });
    expect(result.status).toBe("error");
    expect(result.error).toContain("could not parse issue number");
  });
});

describe("storeCeremonyPlan — subprocess arg shape + URL extraction", () => {
  it("returns empty string when pluginRoot is empty and CLAUDE_PLUGIN_ROOT is unset", () => {
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const exec: ExecFileSyncLike = () => { throw new Error("must not be called"); };
      const url = storeCeremonyPlan({ cwd: tempDir, hostRepo: "o/r", issueNumber: 1, hostName: "r", exec });
      expect(url).toBe("");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it("passes an arg array (no shell) and extracts the stored plan URL", () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const stdoutUrl = "https://github.com/org/app/issues/101#issuecomment-999\n";
    const exec: ExecFileSyncLike = (file, args, opts) => {
      calls.push({ file, args, input: opts.input });
      return "Plan stored: " + stdoutUrl;
    };

    const url = storeCeremonyPlan({
      cwd: tempDir, hostRepo: "org/app", issueNumber: 101, hostName: "app",
      pluginRoot: "/fake/plugin/root", exec,
    });

    expect(url).toBe(stdoutUrl.trim());
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("npx");
    expect(calls[0].args[0]).toBe("--prefix");
    expect(calls[0].args[1]).toBe("/fake/plugin/root");
    expect(calls[0].args).toContain("store-plan");
    expect(calls[0].args).toContain("--issue");
    expect(calls[0].args).toContain("101");
    expect(calls[0].args).toContain("--repo");
    expect(calls[0].args).toContain("org/app");
    expect(calls[0].args).toContain("--stdin");
    expect(calls[0].input).toContain("Plan — configure kaizen plugin for app");
  });

  it("returns empty string when the subprocess output has no URL", () => {
    const exec: ExecFileSyncLike = () => "unexpected output with no link\n";
    const url = storeCeremonyPlan({
      cwd: tempDir, hostRepo: "o/r", issueNumber: 1, hostName: "r", pluginRoot: "/p", exec,
    });
    expect(url).toBe("");
  });

  it("swallows subprocess errors and returns empty string (best-effort)", () => {
    const exec: ExecFileSyncLike = () => { throw new Error("network"); };
    const url = storeCeremonyPlan({
      cwd: tempDir, hostRepo: "o/r", issueNumber: 1, hostName: "r", pluginRoot: "/p", exec,
    });
    expect(url).toBe("");
  });
});

describe("enablePlugin (#1063 — --step enable)", () => {
  it("creates .claude/settings.json with enabledPlugins when missing", () => {
    const r = enablePlugin(tempDir);
    expect(r).toEqual({ step: "enable", status: "ok", path: join(tempDir, ".claude/settings.json"), changed: true });
    const parsed = JSON.parse(readFileSync(r.path!, "utf-8"));
    expect(parsed.enabledPlugins["kaizen@kaizen"]).toBe(true);
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
