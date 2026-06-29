/**
 * setup-git-hooks.ts — Install kaizen's pre-push hook into a host project (#1059).
 *
 * Detects the host's existing hook framework (pre-commit, husky, lefthook, raw, none)
 * and injects kaizen as a non-destructive addition. Per epic #1059 Option C:
 *
 *   1. If host has a recognized framework → inject into theirs (host owns core.hooksPath)
 *   2. If host has none → standalone install: .githooks/pre-push + core.hooksPath=.githooks
 *
 * Pre-commit is the PRIMARY supported framework per admin: "all repos we use now have pre-commit".
 *
 * All injection is idempotent: running twice does not duplicate entries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * Read a file, returning null if it doesn't exist. Replaces the
 * `existsSync(p) ? readFileSync(p) : fallback` pattern, which CodeQL flags
 * as `js/file-system-race` — the check and the read are two separate
 * syscalls with a TOCTOU window between them. A single `readFileSync`
 * inside try/catch collapses that to one syscall.
 */
function tryReadFileSync(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Atomically write a file by staging to `<path>.tmp-<pid>` and renaming.
 * `rename(2)` is atomic on POSIX, so concurrent readers never observe a
 * partially-written file and a crash mid-write cannot corrupt the target.
 * CodeQL's `js/file-system-race` rule accepts this pattern.
 */
function atomicWriteFileSync(targetPath: string, content: string, opts: { mode: number }): void {
  const tmp = `${targetPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode: opts.mode, flag: 'w' });
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export type HostFramework = 'pre-commit' | 'husky' | 'lefthook' | 'raw' | 'none';

export interface HostDetectionResult {
  framework: HostFramework;
  /** Path (relative to cwd) of the config/hook file detected. */
  configPath?: string;
  /** Path (relative to cwd) of an existing pre-push hook, if any. */
  existingHookPath?: string;
}

export interface InstallResult {
  framework: HostFramework;
  action: 'installed' | 'already_installed' | 'updated';
  filesModified: string[];
  /** Commands the host user or our CLI must run after injection (e.g., `pre-commit install --hook-type pre-push`). */
  postInstallCommands: string[];
  logMessage: string;
}

export interface InstallOptions {
  cwd: string;
  /** Path to the ` .kaizen-hooks/pre-push` template (resolved from plugin root). */
  entryScriptContent: string;
  /** Kaizen plugin/repo root, used to resolve the pre-commit remote rev. */
  pluginRoot?: string;
  /** Run post-install commands automatically (e.g., `pre-commit install --hook-type pre-push`). */
  runPostInstall?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────

export const KAIZEN_ENTRY_PATH = '.kaizen-hooks/pre-push';
export const KAIZEN_HOOK_ID = 'kaizen-pre-push';
export const KAIZEN_REMOTE_REPO = 'https://github.com/Garsson-io/kaizen';
export const KAIZEN_PRE_COMMIT_REPO = KAIZEN_REMOTE_REPO;
export const KAIZEN_LEFTHOOK_CONFIG = 'lefthook-kaizen.yml';
export const KAIZEN_CHAIN_MARKER = '# KAIZEN_CHAIN_START';
export const KAIZEN_CHAIN_END_MARKER = '# KAIZEN_CHAIN_END';

type PreCommitHook = { id: string; [k: string]: unknown };
type PreCommitRepo = { repo: string; rev?: string; hooks?: PreCommitHook[]; [k: string]: unknown };
type PreCommitConfig = { repos?: PreCommitRepo[]; [k: string]: unknown };
type LefthookRemote = { git_url: string; ref?: string; configs?: string[]; [k: string]: unknown };
type LefthookCommand = { run?: string; [k: string]: unknown };
type LefthookConfig = {
  remotes?: LefthookRemote[];
  'pre-push'?: { commands?: Record<string, LefthookCommand>; [k: string]: unknown };
  [k: string]: unknown;
};

function moduleRepoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function resolveKaizenRoot(pluginRoot?: string): string {
  const candidates = [
    pluginRoot,
    process.env.CLAUDE_PLUGIN_ROOT,
    process.cwd(),
    moduleRepoRoot(),
  ].filter((p): p is string => Boolean(p));

  return candidates.find((candidate) => existsSync(join(candidate, '.claude-plugin', 'plugin.json'))) ??
    pluginRoot ??
    process.cwd();
}

export function resolveKaizenPreCommitRev(pluginRoot?: string): string {
  const root = resolveKaizenRoot(pluginRoot);
  const tag = resolveKaizenVersionTag(root);
  if (tag) return tag;

  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return 'main';
  }
}

export function resolveKaizenLefthookRef(pluginRoot?: string): string {
  const root = resolveKaizenRoot(pluginRoot);
  const tag = resolveKaizenVersionTag(root);
  if (tag) return tag;

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (branch && branch !== 'HEAD' && !branch.includes('/')) return branch;
  } catch {
    // Fall through to stable default.
  }

  return 'main';
}

function resolveKaizenVersionTag(root: string): string | null {
  const pluginJson = tryReadFileSync(join(root, '.claude-plugin', 'plugin.json'));
  if (pluginJson) {
    const parsed = JSON.parse(pluginJson) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
      const version = parsed.version.trim();
      const tag = version.startsWith('v') ? version : `v${version}`;
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
          cwd: root,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        return tag;
      } catch {
        // Do not emit an unfetchable provider ref. The plugin version is only
        // a valid remote-provider ref once the corresponding git tag exists.
      }
    }
  }
  return null;
}

function kaizenPreCommitRepo(pluginRoot?: string): PreCommitRepo {
  return {
    repo: KAIZEN_PRE_COMMIT_REPO,
    rev: resolveKaizenPreCommitRev(pluginRoot),
    hooks: [
      {
        id: KAIZEN_HOOK_ID,
        stages: ['pre-push'],
      },
    ],
  };
}

function kaizenLefthookRemote(pluginRoot?: string): LefthookRemote {
  return {
    git_url: KAIZEN_PRE_COMMIT_REPO,
    ref: resolveKaizenLefthookRef(pluginRoot),
    configs: [KAIZEN_LEFTHOOK_CONFIG],
  };
}

/**
 * Build the marker-bracketed shell block that hook frameworks chain to
 * `.kaizen-hooks/pre-push`. The only thing that varies across frameworks is
 * how the entry script is located — husky's `.husky/pre-push` runs in the
 * hooks dir so it uses `$(dirname "$0")/../`, while raw `.git/hooks/pre-push`
 * and `.githooks/pre-push` run without guaranteed cwd and use
 * `$(git rev-parse --show-toplevel)`. Centralizing the block keeps the
 * comment, marker pair, guard, and execution semantics identical across all
 * three injectors (previously three hand-maintained copies — dry/tooling
 * finding, round 5).
 */
function buildChainBlock(entryExpr: string, includeHeaderComment = true): string {
  const lines = [
    '',
    KAIZEN_CHAIN_MARKER,
  ];
  if (includeHeaderComment) {
    lines.push(`# Added by kaizen /kaizen-setup (see epic #1059)`);
  }
  lines.push(
    `if [ -x "${entryExpr}" ]; then`,
    `  "${entryExpr}" "$@" || exit $?`,
    'fi',
    KAIZEN_CHAIN_END_MARKER,
    '',
  );
  return lines.join('\n');
}

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Detect which hook framework the host uses.
 *
 * Detection order (first match wins):
 *   1. pre-commit — `.pre-commit-config.yaml` present (PRIMARY)
 *   2. husky — `.husky/` directory present
 *   3. lefthook — `lefthook.yml` present
 *   4. raw — existing `.git/hooks/pre-push` (user-maintained)
 *   5. none — nothing detected
 */
