/**
 * kaizen-setup.ts — Setup operations for the kaizen plugin.
 *
 * Library + CLI. The /kaizen-setup skill calls this via:
 *   npx --prefix $CLAUDE_PLUGIN_ROOT tsx $CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts --step <name> [args]
 *
 * The CLI runs from the HOST PROJECT directory (CWD = host project root).
 * All file operations write to CWD, not to the plugin cache.
 *
 * Plugin mode only — submodule mode has been removed.
 * Hooks, skills, and agents are registered via plugin.json automatically.
 * Setup creates host-project config files:
 *   1. kaizen.config.json — tells kaizen about the host project
 *   2. .claude/kaizen/policies-local.md — host-specific policies
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { parseArgs } from "util";
import { loadAllSkillMetadata, validateSkillDependencies, validateSkillVersions } from "./skill-metadata.js";

// ── Types ──

export interface DetectResult {
  step: "detect";
  status: "ok";
  method: "plugin" | "none";
  root: string;
  needsInstall?: boolean;
}

export interface ConfigInput {
  name: string;
  repo: string;
  description: string;
  kaizenRepo?: string;
  caseCli?: string;
  channel?: string;
}

export interface ConfigResult {
  step: "config";
  status: "ok" | "error";
  path?: string;
  error?: string;
}

export interface ScaffoldResult {
  step: "scaffold";
  status: "ok" | "skipped";
  path: string;
  reason?: string;
}

interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyResult {
  step: "verify";
  status: "ok" | "failed";
  checks: VerifyCheck[];
  passed: number;
  failed: number;
}

// ── Functions ──

export function detectInstall(opts: { cwd: string; env?: Record<string, string | undefined> }): DetectResult {
  const env = opts.env ?? process.env;

  if (env.CLAUDE_PLUGIN_ROOT) {
    const needsInstall = !existsSync(join(env.CLAUDE_PLUGIN_ROOT, "node_modules"));
    return { step: "detect", status: "ok", method: "plugin", root: env.CLAUDE_PLUGIN_ROOT, needsInstall };
  }
  return { step: "detect", status: "ok", method: "none", root: "" };
}

export function generateConfig(input: ConfigInput, cwd: string): ConfigResult {
  if (!input.name || !input.repo || !input.description) {
    return { step: "config", status: "error", error: "missing required fields: name, repo, description" };
  }

  const config: Record<string, unknown> = {
    host: {
      name: input.name,
      repo: input.repo,
      description: input.description,
      ...(input.caseCli ? { caseCli: input.caseCli } : {}),
    },
    kaizen: {
      repo: input.kaizenRepo ?? "Garsson-io/kaizen",
      issueLabel: "kaizen",
    },
    taxonomy: {
      levels: ["level-1", "level-2", "level-3"],
      areas: [],
      areaPrefix: "area/",
      epicPrefix: "epic/",
      horizonPrefix: "horizon/",
    },
    issues: {
      repo: input.repo,
      label: input.repo === (input.kaizenRepo ?? "Garsson-io/kaizen") ? "" : "kaizen",
    },
    notifications: {
      channel: input.channel ?? "none",
    },
  };

  const path = join(cwd, "kaizen.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return { step: "config", status: "ok", path };
}

export function scaffoldPolicies(cwd: string): ScaffoldResult {
  const dir = join(cwd, ".claude", "kaizen");
  const path = join(dir, "policies-local.md");

  if (existsSync(path)) {
    return { step: "scaffold", status: "skipped", path, reason: "already exists" };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `# Host-Specific Kaizen Policies

These policies extend the generic kaizen policies for this project.
Add project-specific enforcement rules here.

<!-- Example:
10. **Never install system packages on the host.** System deps go in Dockerfiles.
11. **All dev work must be in a case with its own worktree.**
-->
`
  );

  // Ensure kaizen session-local directories are gitignored in the host project
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreEntries = [
    ".claude/review-fix/",
    ".claude/audit/",
    ".claude/kaizen/audit/",
    ".claude/worktrees/",
  ];
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const missing = gitignoreEntries.filter(e => !existing.includes(e));
  if (missing.length > 0) {
    const addition = (existing.endsWith("\n") || existing === "" ? "" : "\n")
      + "# kaizen session-local state (not committed)\n"
      + missing.join("\n") + "\n";
    writeFileSync(gitignorePath, existing + addition);
  }

  return { step: "scaffold", status: "ok", path };
}

interface PluginContractCheck {
  hookPaths: VerifyCheck[];
  skillDirs: VerifyCheck[];
  matchers: VerifyCheck[];
}

export function verifyPluginContract(pluginRoot: string): PluginContractCheck {
  const result: PluginContractCheck = { hookPaths: [], skillDirs: [], matchers: [] };
  const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");

  if (!existsSync(pluginJsonPath)) {
    result.hookPaths.push({ name: "plugin-json", ok: false, detail: "plugin.json not found" });
    return result;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
  } catch {
    result.hookPaths.push({ name: "plugin-json", ok: false, detail: "invalid JSON" });
    return result;
  }

  // Validate hook command paths
  const hooks = manifest.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of entries as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>) {
        // Validate matcher regex
        if (entry.matcher) {
          try {
            new RegExp(entry.matcher);
            result.matchers.push({ name: `matcher-${event}`, ok: true, detail: entry.matcher });
          } catch (e) {
            result.matchers.push({ name: `matcher-${event}`, ok: false, detail: `invalid regex: ${entry.matcher} — ${e}` });
          }
        }

        // Validate hook command paths
        if (entry.hooks) {
          for (const hook of entry.hooks) {
            if (!hook.command) continue;
            const resolved = hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
            const hookExists = existsSync(resolved);
            result.hookPaths.push({
              name: `hook-${event}`,
              ok: hookExists,
              detail: hookExists ? resolved : `missing: ${resolved}`,
            });
          }
        }
      }
    }
  }

  // Validate skill directories
  const skillsPath = manifest.skills as string | undefined;
  if (skillsPath) {
    const resolvedSkillsDir = join(pluginRoot, skillsPath);
    if (existsSync(resolvedSkillsDir)) {
      const entries = readdirSync(resolvedSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(resolvedSkillsDir, entry.name, "SKILL.md");
        const hasSkillMd = existsSync(skillMdPath);
        result.skillDirs.push({
          name: `skill-${entry.name}`,
          ok: hasSkillMd,
          detail: hasSkillMd ? undefined : `missing SKILL.md in ${entry.name}`,
        });
      }
    } else {
      result.skillDirs.push({ name: "skills-dir", ok: false, detail: `skills directory not found: ${resolvedSkillsDir}` });
    }
  }

  return result;
}

export function verifySetup(cwd: string, opts?: { pluginRoot?: string }): VerifyResult {
  const checks: VerifyCheck[] = [];

  // Config
  const configPath = join(cwd, "kaizen.config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      checks.push({ name: "config-valid", ok: true });
      for (const field of ["host.name", "host.repo", "kaizen.repo"]) {
        const parts = field.split(".");
        let val: unknown = config;
        for (const p of parts) val = (val as Record<string, unknown>)?.[p];
        checks.push({ name: `config-field-${field}`, ok: !!val, detail: val ? String(val) : "missing" });
      }
    } catch {
      checks.push({ name: "config-valid", ok: false, detail: "invalid JSON" });
    }
  } else {
    checks.push({ name: "config-exists", ok: false, detail: "not found" });
  }

  // Policies
  const policiesPath = join(cwd, ".claude", "kaizen", "policies-local.md");
  checks.push({
    name: "policies-local",
    ok: existsSync(policiesPath),
    detail: existsSync(policiesPath) ? undefined : "not found",
  });

  // CLAUDE.md
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    checks.push({
      name: "claudemd-kaizen",
      ok: content.toLowerCase().includes("kaizen"),
      detail: content.toLowerCase().includes("kaizen") ? undefined : "no kaizen content",
    });
  } else {
    checks.push({ name: "claudemd-exists", ok: false, detail: "not found" });
  }

  // Plugin contract validation
  const pluginRoot = opts?.pluginRoot;
  if (pluginRoot) {
    const contract = verifyPluginContract(pluginRoot);
    checks.push(...contract.hookPaths, ...contract.skillDirs, ...contract.matchers);

    // Skill metadata validation
    const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
    const skillsPath = existsSync(pluginJsonPath)
      ? (JSON.parse(readFileSync(pluginJsonPath, "utf-8")).skills as string | undefined)
      : undefined;

    if (skillsPath) {
      const skillsDir = join(pluginRoot, skillsPath);
      const skills = loadAllSkillMetadata(skillsDir);

      const depIssues = validateSkillDependencies(skills);
      for (const issue of depIssues) {
        checks.push({
          name: `skill-dep-${issue.skill}`,
          ok: false,
          detail: `missing dependency: ${issue.missing_dependency}`,
        });
      }
      if (depIssues.length === 0 && skills.size > 0) {
        checks.push({ name: "skill-dependencies", ok: true });
      }

      let pluginVersion: string | undefined;
      try {
        pluginVersion = JSON.parse(readFileSync(pluginJsonPath, "utf-8")).version as string;
      } catch { /* ignore */ }

      if (pluginVersion) {
        const versionIssues = validateSkillVersions(skills, pluginVersion);
        for (const issue of versionIssues) {
          checks.push({
            name: `skill-version-${issue.skill}`,
            ok: false,
            detail: `requires ${issue.min_version}, plugin is ${issue.current_version}`,
          });
        }
        if (versionIssues.length === 0 && skills.size > 0) {
          checks.push({ name: "skill-versions", ok: true });
        }
      }
    }
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;

  return { step: "verify", status: failed > 0 ? "failed" : "ok", checks, passed, failed };
}

