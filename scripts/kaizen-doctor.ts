#!/usr/bin/env npx tsx
/**
 * kaizen-doctor — diagnose Claude Code plugin/hook setup for this project.
 *
 * Usage:
 *   npx tsx scripts/kaizen-doctor.ts              pretty output, exit 1 if any FAIL
 *   npx tsx scripts/kaizen-doctor.ts --json       machine output
 *   npx tsx scripts/kaizen-doctor.ts --quiet      suppress PASS lines
 *
 * Background: #1061 — mid-session plugin state changes (enabledPlugins edits,
 * cache deletion, installed_plugins.json mutation) do NOT take effect until
 * Claude Code restarts. The stale in-memory hook registry keeps firing hooks
 * against paths that no longer exist, producing silent
 * `Failed with non-blocking status code: No stderr output` errors on every
 * matching tool call. This CLI detects each failure mode and prints a
 * restart-needed banner when the on-disk state has drifted from the
 * session-start snapshot.
 */

import {
  existsSync,
  readFileSync,
  constants as fsConstants,
  accessSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOpts {
  projectRoot: string;
  homeDir: string;
  pluginName?: string;
}

const DEFAULT_PLUGIN = 'kaizen@kaizen';

function safeReadJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function sha256File(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function collectHookCommands(cfg: unknown): string[] {
  const out: string[] = [];
  function walk(x: unknown): void {
    if (Array.isArray(x)) {
      for (const e of x) walk(e);
    } else if (x && typeof x === 'object') {
      const obj = x as Record<string, unknown>;
      if (obj.type === 'command' && typeof obj.command === 'string') {
        out.push(obj.command);
      }
      for (const v of Object.values(obj)) walk(v);
    }
  }
  walk(cfg);
  return out;
}

/** Resolve the actual executable path from a hook `command` string.
 *  Strips args, expands ${CLAUDE_PLUGIN_ROOT} against projectRoot, and
 *  resolves relative paths against projectRoot. */
export function resolveHookPath(command: string, projectRoot: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const expanded = first.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, projectRoot);
  if (isAbsolute(expanded)) return expanded;
  return resolve(projectRoot, expanded);
}

/** Check 1: project-scope double install. */
export function checkPluginDoubleInstall(opts: DoctorOpts): CheckResult {
  const plugin = opts.pluginName ?? DEFAULT_PLUGIN;
  const settings = safeReadJson(join(opts.projectRoot, '.claude/settings.json')) as
    | Record<string, unknown>
    | null;
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>;
  const isEnabled = !!enabled[plugin];

  const commands = collectHookCommands(settings?.hooks);
  const hasOwnHooks = commands.some(c => c.includes('./.claude/hooks/'));

  if (isEnabled && hasOwnHooks) {
    return {
      name: 'plugin-double-install',
      status: 'FAIL',
      detail: `"${plugin}" is in enabledPlugins AND project settings.json registers its own hooks — duplicate registration will flood every tool call with errors. Remove enabledPlugins["${plugin}"] from .claude/settings.json.`,
    };
  }
  if (isEnabled) {
    return {
      name: 'plugin-double-install',
      status: 'WARN',
      detail: `"${plugin}" is in enabledPlugins but project hooks not duplicated — unusual but not broken.`,
    };
  }
  return {
    name: 'plugin-double-install',
    status: 'PASS',
    detail: `no double-install of "${plugin}".`,
  };
}

/** Check 2: every referenced hook command resolves to an existing file. */
export function checkDanglingHookPaths(opts: DoctorOpts): CheckResult {
  const cfgs: Array<{ path: string; label: string }> = [
    { path: join(opts.projectRoot, '.claude/settings.json'), label: 'settings.json' },
    { path: join(opts.projectRoot, '.claude-plugin/plugin.json'), label: 'plugin.json' },
  ];
  const missing: string[] = [];
  let total = 0;
  for (const cfg of cfgs) {
    const data = safeReadJson(cfg.path);
    if (!data) continue;
    for (const c of collectHookCommands(data)) {
      total++;
      const hookPath = resolveHookPath(c, opts.projectRoot);
      if (!existsSync(hookPath)) {
        missing.push(`${cfg.label}: ${hookPath}`);
      }
    }
  }
  if (total === 0) {
    return {
      name: 'dangling-hook-paths',
      status: 'WARN',
      detail: 'no hook registrations found in settings.json or plugin.json.',
    };
  }
  if (missing.length > 0) {
    return {
      name: 'dangling-hook-paths',
      status: 'FAIL',
      detail: `${missing.length}/${total} hook paths missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}`,
    };
  }
  return {
    name: 'dangling-hook-paths',
    status: 'PASS',
    detail: `all ${total} hook paths resolve.`,
  };
}

/** Check 3: cache-dir vs installed_plugins.json consistency. */
export function checkStalePluginCache(opts: DoctorOpts): CheckResult {
  const plugin = opts.pluginName ?? DEFAULT_PLUGIN;
  const shortName = plugin.split('@')[0] ?? plugin;
  const installedPath = join(opts.homeDir, '.claude/plugins/installed_plugins.json');
  const cacheDir = join(opts.homeDir, `.claude/plugins/cache/${shortName}`);

  const installed = safeReadJson(installedPath) as
    | { plugins?: Record<string, unknown> }
    | null;
  const hasRecord = !!installed?.plugins?.[plugin];
  const hasCache = existsSync(cacheDir);

  if (hasRecord && !hasCache) {
    return {
      name: 'stale-plugin-cache',
      status: 'FAIL',
      detail: `installed_plugins.json has record for "${plugin}" but cache dir missing (${cacheDir}). Registered hooks will fail silently. Run scripts/kaizen-uninstall-plugin.sh then restart Claude Code.`,
    };
  }
  if (!hasRecord && hasCache) {
    return {
      name: 'stale-plugin-cache',
      status: 'WARN',
      detail: `cache dir present (${cacheDir}) but no installed_plugins.json record. Orphan cache — safe to delete.`,
    };
  }
  return {
    name: 'stale-plugin-cache',
    status: 'PASS',
    detail: hasRecord
      ? `installed_plugins and cache consistent for "${plugin}".`
      : `"${plugin}" not installed, no cache.`,
  };
}

/** Path to the session-start snapshot for this project. */
export function snapshotPath(opts: DoctorOpts): string {
  const hash = createHash('sha256')
    .update(opts.projectRoot)
    .digest('hex')
    .slice(0, 16);
  return join(opts.homeDir, '.claude/kaizen-snapshots', `${hash}.json`);
}

export interface SessionSnapshot {
  ts: string;
  project: string;
  hashes: Record<string, string | null>;
}

/** Files whose content, if changed mid-session, requires a Claude Code restart.
 *
 *  Intentionally excludes `.claude/settings.json`: inline hook entries in
 *  settings.json hot-reload, and `enabledPlugins` changes are already caught
 *  by `plugin-double-install` and `stale-plugin-cache`. Hashing settings.json
 *  would false-positive on every inline hook edit. */
export function restartSensitiveFiles(opts: DoctorOpts): Array<{ label: string; path: string }> {
  return [
    { label: 'project-plugin-manifest', path: join(opts.projectRoot, '.claude-plugin/plugin.json') },
    { label: 'installed-plugins', path: join(opts.homeDir, '.claude/plugins/installed_plugins.json') },
    { label: 'known-marketplaces', path: join(opts.homeDir, '.claude/plugins/known_marketplaces.json') },
  ];
}

/** Build a snapshot of current on-disk state. */
export function buildSnapshot(opts: DoctorOpts): SessionSnapshot {
  const hashes: Record<string, string | null> = {};
  for (const f of restartSensitiveFiles(opts)) {
    hashes[f.label] = sha256File(f.path);
  }
  return { ts: new Date().toISOString(), project: opts.projectRoot, hashes };
}

/** Check 4: restart-needed (current hashes differ from session-start snapshot). */
export function checkRestartNeeded(opts: DoctorOpts): CheckResult {
  const snapPath = snapshotPath(opts);
  if (!existsSync(snapPath)) {
    return {
      name: 'restart-needed',
      status: 'WARN',
      detail: `no session-start snapshot (${snapPath}) — cannot detect drift. Install kaizen-session-snapshot SessionStart hook to enable this check.`,
    };
  }
  const snap = safeReadJson(snapPath) as SessionSnapshot | null;
  if (!snap || typeof snap !== 'object' || !snap.hashes) {
    return {
      name: 'restart-needed',
      status: 'WARN',
      detail: `snapshot unreadable at ${snapPath} — delete it to re-snapshot next session.`,
    };
  }
  const current = buildSnapshot(opts);
  const drifted: string[] = [];
  for (const [label, prev] of Object.entries(snap.hashes)) {
    const now = current.hashes[label];
    if (prev !== now) drifted.push(label);
  }
  if (drifted.length > 0) {
    return {
      name: 'restart-needed',
      status: 'FAIL',
      detail: `Claude Code restart REQUIRED — ${drifted.join(', ')} changed since session start. Hook registry is stale until restart.`,
    };
  }
  return {
    name: 'restart-needed',
    status: 'PASS',
    detail: 'on-disk state matches session-start snapshot.',
  };
}

/** Check 5: every referenced hook file is executable. */
export function checkHookExecSmoke(opts: DoctorOpts): CheckResult {
  const cfgs = [
    join(opts.projectRoot, '.claude/settings.json'),
    join(opts.projectRoot, '.claude-plugin/plugin.json'),
  ];
  const nonExec: string[] = [];
  let total = 0;
  for (const cfgPath of cfgs) {
    const data = safeReadJson(cfgPath);
    if (!data) continue;
    for (const c of collectHookCommands(data)) {
      const hookPath = resolveHookPath(c, opts.projectRoot);
      if (!existsSync(hookPath)) continue;
      total++;
      try {
        accessSync(hookPath, fsConstants.X_OK);
      } catch {
        nonExec.push(hookPath);
      }
    }
  }
  if (total === 0) {
    return {
      name: 'hook-exec-smoke',
      status: 'PASS',
      detail: 'no resolvable hook paths to check.',
    };
  }
  if (nonExec.length > 0) {
    return {
      name: 'hook-exec-smoke',
      status: 'FAIL',
      detail: `${nonExec.length}/${total} hook files not executable: ${nonExec.slice(0, 3).join('; ')}`,
    };
  }
  return {
    name: 'hook-exec-smoke',
    status: 'PASS',
    detail: `all ${total} hook files executable.`,
  };
}

export function runAllChecks(opts: DoctorOpts): CheckResult[] {
  return [
    checkPluginDoubleInstall(opts),
    checkDanglingHookPaths(opts),
    checkStalePluginCache(opts),
    checkRestartNeeded(opts),
    checkHookExecSmoke(opts),
  ];
}

export function formatResult(r: CheckResult): string {
  return `[${r.status}] ${r.name} — ${r.detail}`;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some(r => r.status === 'FAIL') ? 1 : 0;
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const opts: DoctorOpts = { projectRoot: process.cwd(), homeDir: homedir() };
  const results = runAllChecks(opts);
  if (json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } else {
    const lines: string[] = [];
    for (const r of results) {
      if (quiet && r.status === 'PASS') continue;
      lines.push(formatResult(r));
    }
    if (lines.length === 0) lines.push('[PASS] all checks passed.');
    process.stdout.write(lines.join('\n') + '\n');
    const failed = results.filter(r => r.status === 'FAIL');
    if (failed.length > 0) {
      process.stdout.write(
        `\n${failed.length} check(s) failed. See https://github.com/Garsson-io/kaizen/issues/1061 for background.\n`,
      );
    }
  }
  process.exit(exitCodeFor(results));
}