export function detectHostFramework(cwd: string): HostDetectionResult {
  // 1. pre-commit (primary)
  const preCommitPath = join(cwd, '.pre-commit-config.yaml');
  if (existsSync(preCommitPath)) {
    return { framework: 'pre-commit', configPath: '.pre-commit-config.yaml' };
  }

  // 2. husky
  const huskyDir = join(cwd, '.husky');
  if (existsSync(huskyDir)) {
    const huskyPrePush = join(huskyDir, 'pre-push');
    return {
      framework: 'husky',
      configPath: '.husky',
      existingHookPath: existsSync(huskyPrePush) ? '.husky/pre-push' : undefined,
    };
  }

  // 3. lefthook
  const lefthookPath = join(cwd, 'lefthook.yml');
  if (existsSync(lefthookPath)) {
    return { framework: 'lefthook', configPath: 'lefthook.yml' };
  }

  // 4. raw .git/hooks/pre-push
  const rawPrePush = join(cwd, '.git', 'hooks', 'pre-push');
  if (existsSync(rawPrePush)) {
    return { framework: 'raw', existingHookPath: '.git/hooks/pre-push' };
  }

  // 5. none
  return { framework: 'none' };
}

// ── Thin wrapper builder ──────────────────────────────────────────────

/**
 * Build the host-side `.kaizen-hooks/pre-push` content as a THIN WRAPPER
 * that dispatches to the plugin-resident `kaizen-host-entry.sh` (#1086).
 *
 * Why a wrapper and not a copy: the previous design wrote a ~66-line *copy*
 * of `kaizen-host-entry.sh` into the host repo with `__KAIZEN_PLUGIN_ROOT__`
 * substituted. That copy froze the host's pre-push logic at the kaizen
 * version present when setup last ran — bug fixes to the gate never reached
 * the host until it re-ran `/kaizen-setup`. That is the opposite of kaizen's
 * continuous-improvement loop: an incident that teaches us something about
 * pre-push couldn't propagate.
 *
 * The wrapper holds ONLY the version-stable plumbing — resolve the plugin
 * root, then `exec` the canonical entry inside the plugin. All logic that
 * changes version-to-version (agent-env gate, tsx resolution, dispatch to
 * `pre-push.ts`) lives in `kaizen-host-entry.sh` inside the plugin, so a
 * plugin update reaches every host automatically.
 *
 * Resolution order mirrors `kaizen-host-entry.sh`:
 *   1. `$CLAUDE_PLUGIN_ROOT` (set by Claude Code at invocation time)
 *   2. the baked-in install-time path (`pluginRoot` arg)
 *   3. a search of the Claude plugin cache
 *   4. fail-open (never block a push if kaizen can't be located)
 *
 * Deliberately NO agent-env gate here. `kaizen-host-entry.sh` already gates
 * on the agent-env vars as its first action, and `agent-env-agreement.test.ts`
 * pins that var list against `pre-push.ts` so it can't drift. Duplicating the
 * gate into the wrapper would add a third copy of that list to keep in sync —
 * the exact drift hazard the agreement test exists to prevent. In the common
 * case the baked-in path resolves without a cache scan, so a human push still
 * exits fast once it reaches the entry's gate. The resolved root is exported
 * as `CLAUDE_PLUGIN_ROOT` so the entry re-resolves to the same plugin.
 */
