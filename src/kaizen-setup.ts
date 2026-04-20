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
 *   2. .agents/kaizen/local/policies-local.md — host-specific policies
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { join } from "path";
import { parseArgs } from "util";
import { loadAllSkillMetadata, validateSkillDependencies, validateSkillVersions } from "./skill-metadata.js";
import { installGitHooks, type InstallResult } from "./setup-git-hooks.js";

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

export interface EnableResult {
  step: "enable";
  status: "ok" | "error";
  path?: string;
  /** True if we wrote the entry; false if it was already present. */
  changed?: boolean;
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

  // Fallback (#1085): `CLAUDE_PLUGIN_ROOT` is only set when Claude Code
  // invokes hooks; it is NOT set in ad-hoc Bash calls an agent makes
  // while running a skill. That produced a false-negative "plugin not
  // installed" for every agent-driven install. Resolve via the
  // `claude` CLI, which is a stable public surface and reports the
  // plugin cache path alongside enablement state.
  const cliRoot = detectViaClaudeCli();
  if (cliRoot) {
    const needsInstall = !existsSync(join(cliRoot, "node_modules"));
    return { step: "detect", status: "ok", method: "plugin", root: cliRoot, needsInstall };
  }

  return { step: "detect", status: "ok", method: "none", root: "" };
}

/**
 * Resolve kaizen's plugin cache path via `claude plugin list --json`.
 * Returns the empty string if:
 *   - the `claude` CLI is absent,
 *   - the CLI does not support `--json` (older gh-style; we swallow
 *     and return "" so the caller falls through to `method: "none"`),
 *   - no plugin matching `kaizen@kaizen` is reported.
 *
 * Used as the Step-0 fallback when `CLAUDE_PLUGIN_ROOT` is unset.
 */
