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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import YAML from 'yaml';

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
  /** Run post-install commands automatically (e.g., `pre-commit install --hook-type pre-push`). */
  runPostInstall?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────

export const KAIZEN_ENTRY_PATH = '.kaizen-hooks/pre-push';
export const KAIZEN_HOOK_ID = 'kaizen-pre-push';
export const KAIZEN_CHAIN_MARKER = '# KAIZEN_CHAIN_START';
export const KAIZEN_CHAIN_END_MARKER = '# KAIZEN_CHAIN_END';

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
 * Adds a `local` repo entry with `id: kaizen-pre-push`, `stages: [pre-push]`.
 * Idempotent — detects existing entry by id.
 *
 * Post-install: `pre-commit install --hook-type pre-push` (defaults to only
 * installing the `pre-commit` stage).
 */
export function injectIntoPreCommit(cwd: string): InstallResult {
  const configPath = join(cwd, '.pre-commit-config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (YAML.parse(raw) ?? {}) as { repos?: Array<{ repo: string; hooks?: Array<{ id: string; [k: string]: unknown }> }> };

  if (!Array.isArray(parsed.repos)) parsed.repos = [];

  // Find or create the local repo block
  let local = parsed.repos.find(r => r.repo === 'local');
  if (!local) {
    local = { repo: 'local', hooks: [] };
    parsed.repos.push(local);
  }
  if (!Array.isArray(local.hooks)) local.hooks = [];

  // Idempotency — bail if already present
  if (local.hooks.some(h => h.id === KAIZEN_HOOK_ID)) {
    return {
      framework: 'pre-commit',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `pre-commit: hook id '${KAIZEN_HOOK_ID}' already present in ${configPath} — no change`,
    };
  }

  local.hooks.push({
    id: KAIZEN_HOOK_ID,
    name: 'Kaizen pre-push gate',
    entry: KAIZEN_ENTRY_PATH,
    language: 'script',
    stages: ['pre-push'],
    always_run: true,
    pass_filenames: false,
    verbose: false,
  });

  writeFileSync(configPath, YAML.stringify(parsed));

  return {
    framework: 'pre-commit',
    action: 'installed',
    filesModified: [configPath],
    postInstallCommands: ['pre-commit install --hook-type pre-push'],
    logMessage: `pre-commit: added local hook '${KAIZEN_HOOK_ID}' to ${configPath}. Run 'pre-commit install --hook-type pre-push' to activate.`,
  };
}

/**
 * Inject into husky's .husky/pre-push.
 *
 * Appends a chain-exec line wrapped in KAIZEN_CHAIN markers for idempotent detection.
 */
export function injectIntoHusky(cwd: string): InstallResult {
  const huskyDir = join(cwd, '.husky');
  const hookPath = join(huskyDir, 'pre-push');

  let existing = '';
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, 'utf-8');
  } else {
    existing = '#!/usr/bin/env bash\n';
  }

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

  const chainBlock = [
    '',
    KAIZEN_CHAIN_MARKER,
    `# Added by kaizen /kaizen-setup (see epic #1059)`,
    `if [ -x "$(dirname "$0")/../${KAIZEN_ENTRY_PATH}" ]; then`,
    `  "$(dirname "$0")/../${KAIZEN_ENTRY_PATH}" "$@" || exit $?`,
    'fi',
    KAIZEN_CHAIN_END_MARKER,
    '',
  ].join('\n');

  writeFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
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
export function injectIntoLefthook(cwd: string): InstallResult {
  const configPath = join(cwd, 'lefthook.yml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (YAML.parse(raw) ?? {}) as {
    'pre-push'?: { commands?: Record<string, { run: string; [k: string]: unknown }> };
  };

  if (!parsed['pre-push']) parsed['pre-push'] = {};
  if (!parsed['pre-push'].commands) parsed['pre-push'].commands = {};

  if (parsed['pre-push'].commands[KAIZEN_HOOK_ID]) {
    return {
      framework: 'lefthook',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `lefthook: command '${KAIZEN_HOOK_ID}' already present — no change`,
    };
  }

  parsed['pre-push'].commands[KAIZEN_HOOK_ID] = {
    run: `./${KAIZEN_ENTRY_PATH}`,
  };

  writeFileSync(configPath, YAML.stringify(parsed));

  return {
    framework: 'lefthook',
    action: 'installed',
    filesModified: [configPath],
    postInstallCommands: ['lefthook install'],
    logMessage: `lefthook: added command '${KAIZEN_HOOK_ID}' to ${configPath}`,
  };
}

/**
 * Append chain line to existing raw .git/hooks/pre-push.
 */
export function injectIntoRaw(cwd: string): InstallResult {
  const hookPath = join(cwd, '.git', 'hooks', 'pre-push');
  let existing = '';
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, 'utf-8');
  } else {
    existing = '#!/usr/bin/env bash\n';
  }

  if (existing.includes(KAIZEN_CHAIN_MARKER)) {
    return {
      framework: 'raw',
      action: 'already_installed',
      filesModified: [],
      postInstallCommands: [],
      logMessage: `raw: kaizen chain already present in ${hookPath} — no change`,
    };
  }

  const chainBlock = [
    '',
    KAIZEN_CHAIN_MARKER,
    `# Added by kaizen /kaizen-setup (see epic #1059)`,
    `if [ -x "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" ]; then`,
    `  "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" "$@" || exit $?`,
    'fi',
    KAIZEN_CHAIN_END_MARKER,
    '',
  ].join('\n');

  writeFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
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
  // If it already exists and already chains, don't touch
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(KAIZEN_CHAIN_MARKER)) {
      return {
        framework: 'none',
        action: 'already_installed',
        filesModified: [],
        postInstallCommands: [],
        logMessage: `standalone: kaizen chain already present in ${hookPath} — no change`,
      };
    }
    // Exists but doesn't chain — append a chain block
    const chainBlock = [
      '',
      KAIZEN_CHAIN_MARKER,
      `if [ -x "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" ]; then`,
      `  "$(git rev-parse --show-toplevel)/${KAIZEN_ENTRY_PATH}" "$@" || exit $?`,
      'fi',
      KAIZEN_CHAIN_END_MARKER,
      '',
    ].join('\n');
    writeFileSync(hookPath, existing.trimEnd() + '\n' + chainBlock, { mode: 0o755 });
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
    writeFileSync(hookPath, content, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
  }

  // Set core.hooksPath (idempotent — git config is a no-op if value is already set)
  try {
    execSync(`git -C "${cwd}" config core.hooksPath .githooks`, { stdio: 'pipe' });
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

  // 1. Always write the entry script (idempotent — overwrite is safe since content is tool-managed)
  writeEntryScript(cwd, entryScriptContent);

  // 2. Detect framework
  const detection = detectHostFramework(cwd);

  // 3. Inject per framework
  let result: InstallResult;
  switch (detection.framework) {
    case 'pre-commit':
      result = injectIntoPreCommit(cwd);
      break;
    case 'husky':
      result = injectIntoHusky(cwd);
      break;
    case 'lefthook':
      result = injectIntoLefthook(cwd);
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
