/**
 * kaizen-setup.ts — Mechanical setup operations for the kaizen plugin.
 *
 * Called by the /kaizen-setup skill:
 *   npx tsx src/kaizen-setup.ts --step <name> [args]
 *
 * Each step emits structured JSON to stdout. Claude reads and acts on it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, readdirSync, unlinkSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { parseArgs } from "util";

// ── Types ──

export interface DetectResult {
  step: "detect";
  status: "ok";
  method: "plugin" | "submodule" | "none";
  root: string;
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

export interface SymlinksResult {
  step: "symlinks";
  status: "ok" | "error";
  created: number;
  errors: string[];
}

export interface MergeHooksResult {
  step: "hooks";
  status: "ok" | "error";
  settingsPath: string;
  hookCount?: number;
  error?: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyResult {
  step: "verify";
  status: "ok" | "failed";
  method: string;
  checks: VerifyCheck[];
  passed: number;
  failed: number;
}

// ── Functions ──

export function detectInstall(opts: { cwd: string; env?: Record<string, string | undefined> }): DetectResult {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd;

  if (env.CLAUDE_PLUGIN_ROOT) {
    return { step: "detect", status: "ok", method: "plugin", root: env.CLAUDE_PLUGIN_ROOT };
  }
  if (existsSync(join(cwd, ".kaizen", ".claude-plugin"))) {
    return { step: "detect", status: "ok", method: "submodule", root: ".kaizen" };
  }
  if (existsSync(join(cwd, ".kaizen", ".claude"))) {
    return { step: "detect", status: "ok", method: "submodule", root: ".kaizen" };
  }
  return { step: "detect", status: "ok", method: "none", root: "" };
}

export function generateConfig(input: ConfigInput, cwd: string): ConfigResult {
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
    notifications: {
      channel: input.channel ?? "none",
    },
  };

  if (!input.name || !input.repo || !input.description) {
    return { step: "config", status: "error", error: "missing required fields: name, repo, description" };
  }

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

  return { step: "scaffold", status: "ok", path };
}

export function setupSymlinks(cwd: string, kaizenRoot: string): SymlinksResult {
  const errors: string[] = [];
  let created = 0;

  const absKaizen = resolve(cwd, kaizenRoot);
  const skillsSource = join(absKaizen, ".claude", "skills");
  const skillsTarget = join(cwd, ".claude", "skills");
  const agentsSource = join(absKaizen, ".claude", "agents");
  const agentsTarget = join(cwd, ".claude", "agents");

  if (!existsSync(skillsSource)) {
    return { step: "symlinks", status: "error", created: 0, errors: [`${skillsSource} not found`] };
  }

  mkdirSync(skillsTarget, { recursive: true });
  mkdirSync(agentsTarget, { recursive: true });

  // Skills
  for (const entry of readdirSync(skillsSource)) {
    if (!entry.startsWith("kaizen-")) continue;
    const target = join(skillsTarget, entry);
    const source = join("..", "..", kaizenRoot, ".claude", "skills", entry);
    try {
      if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
    } catch { /* doesn't exist yet */ }
    try {
      symlinkSync(source, target);
      created++;
    } catch (e) {
      errors.push(`symlink ${entry}: ${(e as Error).message}`);
    }
  }

  // Kaizen docs
  const kaizenDocsTarget = join(cwd, ".claude", "kaizen");
  const kaizenDocsSource = join("..", "..", kaizenRoot, ".claude", "kaizen");
  try {
    if (lstatSync(kaizenDocsTarget).isSymbolicLink()) unlinkSync(kaizenDocsTarget);
  } catch { /* doesn't exist */ }
  try {
    symlinkSync(kaizenDocsSource, kaizenDocsTarget);
    created++;
  } catch (e) {
    errors.push(`symlink kaizen docs: ${(e as Error).message}`);
  }

  // Agents
  if (existsSync(agentsSource)) {
    for (const entry of readdirSync(agentsSource)) {
      if (!entry.endsWith(".md")) continue;
      const target = join(agentsTarget, entry);
      const source = join("..", "..", kaizenRoot, ".claude", "agents", entry);
      try {
        if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
      } catch { /* doesn't exist */ }
      try {
        symlinkSync(source, target);
        created++;
      } catch (e) {
        errors.push(`symlink ${entry}: ${(e as Error).message}`);
      }
    }
  }

  return {
    step: "symlinks",
    status: errors.length > 0 ? "error" : "ok",
    created,
    errors,
  };
}