function detectViaClaudeCli(): string {
  try {
    const stdout = execSync("claude plugin list --json", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    const parsed = JSON.parse(stdout.trim());
    const list = Array.isArray(parsed) ? parsed : (parsed?.plugins ?? []);
    for (const entry of list) {
      // Schema (claude 2.90.0): {id: "kaizen@kaizen", installPath: "...", ...}
      // Be permissive — accept `name`/`plugin`/`id` and `installPath`/`path`/
      // `root`/`cachePath` since the CLI's JSON shape is not a frozen contract.
      const name = entry?.id ?? entry?.name ?? entry?.plugin ?? "";
      if (name === "kaizen@kaizen" || name === "kaizen") {
        const p = entry?.installPath ?? entry?.path ?? entry?.root ?? entry?.cachePath ?? "";
        if (p && typeof p === "string") return p;
      }
    }
  } catch {
    /* no-op — caller returns method: "none" */
  }
  return "";
}

export interface PreconditionResult {
  step: "precondition";
  status: "ok" | "warn";
  warnings: string[];
}

/**
 * Step 0.5 — check preconditions that commonly produce silent failures.
 *
 * Today this catches one thing (#1085 item 2): the host repo has
 * `.claude/` in `.gitignore`, which silently defeats project-scope
 * plugin install. `enabledPlugins["kaizen@kaizen"]` writes to
 * `.claude/settings.json` and nothing propagates to collaborators.
 * Scaffolding kaizen-session-local dirs is fine and expected, but
 * gitignoring the whole `.claude/` directory hides the team-shared
 * settings too.
 *
 * Advisory only — returns warnings for the skill to display, never
 * blocks. Idempotent.
 */
export function checkPreconditions(cwd: string): PreconditionResult {
  const warnings: string[] = [];
  const gitignorePath = join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const body = readFileSync(gitignorePath, "utf-8");
    const lines = body.split(/\r?\n/);
    const broadIgnore = lines.some((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return false;
      // Matches `.claude/`, `.claude`, `/.claude/`, `/.claude` (without
      // a trailing more-specific path segment). Does NOT flag
      // `.claude/review-fix/`, `.claude/audit/`, `.claude/worktrees/`,
      // etc — those are intentionally session-local.
      return /^\/?\.claude\/?$/.test(line);
    });
    if (broadIgnore) {
      warnings.push(
        ".claude/ is gitignored in this host repo. Project-scope plugin " +
          "install writes enabledPlugins to .claude/settings.json, but with " +
          "the whole directory gitignored, nothing propagates to collaborators. " +
          "Replace `.claude/` with the narrower session-local entries: " +
          ".claude/review-fix/, .claude/audit/, .claude/worktrees/, .claude/settings.local.json.",
      );
    }
  }
  return {
    step: "precondition",
    status: warnings.length > 0 ? "warn" : "ok",
    warnings,
  };
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

/**
 * Activate the kaizen plugin for this project by setting
 * `enabledPlugins["kaizen@kaizen"] = true` in the project's
 * `.claude/settings.json`. Idempotent. Preserves all other keys.
 *
 * This is the ONE step that actually turns hooks on (#1063). Without
 * it, `/plugin install` only downloads the plugin — it stays dormant
 * until the host project activates it. Previously this was documented
 * prose in SKILL.md; now it's mechanical, so a missed manual edit
 * doesn't produce a silently-broken install.
 */
export function enablePlugin(cwd: string, pluginName = "kaizen@kaizen"): EnableResult {
  const dir = join(cwd, ".claude");
  const path = join(dir, "settings.json");

  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf-8"));
      if (!data || typeof data !== "object") data = {};
    } catch (e) {
      return { step: "enable", status: "error", path, error: `settings.json parse error: ${String(e)}` };
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  const enabled = (data.enabledPlugins ?? {}) as Record<string, unknown>;
  if (enabled[pluginName] === true) {
    return { step: "enable", status: "ok", path, changed: false };
  }
  enabled[pluginName] = true;
  data.enabledPlugins = enabled;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return { step: "enable", status: "ok", path, changed: true };
}

export function scaffoldPolicies(cwd: string): ScaffoldResult {
  const dir = join(cwd, ".agents", "kaizen", "local");
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
    ".agents/kaizen/local/audit/",
    ".claude/worktrees/",
    "data/telemetry/",
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

export interface ClaudeMdInjectResult {
  step: "claude-md-inject";
  status: "ok" | "skipped" | "error";
  path?: string;
  reason?: string;
  error?: string;
}

/**
 * Step 6 of `/kaizen-setup` — append the kaizen fragment to the host's
 * agent-instructions file.
 *
 * Mechanistic so agents in headless mode cannot skip it by misreading
 * prose-style directions (#1081 regression in phase-2 of the live E2E:
 * agent completed config + scaffold steps but never reached Step 6
 * because it was documented as "read and append" rather than a CLI
 * call).
 *
 * Target file resolution, in order:
 *   1. `$opts.target` if provided
 *   2. `CLAUDE.md` if present (common default)
 *   3. `AGENTS.md` if present (alt convention)
 *   4. Create `CLAUDE.md`
 *
 * Idempotent: if the target already contains `<!-- BEGIN KAIZEN PLUGIN`
 * we skip. The fragment uses stable markers on either end so re-runs
 * are safe.
 */
export function injectClaudeMd(opts: {
  cwd: string;
  pluginRoot: string;
  target?: string;
}): ClaudeMdInjectResult {
  const fragmentPath = join(opts.pluginRoot, ".agents/kaizen/instructions-fragment.md");
  if (!existsSync(fragmentPath)) {
    return {
      step: "claude-md-inject",
      status: "error",
      error: `fragment not found: ${fragmentPath}`,
    };
  }

  let target = opts.target;
  if (!target) {
    const claudeMd = join(opts.cwd, "CLAUDE.md");
    const agentsMd = join(opts.cwd, "AGENTS.md");
    if (existsSync(claudeMd)) target = claudeMd;
    else if (existsSync(agentsMd)) target = agentsMd;
    else target = claudeMd; // create CLAUDE.md by default
  }

  // Read-then-write without a prior existsSync probe: CodeQL's
  // js/file-system-race flags a stat-then-op pattern, so we let the
  // read itself discover ENOENT in a single syscall.
  let existing = "";
  try {
    existing = readFileSync(target, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing.includes("<!-- BEGIN KAIZEN PLUGIN")) {
    return {
      step: "claude-md-inject",
      status: "skipped",
      path: target,
      reason: "kaizen section already present",
    };
  }

  const fragment = readFileSync(fragmentPath, "utf-8");
  const separator = existing === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(target, existing + separator + fragment);

  return { step: "claude-md-inject", status: "ok", path: target };
}

export interface CeremonyResult {
  step: "ceremony";
  status: "ok" | "skipped" | "error";
  /** Existing issue found by search (idempotent) or newly created. */
  issueNumber?: number;
  issueUrl?: string;
  /** URL of the stored plan attachment comment. */
  planUrl?: string;
  reason?: string;
  error?: string;
}

/**
 * Step 7 of `/kaizen-setup` — file the tracking issue that the setup
 * PR will close.
 *
 * Rationale (#1085 items 5, 8): kaizen is a big change. Adopting it
 * deserves an issue, a plan, and a PR — and the setup skill should
 * lead the admin through that ceremony rather than hand them a
 * configured repo that's immediately about to be blocked by kaizen's
 * own enforcement hooks (plan-stored on `gh pr create`, worktree
 * writes, etc.).
 *
 * Behavior: idempotent. Searches for an existing "configure kaizen
 * plugin" issue first; creates one only if none is found. Stores a
 * templated plan as a marker attachment on the issue so
 * `enforce-plan-stored` passes when the PR is opened.
 *
 * Best-effort — if `gh` is not authenticated or the user lacks
 * issue-creation permission, returns status=`error` without
 * aborting the overall install. The admin is then told to file the
 * issue manually (SKILL.md step 8).
 */
export function registerCeremony(opts: {
  cwd: string;
  hostRepo: string;
  hostName: string;
  pluginRoot?: string;
}): CeremonyResult {
  const { cwd, hostRepo, hostName } = opts;
  const title = `chore(kaizen): configure kaizen plugin for ${hostName}`;

  // Idempotency check: look for an existing open issue with the same
  // title or a clear kaizen-setup marker. We only search open issues;
  // if the admin closed a prior one and is re-running, we'll create a
  // fresh one (they probably want a fresh PR too).
  try {
    const searchOut = execSync(
      `gh issue list --repo "${hostRepo}" --state open --search "chore(kaizen): configure kaizen plugin" --json number,title,url --limit 5`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const results = JSON.parse(searchOut.trim()) as Array<{ number: number; title: string; url: string }>;
    const existing = results.find((r) => r.title === title);
    if (existing) {
      return {
        step: "ceremony",
        status: "skipped",
        issueNumber: existing.number,
        issueUrl: existing.url,
        reason: "tracking issue already exists",
      };
    }
  } catch (e) {
    // gh not authed or not installed — bail cleanly, do not block setup.
    return {
      step: "ceremony",
      status: "error",
      error: `gh issue list failed (is gh authenticated?): ${(e as Error).message}`,
    };
  }

  const issueBody = renderCeremonyIssueBody({ hostRepo, hostName });
  let issueUrl = "";
  let issueNumber = 0;
  try {
    const createOut = execSync(
      `gh issue create --repo "${hostRepo}" --title ${JSON.stringify(title)} --body-file -`,
      { encoding: "utf-8", input: issueBody, timeout: 30000 },
    );
    issueUrl = createOut.trim().split("\n").pop() ?? "";
    const match = issueUrl.match(/\/issues\/(\d+)/);
    if (match) issueNumber = parseInt(match[1], 10);
  } catch (e) {
    return {
      step: "ceremony",
      status: "error",
      error: `gh issue create failed: ${(e as Error).message}`,
    };
  }

  if (!issueNumber) {
    return {
      step: "ceremony",
      status: "error",
      issueUrl,
      error: `could not parse issue number from: ${issueUrl}`,
    };
  }

  // Store the plan attachment. This is best-effort — if it fails,
  // the admin still has an issue filed; they can attach the plan
  // manually via `/kaizen-write-plan`.
  const planUrl = storeCeremonyPlan({
    cwd,
    hostRepo,
    issueNumber,
    hostName,
    pluginRoot: opts.pluginRoot,
  });

  return {
    step: "ceremony",
    status: "ok",
    issueNumber,
    issueUrl,
    planUrl: planUrl || undefined,
    reason: planUrl ? undefined : "issue filed but plan attachment failed (file with /kaizen-write-plan)",
  };
}

function renderCeremonyIssueBody(opts: { hostRepo: string; hostName: string }): string {
  return `## Problem

The **${opts.hostName}** repo needs kaizen's enforcement hooks, reflection workflows, and dev workflow skills, but today has no \`kaizen.config.json\`, no \`.agents/kaizen/local/policies-local.md\`, no kaizen section in \`CLAUDE.md\`, and no kaizen pre-push git hook. kaizen is installed as a Claude Code plugin at project scope, so the plugin is active for every collaborator once they pull — but without this configuration, kaizen's hooks fire without context they expect.

## Scope

Close the setup gap by landing the artifacts \`/kaizen-setup\` produces:

- \`kaizen.config.json\` — host metadata + pointer to \`Garsson-io/kaizen\`
- \`.agents/kaizen/local/policies-local.md\` — scaffold for project-specific policies
- \`CLAUDE.md\` — appended kaizen plugin section (uses skill names + GitHub URLs; no local-path dependencies)
- \`.gitignore\` — kaizen session-local state entries
- Git pre-push hook — detected host framework (pre-commit / husky / lefthook / raw / none) + kaizen's pre-push dispatcher injected non-destructively

## Why this issue exists

This issue is filed by \`/kaizen-setup\` itself — kaizen adopts its own discipline from step one. The setup work will ship as a PR that closes this issue, giving every collaborator the same visibility into when and how kaizen was turned on.

## Acceptance

- [ ] \`npx kaizen-setup --step verify\` — all checks pass
- [ ] PR opened with \`Closes #<this-issue>\` and a stored plan (this issue carries the plan as a \`kaizen:plan\` attachment)
- [ ] After merge, a second collaborator clones fresh and \`/kaizen-setup --step verify\` reports clean

## Context

- Host: \`${opts.hostRepo}\`
- Plugin: \`Garsson-io/kaizen\` at project scope (\`--scope project\`)
- Filed by: \`/kaizen-setup\` ceremony step
`;
}

function storeCeremonyPlan(opts: {
  cwd: string;
  hostRepo: string;
  issueNumber: number;
  hostName: string;
  pluginRoot?: string;
}): string {
  const pluginRoot = opts.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? "";
  if (!pluginRoot) return "";

  const planMd = renderCeremonyPlan({ hostRepo: opts.hostRepo, hostName: opts.hostName });
  try {
    // execFileSync with an arg array keeps the shell out of the call
    // path entirely — each arg is passed as-is to npx/tsx and cannot
    // be parsed as shell metacharacters (CodeQL js/shell-command-injection).
    const out = execFileSync(
      "npx",
      [
        "--prefix",
        pluginRoot,
        "tsx",
        join(pluginRoot, "src/cli-structured-data.ts"),
        "store-plan",
        "--issue",
        String(opts.issueNumber),
        "--repo",
        opts.hostRepo,
        "--stdin",
      ],
      { encoding: "utf-8", input: planMd, timeout: 30000 },
    );
    const m = out.match(/https?:\/\/\S+/);
    return m ? m[0] : "";
  } catch {
    return "";
  }
}

function renderCeremonyPlan(opts: { hostRepo: string; hostName: string }): string {
  return `# Plan — configure kaizen plugin for ${opts.hostName}

**Path**: ceremony — setup ships as a PR, per #1085.

## Success Criteria

**GOAL**: \`${opts.hostRepo}\` is a kaizen host with the four setup artifacts on-disk, the pre-push hook active for every collaborator, and \`verify\` green.

**DONE WHEN**:

1. \`kaizen.config.json\` exists at repo root, points to \`Garsson-io/kaizen\`.
2. \`.agents/kaizen/local/policies-local.md\` scaffolded (empty OK — ready for project-specific rules).
3. \`CLAUDE.md\` contains a kaizen section (uses skill names + GitHub URLs; no local absolute paths).
4. \`.gitignore\` includes kaizen session-local entries.
5. Pre-push hook installed via detected framework; \`git push --dry-run\` exercises the dispatcher and does not fail-closed.
6. \`npx kaizen-setup --step verify\` reports all checks pass.

## Information Retrieved

- Host repo: ${opts.hostRepo}
- Plugin source: \`Garsson-io/kaizen\` (Claude Code plugin at project scope)
- Setup steps that already ran before this issue was filed: detect, precondition, enable, config, scaffold, claude-md-inject, install-git-hooks
- This plan is filed by \`/kaizen-setup\` itself so that \`enforce-plan-stored\` lets the setup PR through

## Design Alternatives Considered

### Alt A: Ship setup without an issue/plan — REJECTED
Rejected because: kaizen's enforcement hooks (\`enforce-plan-stored\`, worktree writes) will block the setup PR on its own. A setup that lands you in a state where your next action is blocked is hostile. Filing this tracking issue in the same \`/kaizen-setup\` invocation makes the install self-describing.

### Alt B: File issue but skip plan attachment — REJECTED
Rejected because: \`enforce-plan-stored\` specifically requires a stored plan attachment, not just an issue. Skipping the plan would leave the admin one step from being blocked.

## Tasks

1. Commit the on-disk artifacts from steps 2–6 above.
2. Open a PR with \`Closes #<issue>\`. PR body should include \`npx kaizen-setup --step verify\` output as evidence.
3. After merge, a teammate runs \`verify\` on a fresh clone to confirm the install propagates.

## Non-goals

- Tuning kaizen's policies beyond the scaffold — that's for a follow-up PR after the team sees kaizen in action for a sprint.
- Backfilling kaizen's issue-label taxonomy into existing issues.
`;
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
  const policiesPath = join(cwd, ".agents", "kaizen", "local", "policies-local.md");
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
      "run-post-install": { type: "string" },
      "plugin": { type: "string" },
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

    case "precondition":
      console.log(JSON.stringify(checkPreconditions(cwd)));
      break;

    case "claude-md-inject": {
      const pluginRoot = values["plugin-root"] ?? process.env.CLAUDE_PLUGIN_ROOT ?? "";
      if (!pluginRoot) {
        console.log(JSON.stringify({
          step: "claude-md-inject",
          status: "error",
          error: "plugin-root not set (pass --plugin-root or export CLAUDE_PLUGIN_ROOT)",
        }));
        process.exit(1);
      }
      console.log(JSON.stringify(injectClaudeMd({ cwd, pluginRoot })));
      break;
    }

    case "ceremony": {
      const configPath = join(cwd, "kaizen.config.json");
      if (!existsSync(configPath)) {
        console.log(
          JSON.stringify({
            step: "ceremony",
            status: "error",
            error: "kaizen.config.json not found — run --step config first",
          }),
        );
        process.exit(1);
      }
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const pluginRoot = values["plugin-root"] ?? process.env.CLAUDE_PLUGIN_ROOT;
      const out = registerCeremony({
        cwd,
        hostRepo: cfg.host?.repo ?? cfg.issues?.repo ?? "",
        hostName: cfg.host?.name ?? "host-project",
        pluginRoot,
      });
      console.log(JSON.stringify(out));
      break;
    }

    case "enable":
      console.log(JSON.stringify(enablePlugin(cwd, values["plugin"] ?? "kaizen@kaizen")));
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

    case "install-git-hooks": {
      // Epic #1059: install kaizen's pre-push hook into host project.
      // Option C: detect host framework; inject into theirs; raw fallback if none.
      const pluginRoot = values["plugin-root"] ?? process.env.CLAUDE_PLUGIN_ROOT;
      const entryTemplatePath = pluginRoot
        ? join(pluginRoot, "src/hooks/kaizen-host-entry.sh")
        : null;

      if (!entryTemplatePath || !existsSync(entryTemplatePath)) {
        console.log(JSON.stringify({
          step: "install-git-hooks",
          status: "error",
          error: `entry template not found: ${entryTemplatePath ?? "(plugin-root not set)"}`,
        }));
        process.exit(1);
      }

      const template = readFileSync(entryTemplatePath, "utf-8");
      // Substitute plugin root so the entry script can locate kaizen at runtime.
      // See src/hooks/kaizen-host-entry.sh: __KAIZEN_PLUGIN_ROOT__ is the placeholder.
      const entryContent = template.replace(/__KAIZEN_PLUGIN_ROOT__/g, pluginRoot ?? "");
      const runPostInstall = values["run-post-install"] === "true";

      const result: InstallResult = installGitHooks({ cwd, entryScriptContent: entryContent, runPostInstall });
      console.log(JSON.stringify({ step: "install-git-hooks", status: "ok", ...result }));
      break;
    }

    default:
      console.error(`Unknown step: ${values.step}`);
      console.error("Steps: detect, precondition, config, scaffold, enable, claude-md-inject, ceremony, verify, post-update-validate, install-git-hooks");
      process.exit(1);
  }
}