interface ValidateCheck {
  name: string;
  ok: boolean;
  output?: string;
}

interface ValidateResult {
  step: "post-update-validate";
  status: "ok" | "failed";
  checks: ValidateCheck[];
}

/**
 * Run post-update validation: build + quick tests.
 * Used by /kaizen-update to verify an update didn't break anything.
 */
export function postUpdateValidate(pluginRoot: string): ValidateResult {
  const checks: ValidateCheck[] = [];

  // Check 1: npm run build
  try {
    execSync("npm run build", { cwd: pluginRoot, stdio: "pipe", timeout: 60_000 });
    checks.push({ name: "build", ok: true });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const output = (err.stderr?.toString() ?? err.stdout?.toString() ?? "unknown error").slice(0, 500);
    checks.push({ name: "build", ok: false, output });
  }

  // Check 2: npm test (fast subset)
  try {
    execSync("npm test -- --run", { cwd: pluginRoot, stdio: "pipe", timeout: 120_000 });
    checks.push({ name: "test", ok: true });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const output = (err.stderr?.toString() ?? err.stdout?.toString() ?? "unknown error").slice(0, 500);
    checks.push({ name: "test", ok: false, output });
  }

  const failed = checks.some(c => !c.ok);
  return { step: "post-update-validate", status: failed ? "failed" : "ok", checks };
}