export function buildThinWrapper(pluginRoot: string): string {
  return `#!/usr/bin/env bash
# Kaizen host-project pre-push wrapper (installed by /kaizen-setup, #1086).
#
# THIN WRAPPER — do not add logic here. This file resolves the kaizen plugin
# root and execs the canonical entry inside the plugin. All version-sensitive
# behavior (agent-env gate, runtime resolution, hook dispatch) lives in
# \$KAIZEN_ROOT/src/hooks/kaizen-host-entry.sh, so a plugin update reaches this
# host automatically — no need to re-run /kaizen-setup.

set -eu

# Resolve kaizen plugin root: env -> baked-in install path -> cache -> fail-open.
KAIZEN_ROOT="\${CLAUDE_PLUGIN_ROOT:-}"
if [ ! -d "\$KAIZEN_ROOT" ]; then
  KAIZEN_ROOT="${pluginRoot}"
fi
if [ ! -d "\$KAIZEN_ROOT" ]; then
  CACHE_ROOT="\${HOME}/.claude/plugins/cache"
  if [ -d "\$CACHE_ROOT" ]; then
    CANDIDATE=\$(find "\$CACHE_ROOT" -maxdepth 5 -name "plugin.json" -path "*kaizen*" 2>/dev/null | head -1 || true)
    [ -n "\$CANDIDATE" ] && KAIZEN_ROOT=\$(dirname "\$(dirname "\$CANDIDATE")")
  fi
fi

# Fail-open: never block a push if kaizen can't be located.
[ -d "\$KAIZEN_ROOT" ] || exit 0

ENTRY="\$KAIZEN_ROOT/src/hooks/kaizen-host-entry.sh"
[ -f "\$ENTRY" ] || exit 0

# Export the resolved root so the entry re-resolves to the same plugin.
export CLAUDE_PLUGIN_ROOT="\$KAIZEN_ROOT"
exec bash "\$ENTRY" "\$@"
`;
}