export function mergeHooks(cwd: string, kaizenRoot: string, settingsPath?: string): MergeHooksResult {
  const resolvedSettings = settingsPath ?? join(cwd, ".claude", "settings.json");
  const fragmentPath = join(resolve(cwd, kaizenRoot), ".claude", "settings-fragment.json");

  if (!existsSync(fragmentPath)) {
    return { step: "hooks", status: "error", settingsPath: resolvedSettings, error: `${fragmentPath} not found` };
  }

  const fragment = JSON.parse(readFileSync(fragmentPath, "utf-8"));
  const fragmentPrefix = fragment._install_prefix ?? ".kaizen/.claude/hooks/";
  const targetPrefix = kaizenRoot === "." ? ".claude/hooks/" : `${kaizenRoot}/.claude/hooks/`;
  const rawHooks = JSON.stringify(fragment.hooks ?? {});
  const rewrittenHooks = rawHooks.split(fragmentPrefix).join(targetPrefix);
  const newHooks = JSON.parse(rewrittenHooks);

  mkdirSync(dirname(resolvedSettings), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(resolvedSettings)) {
    existing = JSON.parse(readFileSync(resolvedSettings, "utf-8"));
  }

  const existingHooks: Record<string, unknown[]> = (existing as { hooks?: Record<string, unknown[]> }).hooks ?? {};

  // Merge each event type, deduplicate by command path
  const merged: Record<string, unknown[]> = { ...existingHooks };
  for (const [event, newEntries] of Object.entries(newHooks) as [string, unknown[]][]) {
    const existingEntries = merged[event] ?? [];
    const combined = [...existingEntries, ...newEntries];

    // Deduplicate: use first hook's command as identity
    const seen = new Set<string>();
    merged[event] = combined.filter((entry: unknown) => {
      const hooks = (entry as { hooks?: { command?: string }[] }).hooks;
      const matcher = (entry as { matcher?: string }).matcher;
      const key = hooks?.[0]?.command ?? matcher ?? JSON.stringify(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const result = { ...existing, hooks: merged };
  writeFileSync(resolvedSettings, JSON.stringify(result, null, 2) + "\n");

  const hookCount = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);
  return { step: "hooks", status: "ok", settingsPath: resolvedSettings, hookCount };
}

export function verifySetup(cwd: string, method: string): VerifyResult {
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
  checks.push({
    name: "policies-local",
    ok: existsSync(join(cwd, ".claude", "kaizen", "policies-local.md")),
    detail: existsSync(join(cwd, ".claude", "kaizen", "policies-local.md")) ? undefined : "not found",
  });

  // CLAUDE.md
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    checks.push({ name: "claudemd-kaizen", ok: content.toLowerCase().includes("kaizen"), detail: content.toLowerCase().includes("kaizen") ? undefined : "no kaizen content" });
  } else {
    checks.push({ name: "claudemd-exists", ok: false, detail: "not found" });
  }

  // Submodule-specific
  if (method === "submodule") {
    const skillLink = join(cwd, ".claude", "skills", "kaizen-reflect");
    try {
      const isLink = lstatSync(skillLink).isSymbolicLink();
      const resolves = existsSync(join(skillLink, "SKILL.md"));
      checks.push({ name: "skill-symlinks", ok: isLink && resolves, detail: !isLink ? "not a symlink" : !resolves ? "broken symlink" : undefined });
    } catch {
      checks.push({ name: "skill-symlinks", ok: false, detail: "not found" });
    }

    const settingsPath = join(cwd, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const hookCount = Object.values(settings.hooks ?? {}).reduce((sum: number, arr: unknown) => sum + (arr as unknown[]).length, 0);
        checks.push({ name: "hooks-registered", ok: hookCount > 0, detail: `${hookCount} hook entries` });
      } catch {
        checks.push({ name: "hooks-registered", ok: false, detail: "invalid settings.json" });
      }
    } else {
      checks.push({ name: "hooks-registered", ok: false, detail: "settings.json not found" });
    }
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;

  return { step: "verify", status: failed > 0 ? "failed" : "ok", method, checks, passed, failed };
}

// ── CLI ──

if (process.argv[1]?.endsWith("kaizen-setup.ts") || process.argv[1]?.endsWith("kaizen-setup.js")) {
  const { values } = parseArgs({
    options: {
      step: { type: "string" },
      // config args
      name: { type: "string" },
      repo: { type: "string" },
      description: { type: "string" },
      "kaizen-repo": { type: "string" },
      "case-cli": { type: "string" },
      channel: { type: "string" },
      // common
      "kaizen-root": { type: "string" },
      method: { type: "string" },
      cwd: { type: "string" },
    },
    strict: false,
  }) as { values: Record<string, string | undefined> };

  const cwd = values.cwd ?? process.cwd();

  switch (values.step) {
    case "detect":
      console.log(JSON.stringify(detectInstall({ cwd })));
      break;

    case "config":
      console.log(
        JSON.stringify(
          generateConfig(
            {
              name: values.name ?? "",
              repo: values.repo ?? "",
              description: values.description ?? "",
              kaizenRepo: values["kaizen-repo"],
              caseCli: values["case-cli"],
              channel: values.channel,
            },
            cwd
          )
        )
      );
      break;

    case "scaffold":
      console.log(JSON.stringify(scaffoldPolicies(cwd)));
      break;

    case "symlinks":
      console.log(JSON.stringify(setupSymlinks(cwd, values["kaizen-root"] ?? ".kaizen")));
      break;

    case "hooks":
      console.log(JSON.stringify(mergeHooks(cwd, values["kaizen-root"] ?? ".kaizen")));
      break;

    case "verify":
      console.log(JSON.stringify(verifySetup(cwd, values.method ?? "plugin")));
      break;

    default:
      console.error(`Unknown step: ${values.step}`);
      console.error("Usage: npx tsx src/kaizen-setup.ts --step <detect|config|scaffold|symlinks|hooks|verify> [args]");
      process.exit(1);
  }
}