// ── CLI ──
// Called by the /kaizen-setup skill:
//   npx --prefix $CLAUDE_PLUGIN_ROOT tsx $CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts --step <name> [args]
// CWD must be the host project root.

if (process.argv[1]?.endsWith("kaizen-setup.ts") || process.argv[1]?.endsWith("kaizen-setup.js")) {
  const { values } = parseArgs({
    options: {
      step: { type: "string" },
      name: { type: "string" },
      repo: { type: "string" },
      description: { type: "string" },
      "kaizen-repo": { type: "string" },
      "case-cli": { type: "string" },
      channel: { type: "string" },
      method: { type: "string" },
      cwd: { type: "string" },
      "plugin-root": { type: "string" },
    },
    strict: false,
  }) as { values: Record<string, string | undefined> };

  const cwd = values.cwd ?? process.cwd();

  switch (values.step) {
    case "detect":
      console.log(JSON.stringify(detectInstall({ cwd })));
      break;

    case "config":
      console.log(JSON.stringify(generateConfig({
        name: values.name ?? "",
        repo: values.repo ?? "",
        description: values.description ?? "",
        kaizenRepo: values["kaizen-repo"],
        caseCli: values["case-cli"],
        channel: values.channel,
      }, cwd)));
      break;

    case "scaffold":
      console.log(JSON.stringify(scaffoldPolicies(cwd)));
      break;

    case "verify": {
      const pluginRoot = values["plugin-root"] ?? process.env.CLAUDE_PLUGIN_ROOT;
      console.log(JSON.stringify(verifySetup(cwd, { pluginRoot })));
      break;
    }

    case "post-update-validate": {
      const validationRoot = values["plugin-root"] ?? process.env.CLAUDE_PLUGIN_ROOT ?? cwd;
      console.log(JSON.stringify(postUpdateValidate(validationRoot)));
      break;
    }

    default:
      console.error(`Unknown step: ${values.step}`);
      console.error("Steps: detect, config, scaffold, verify, post-update-validate");
      process.exit(1);
  }
}