// ── Entry script writer ───────────────────────────────────────────────

export function writeEntryScript(cwd: string, content: string): string {
  const dir = join(cwd, '.kaizen-hooks');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const target = join(dir, 'pre-push');
  writeFileSync(target, content, { mode: 0o755 });
  chmodSync(target, 0o755);
  return KAIZEN_ENTRY_PATH;
}

// ── Framework-specific injectors ──────────────────────────────────────

/**
 * Inject into pre-commit config (PRIMARY).
 *
 * Adds a remote kaizen repo entry with `id: kaizen-pre-push`,
 * `stages: [pre-push]`. Idempotent — detects existing remote entry by id.
 *
 * Post-install: `pre-commit install --hook-type pre-push` (defaults to only
 * installing the `pre-commit` stage).
 */
export function injectIntoPreCommit(cwd: string, opts: { pluginRoot?: string } = {}): InstallResult {
  const configPath = join(cwd, '.pre-commit-config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (YAML.parse(raw) ?? {}) as PreCommitConfig;

  if (!Array.isArray(parsed.repos)) parsed.repos = [];

  let changed = false;

  for (let i = parsed.repos.length - 1; i >= 0; i -= 1) {
    const repo = parsed.repos[i];
    if (repo.repo !== 'local' || !Array.isArray(repo.hooks)) continue;
    const before = repo.hooks.length;
    repo.hooks = repo.hooks.filter((h) => h.id !== KAIZEN_HOOK_ID);
    if (repo.hooks.length !== before) changed = true;
    if (repo.hooks.length === 0) {
      parsed.repos.splice(i, 1);
    }
  }

  const cleanedHookDir = cleanupLegacyKaizenHookDir(cwd);
  changed = changed || cleanedHookDir;

  let remote = parsed.repos.find((r) => r.repo === KAIZEN_PRE_COMMIT_REPO);
  if (!remote) {
    remote = kaizenPreCommitRepo(opts.pluginRoot);
    parsed.repos.push(remote);
    changed = true;
  } else {
    if (!remote.rev) {
      remote.rev = resolveKaizenPreCommitRev(opts.pluginRoot);
      changed = true;
    }
    if (!Array.isArray(remote.hooks)) {
      remote.hooks = [];
      changed = true;
    }
    if (!remote.hooks.some((h) => h.id === KAIZEN_HOOK_ID)) {
      remote.hooks.push({ id: KAIZEN_HOOK_ID, stages: ['pre-push'] });
      changed = true;
    }
  }

  if (!changed) {
    return {
      framework: 'pre-commit',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `pre-commit: remote hook id '${KAIZEN_HOOK_ID}' already present in ${configPath} — no change`,
    };
  }

  writeFileSync(configPath, YAML.stringify(parsed));

  return {
    framework: 'pre-commit',
    action: cleanedHookDir ? 'updated' : 'installed',
    filesModified: cleanedHookDir ? [configPath, join(cwd, '.kaizen-hooks')] : [configPath],
    postInstallCommands: ['pre-commit install --hook-type pre-push'],
    logMessage: `pre-commit: added remote hook '${KAIZEN_HOOK_ID}' to ${configPath}. Run 'pre-commit install --hook-type pre-push' to activate.`,
  };
}

function cleanupLegacyKaizenHookDir(cwd: string): boolean {
  const dir = join(cwd, '.kaizen-hooks');
  if (!existsSync(dir)) return false;

  const entries = readdirSync(dir);
  if (entries.length === 0 || entries.every((entry) => entry === 'pre-push')) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  const prePush = join(dir, 'pre-push');
  if (existsSync(prePush)) {
    unlinkSync(prePush);
    return true;
  }
  return false;
}

/**
 * Inject into husky's .husky/pre-push.
 *
 * Appends a chain-exec line wrapped in KAIZEN_CHAIN markers for idempotent detection.
 */
export function injectIntoHusky(cwd: string): InstallResult {
  const huskyDir = join(cwd, '.husky');
  const hookPath = join(huskyDir, 'pre-push');

  const existing = tryReadFileSync(hookPath) ?? '#!/usr/bin/env bash\n';

  // Idempotency
  if (existing.includes(KAIZEN_CHAIN_MARKER)) {
    return {
      framework: 'husky',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `husky: kaizen chain already present in ${hookPath} — no change`,
    };
  }

  const chainBlock = buildChainBlock(`$(dirname "$0")/../${KAIZEN_ENTRY_PATH}`);

  atomicWriteFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
  chmodSync(hookPath, 0o755);

  return {
    framework: 'husky',
    action: existing === '#!/usr/bin/env bash\n' ? 'installed' : 'updated',
    filesModified: [hookPath],
    postInstallCommands: [],
    logMessage: `husky: injected kaizen chain into ${hookPath}`,
  };
}

/**
 * Inject into lefthook.yml.
 */
export function injectIntoLefthook(cwd: string, opts: { pluginRoot?: string } = {}): InstallResult {
  const configPath = join(cwd, 'lefthook.yml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (YAML.parse(raw) ?? {}) as LefthookConfig;

  let changed = false;
  let removedLegacyCommand = false;

  const commands = parsed['pre-push']?.commands;
  if (commands?.[KAIZEN_HOOK_ID]) {
    delete commands[KAIZEN_HOOK_ID];
    removedLegacyCommand = true;
    changed = true;
    if (Object.keys(commands).length === 0 && parsed['pre-push']) {
      delete parsed['pre-push'].commands;
    }
  }

  const cleanedHookDir = removedLegacyCommand ? cleanupLegacyKaizenHookDir(cwd) : false;
  changed = changed || cleanedHookDir;

  if (!Array.isArray(parsed.remotes)) parsed.remotes = [];
  let remote = parsed.remotes.find((r) => r.git_url === KAIZEN_PRE_COMMIT_REPO);
  if (!remote) {
    remote = kaizenLefthookRemote(opts.pluginRoot);
    parsed.remotes.push(remote);
    changed = true;
  } else {
    if (!remote.ref) {
      remote.ref = resolveKaizenLefthookRef(opts.pluginRoot);
      changed = true;
    }
    if (!Array.isArray(remote.configs)) {
      remote.configs = [];
      changed = true;
    }
    if (!remote.configs.includes(KAIZEN_LEFTHOOK_CONFIG)) {
      remote.configs.push(KAIZEN_LEFTHOOK_CONFIG);
      changed = true;
    }
  }

  if (!changed) {
    return {
      framework: 'lefthook',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `lefthook: remote config '${KAIZEN_LEFTHOOK_CONFIG}' already present in ${configPath} — no change`,
    };
  }

  writeFileSync(configPath, YAML.stringify(parsed));

  return {
    framework: 'lefthook',
    action: removedLegacyCommand || cleanedHookDir ? 'updated' : 'installed',
    filesModified: cleanedHookDir ? [configPath, join(cwd, '.kaizen-hooks')] : [configPath],
    postInstallCommands: ['lefthook install'],
    logMessage: `lefthook: added remote config '${KAIZEN_LEFTHOOK_CONFIG}' to ${configPath}. Run 'lefthook install' to activate.`,
  };
}

/**
 * Append chain line to existing raw .git/hooks/pre-push.
 */
export function injectIntoRaw(cwd: string): InstallResult {
  const hookPath = join(cwd, '.git', 'hooks', 'pre-push');
  const existing = tryReadFileSync(hookPath) ?? '#!/usr/bin/env bash\n';

  if (existing.includes(KAIZEN_CHAIN_MARKER)) {
    return {
      framework: 'raw',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `raw: kaizen chain already present in ${hookPath} — no change`,
    };
  }

  const chainBlock = buildChainBlock(`$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}`);

  atomicWriteFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
  chmodSync(hookPath, 0o755);

  return {
    framework: 'raw',
    action: 'updated',
    filesModified: [hookPath],
    postInstallCommands: [],
    logMessage: `raw: injected kaizen chain into ${hookPath}`,
  };
}

/**
 * Standalone install: create .githooks/pre-push and set core.hooksPath.
 * Used when no framework is detected.
 */
export function installStandalone(cwd: string): InstallResult {
  const hooksDir = join(cwd, '.githooks');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'pre-push');
  const existing = tryReadFileSync(hookPath);
  if (existing !== null) {
    if (existing.includes(KAIZEN_CHAIN_MARKER)) {
      return {
        framework: 'none',
        action: 'already_installed',
        filesModified: [],
        postInstallCommands: [],
        logMessage: `standalone: kaizen chain already present in ${hookPath} — no change`,
      };
    }
    // Exists but doesn't chain — append a chain block (no header comment,
    // matching the pre-existing standalone style).
    const chainBlock = buildChainBlock(
      `$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}`,
      false,
    );
    atomicWriteFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
  } else {
    const content = [
      '#!/usr/bin/env bash',
      '# .githooks/pre-push — kaizen-managed entry (epic #1059)',
      '',
      KAIZEN_CHAIN_MARKER,
      `if [ -x "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" ]; then`,
      `  exec "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" "$@"`,
      'fi',
      'exit 0',
      KAIZEN_CHAIN_END_MARKER,
      '',
    ].join('\n');
    atomicWriteFileSync(hookPath, content, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
  }

  // Set core.hooksPath (idempotent — git config is a no-op if value is already set).
  // Use cwd option instead of -C interpolation to avoid shell injection on
  // directory names with shell metacharacters.
  try {
    execSync('git config core.hooksPath .githooks', { cwd, stdio: 'pipe' });
  } catch {
    // Not a git repo or config failed — log but don't throw
  }

  return {
    framework: 'none',
    action: 'installed',
    filesModified: [hookPath],
    postInstallCommands: [],
    logMessage: `standalone: created ${hookPath} and set core.hooksPath=.githooks`,
  };
}

// ── Orchestration ─────────────────────────────────────────────────────

/**
 * Main entry: detect framework, write entry script, inject.
 *
 * Per Option C: host owns core.hooksPath when a framework is detected; we
 * own it only when no framework is present. Idempotent end-to-end.
 */
export function installGitHooks(options: InstallOptions): InstallResult {
  const { cwd, entryScriptContent } = options;

  // 1. Detect framework before writing host files. Framework-native remote
  // paths intentionally write no host-side kaizen wrapper.
  const detection = detectHostFramework(cwd);

  if (detection.framework !== 'pre-commit' && detection.framework !== 'lefthook') {
    writeEntryScript(cwd, entryScriptContent);
  }

  // 2. Inject per framework
  let result: InstallResult;
  switch (detection.framework) {
    case 'pre-commit':
      result = injectIntoPreCommit(cwd, { pluginRoot: options.pluginRoot });
      break;
    case 'husky':
      result = injectIntoHusky(cwd);
      break;
    case 'lefthook':
      result = injectIntoLefthook(cwd, { pluginRoot: options.pluginRoot });
      break;
    case 'raw':
      result = injectIntoRaw(cwd);
      break;
    case 'none':
      result = installStandalone(cwd);
      break;
  }

  // 4. Run post-install commands if requested
  if (options.runPostInstall && result.postInstallCommands.length > 0) {
    for (const cmd of result.postInstallCommands) {
      try {
        execSync(cmd, { cwd, stdio: 'pipe' });
      } catch (err) {
        result.logMessage += ` (post-install '${cmd}' failed: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
  }

  return result;
}
