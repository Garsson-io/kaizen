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
  writeFileSync,
  mkdirSync,
  realpathSync,
  constants as fsConstants,
  accessSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { readJsonValueFile } from '../src/lib/json-file.js';
import { KAIZEN_PLUGIN_SOURCE } from '../src/kaizen-plugin-identity.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  data?: unknown;
}

export interface DoctorOpts {
  projectRoot: string;
  homeDir: string;
  pluginName?: string;
  codexReadiness?: CodexReadinessOpts;
}

export type CommandRunner = (cmd: string, args: readonly string[]) => string;

export interface CodexReadiness {
  available: boolean;
  version: string | null;
  supported_version: boolean;
  min_version: string;
  auth_mode: string | null;
  subscription_compatible: boolean;
  api_token_only: boolean;
  accepted_path_available: boolean;
  feature_probe: 'available' | 'unavailable';
  doctor_probe: 'available' | 'unavailable';
  required_features: Record<string, boolean | null>;
  unsupported_reasons: string[];
  experimental_capabilities: string[];
}

export interface CodexReadinessOpts {
  run?: CommandRunner;
  minVersion?: string;
}

const DEFAULT_PLUGIN = KAIZEN_PLUGIN_SOURCE;
const MIN_CODEX_VERSION = '0.142.3';
const REQUIRED_CODEX_FEATURES = ['shell_tool', 'unified_exec', 'hooks'] as const;

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

interface ReferencedHook {
  label: string;
  command: string;
  path: string;
}

function collectReferencedHooks(opts: DoctorOpts): ReferencedHook[] {
  const cfgs: Array<{ path: string; label: string }> = [
    { path: join(opts.projectRoot, '.claude/settings.json'), label: 'settings.json' },
    { path: join(opts.projectRoot, '.claude-plugin/plugin.json'), label: 'plugin.json' },
  ];
  const hooks: ReferencedHook[] = [];
  for (const cfg of cfgs) {
    const data = readJsonValueFile(cfg.path);
    if (!data) continue;
    for (const command of collectHookCommands(data)) {
      hooks.push({
        label: cfg.label,
        command,
        path: resolveHookPath(command, opts.projectRoot),
      });
    }
  }
  return hooks;
}

/** Extract the executable path from a hook `command` string.
 *  Handles:
 *    - shell-style quotes: `"path with spaces/foo.sh" arg`  → `path with spaces/foo.sh`
 *    - env-variable prefixes: `FOO=1 BAR=2 ./hook.sh`        → `./hook.sh`
 *    - `${CLAUDE_PLUGIN_ROOT}` expansion against projectRoot
 *    - relative paths resolved against projectRoot */
export function resolveHookPath(command: string, projectRoot: string): string {
  const tokens = tokenize(command);
  // Skip leading `FOO=bar` env-variable prefixes (POSIX shell convention).
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  const first = tokens[i] ?? '';
  const expanded = first.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, projectRoot);
  if (isAbsolute(expanded)) return expanded;
  return resolve(projectRoot, expanded);
}

/** POSIX-ish shell tokenizer: respects single and double quotes and simple
 *  backslash escapes. Does not attempt full shell semantics — enough for
 *  the hook `command` strings kaizen/plugins actually emit. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let pending = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; pending = true; }
      else if (quote === '"' && ch === '\\' && i + 1 < input.length) { cur += input[++i]; }
      else { cur += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; pending = true; continue; }
    if (ch === '\\' && i + 1 < input.length) { cur += input[++i]; pending = true; continue; }
    if (ch && /\s/.test(ch)) {
      if (pending) { out.push(cur); cur = ''; pending = false; }
      continue;
    }
    cur += ch;
    pending = true;
  }
  if (pending) out.push(cur);
  return out;
}

/** Check 1: project-scope double install. */
export function checkPluginDoubleInstall(opts: DoctorOpts): CheckResult {
  const plugin = opts.pluginName ?? DEFAULT_PLUGIN;
  const settings = readJsonValueFile(join(opts.projectRoot, '.claude/settings.json')) as
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
      detail: `"${plugin}" is in enabledPlugins AND settings.json registers the same hooks directly — duplicate registration will flood every tool call with errors. Delete the hooks block from .claude/settings.json (see #1063).`,
    };
  }
  // enabledPlugins set with no duplicate hooks is the #1063 target state for
  // kaizen-on-kaizen and host projects alike — plugin loads hooks, settings.json
  // owns activation and non-hook config only.
  return {
    name: 'plugin-double-install',
    status: 'PASS',
    detail: isEnabled
      ? `"${plugin}" activated via enabledPlugins; no duplicate hooks in settings.json.`
      : `"${plugin}" not in enabledPlugins.`,
  };
}

/** Check 2: every referenced hook command resolves to an existing file. */
export function checkDanglingHookPaths(opts: DoctorOpts): CheckResult {
  const missing: string[] = [];
  const hooks = collectReferencedHooks(opts);
  for (const hook of hooks) {
    if (!existsSync(hook.path)) {
      missing.push(`${hook.label}: ${hook.path}`);
    }
  }
  if (hooks.length === 0) {
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
      detail: `${missing.length}/${hooks.length} hook paths missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}`,
    };
  }
  return {
    name: 'dangling-hook-paths',
    status: 'PASS',
    detail: `all ${hooks.length} hook paths resolve.`,
  };
}

/** Check 3: cache-dir vs installed_plugins.json consistency.
 *  Scoped to THIS project's path — matches the detection jq query in #1061. */
export function checkStalePluginCache(opts: DoctorOpts): CheckResult {
  const plugin = opts.pluginName ?? DEFAULT_PLUGIN;
  const shortName = plugin.split('@')[0] ?? plugin;
  const installedPath = join(opts.homeDir, '.claude/plugins/installed_plugins.json');
  const cacheDir = join(opts.homeDir, `.claude/plugins/cache/${shortName}`);
  const normalizedRoot = normalizeProjectRoot(opts.projectRoot);

  const installed = readJsonValueFile(installedPath) as
    | { plugins?: Record<string, Array<Record<string, unknown>> | Record<string, unknown>> }
    | null;
  const entry = installed?.plugins?.[plugin];
  // Match only entries scoped to THIS project (projectPath == normalizedRoot).
  // If the entry is an array (current Claude Code format), filter it.
  // If it's a plain object (older format), treat as matching.
  let hasRecord = false;
  if (Array.isArray(entry)) {
    hasRecord = entry.some(e => {
      const p = (e as { projectPath?: string }).projectPath;
      return typeof p === 'string' && normalizeProjectRoot(p) === normalizedRoot;
    });
  } else if (entry && typeof entry === 'object') {
    hasRecord = true;
  }
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

/** Normalize a project root for snapshot-keying. Uses realpath when possible
 *  so symlinks, trailing slashes, and subdirectory-CWD cases all collapse
 *  to the same key. Falls back to path.resolve for non-existent paths
 *  (unit tests against tmp dirs that may be removed). */
export function normalizeProjectRoot(projectRoot: string): string {
  try { return realpathSync(projectRoot); } catch { return resolve(projectRoot); }
}

/** Path to the session-start snapshot for this project. */
export function snapshotPath(opts: DoctorOpts): string {
  const hash = createHash('sha256')
    .update(normalizeProjectRoot(opts.projectRoot))
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
 *  would false-positive on every inline hook edit.
 *
 *  Intentionally excludes `known_marketplaces.json` (#1065): Claude Code
 *  rewrites it on its own cadence to refresh marketplace metadata (observed
 *  mid-session, with no user action). Marketplace state does not affect
 *  hook-registry loading — `installed_plugins.json` is the load signal.
 *  Including it produced loud false-FAILs that trained users to ignore the
 *  check — the exact failure mode restart-needed was added to prevent (#1061). */
export function restartSensitiveFiles(opts: DoctorOpts): Array<{ label: string; path: string }> {
  return [
    { label: 'project-plugin-manifest', path: join(opts.projectRoot, '.claude-plugin/plugin.json') },
    { label: 'installed-plugins', path: join(opts.homeDir, '.claude/plugins/installed_plugins.json') },
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
  const snap = readJsonValueFile(snapPath) as SessionSnapshot | null;
  if (!snap || typeof snap !== 'object' || !snap.hashes) {
    return {
      name: 'restart-needed',
      status: 'WARN',
      detail: `snapshot unreadable at ${snapPath} — delete it to re-snapshot next session.`,
    };
  }
  const current = buildSnapshot(opts);
  const drifted: string[] = [];
  // Iterate over the CURRENT label set, not the snapshot's. Labels that
  // existed in older snapshots but have since been removed (e.g. the
  // `known-marketplaces` label retired in #1065) would otherwise drift
  // forever against stale on-disk snapshot files.
  for (const [label, now] of Object.entries(current.hashes)) {
    const prev = snap.hashes[label];
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

/** Check: exactly one source registers hooks. Enforces #1063's
 *  single-source-of-truth invariant — when settings.json AND plugin.json
 *  both have `hooks` entries for the same project, every hook fires twice
 *  and any mid-session plugin-state change silently breaks one source.
 *
 *  FAIL when both sources are non-empty.
 *  PASS when ≤1 source is non-empty (or neither — host project with no hooks).
 */
export function checkSingleRegistrationPath(opts: DoctorOpts): CheckResult {
  const settings = readJsonValueFile(join(opts.projectRoot, '.claude/settings.json'));
  const plugin = readJsonValueFile(join(opts.projectRoot, '.claude-plugin/plugin.json'));
  const settingsHooks = collectHookCommands(
    (settings as { hooks?: unknown } | null)?.hooks,
  );
  const pluginHooks = collectHookCommands(
    (plugin as { hooks?: unknown } | null)?.hooks,
  );
  if (settingsHooks.length > 0 && pluginHooks.length > 0) {
    return {
      name: 'single-registration-path',
      status: 'FAIL',
      detail: `both sources register hooks — settings.json: ${settingsHooks.length}, plugin.json: ${pluginHooks.length}. Delete the hooks block from one. See https://github.com/Garsson-io/kaizen/issues/1063`,
    };
  }
  return {
    name: 'single-registration-path',
    status: 'PASS',
    detail:
      pluginHooks.length > 0
        ? `single source: plugin.json (${pluginHooks.length} entries)`
        : settingsHooks.length > 0
          ? `single source: settings.json (${settingsHooks.length} entries)`
          : 'no hook registrations (host project without kaizen active)',
  };
}

/** Check 5: every referenced hook file is executable. */
export function checkHookExecSmoke(opts: DoctorOpts): CheckResult {
  const nonExec: string[] = [];
  let total = 0;
  for (const hook of collectReferencedHooks(opts)) {
    if (!existsSync(hook.path)) continue;
    total++;
    try {
      accessSync(hook.path, fsConstants.X_OK);
    } catch {
      nonExec.push(hook.path);
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

function bounded(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 12) + '...<truncated>';
}

function hasConflictMarkers(body: string): boolean {
  return /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m.test(body);
}

/** Check 6: referenced hook files must be parseable shell scripts.
 *
 * CI already runs validate-hook-integrity.sh before merge. This doctor check
 * covers the runtime/install-state version of #371: a local or cached hook can
 * be present and executable while containing merge markers or broken syntax.
 */
export function checkHookSyntaxSmoke(opts: DoctorOpts): CheckResult {
  const bad: string[] = [];
  let total = 0;
  for (const hook of collectReferencedHooks(opts)) {
    if (!existsSync(hook.path)) continue;
    total++;

    let body = '';
    try {
      body = readFileSync(hook.path, 'utf8');
    } catch (err) {
      bad.push(`${hook.path}: unreadable (${bounded(String(err))})`);
      continue;
    }

    if (hasConflictMarkers(body)) {
      bad.push(`${hook.path}: conflict markers present`);
      continue;
    }

    try {
      execFileSync('bash', ['-n', hook.path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      bad.push(`${hook.path}: syntax error${e.stderr ? ` (${bounded(e.stderr)})` : e.message ? ` (${bounded(e.message)})` : ''}`);
    }
  }

  if (total === 0) {
    return {
      name: 'hook-syntax-smoke',
      status: 'PASS',
      detail: 'no resolvable hook paths to check.',
    };
  }
  if (bad.length > 0) {
    return {
      name: 'hook-syntax-smoke',
      status: 'FAIL',
      detail: `${bad.length}/${total} hook files failed syntax checks: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`,
    };
  }
  return {
    name: 'hook-syntax-smoke',
    status: 'PASS',
    detail: `all ${total} hook files pass syntax checks.`,
  };
}

function defaultRun(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

function compareVersion(a: string, b: string): number {
  const aa = a.split('.').map((x) => Number.parseInt(x, 10));
  const bb = b.split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? x as Record<string, unknown> : {};
}

function detailValue(details: Record<string, unknown>, key: string): string | null {
  const v = details[key];
  return typeof v === 'string' ? v : null;
}

function parseFeatureList(output: string): Record<string, { stage: string; enabled: boolean }> {
  const features: Record<string, { stage: string; enabled: boolean }> = {};
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Name\s+/i.test(line) || /^-+\s+/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const enabledRaw = parts[parts.length - 1];
    if (enabledRaw !== 'true' && enabledRaw !== 'false') continue;
    const name = parts[0];
    const stage = parts.slice(1, -1).join(' ');
    features[name] = { stage, enabled: enabledRaw === 'true' };
  }
  return features;
}

/**
 * #1151 — Codex readiness for subscription-compatible auto-dent paths.
 * Best-effort by design: absence or unsupported shape is WARN, not FAIL, so
 * non-Codex users can still use kaizen-doctor without breaking setup.
 */
export function checkCodexReadiness(opts: CodexReadinessOpts = {}): CheckResult {
  const run = opts.run ?? defaultRun;
  const minVersion = opts.minVersion ?? MIN_CODEX_VERSION;
  const base: CodexReadiness = {
    available: false,
    version: null,
    supported_version: false,
    min_version: minVersion,
    auth_mode: null,
    subscription_compatible: false,
    api_token_only: false,
    accepted_path_available: false,
    feature_probe: 'unavailable',
    doctor_probe: 'unavailable',
    required_features: Object.fromEntries(REQUIRED_CODEX_FEATURES.map((f) => [f, null])),
    unsupported_reasons: [],
    experimental_capabilities: [],
  };

  let versionOutput = '';
  try {
    versionOutput = run('codex', ['--version']);
  } catch {
    return {
      name: 'codex-readiness',
      status: 'WARN',
      detail: 'Codex CLI not found; Codex auto-dent path is unavailable.',
      data: {
        ...base,
        unsupported_reasons: ['codex CLI missing'],
      },
    };
  }

  const version = parseVersion(versionOutput);
  const readiness: CodexReadiness = {
    ...base,
    available: true,
    version,
    supported_version: version != null && compareVersion(version, minVersion) >= 0,
  };

  if (!readiness.supported_version) {
    readiness.unsupported_reasons.push(
      version ? `codex ${version} is older than supported minimum ${minVersion}` : 'could not parse codex version',
    );
  }

  try {
    const doctor = asRecord(JSON.parse(run('codex', ['doctor', '--json'])));
    readiness.doctor_probe = 'available';
    const checks = asRecord(doctor.checks);
    const auth = asRecord(checks['auth.credentials']);
    const authDetails = asRecord(auth.details);
    const authMode = detailValue(authDetails, 'stored auth mode');
    const storedApiKey = detailValue(authDetails, 'stored API key') === 'true';
    const storedChatgpt = detailValue(authDetails, 'stored ChatGPT tokens') === 'true';
    readiness.auth_mode = authMode;
    readiness.api_token_only = storedApiKey && !storedChatgpt;
    readiness.subscription_compatible = storedChatgpt && !readiness.api_token_only;
    if (!readiness.subscription_compatible) {
      readiness.unsupported_reasons.push(
        readiness.api_token_only
          ? 'Codex auth is API-token-only; accepted auto-dent path requires subscription CLI auth'
          : 'Codex subscription auth was not detected',
      );
    }
  } catch {
    readiness.unsupported_reasons.push('codex doctor --json unavailable; auth mode could not be verified');
  }

  try {
    const features = parseFeatureList(run('codex', ['features', 'list']));
    readiness.feature_probe = 'available';
    for (const f of REQUIRED_CODEX_FEATURES) {
      readiness.required_features[f] = features[f]?.enabled ?? null;
      if (features[f]?.enabled !== true) {
        const stage = features[f]?.stage ?? 'unknown';
        readiness.experimental_capabilities.push(`${f}: ${stage}`);
        readiness.unsupported_reasons.push(`required Codex feature ${f} is not enabled (${stage})`);
      }
    }
  } catch {
    // Feature probing is useful color, but Codex 0.142.3 has `codex doctor --json`
    // as the stronger readiness source; don't reject a run solely for this.
    readiness.feature_probe = 'unavailable';
  }

  readiness.accepted_path_available =
    readiness.available &&
    readiness.supported_version &&
    readiness.subscription_compatible &&
    readiness.unsupported_reasons.length === 0;

  const status: CheckStatus = readiness.accepted_path_available ? 'PASS' : 'WARN';
  const detail = readiness.accepted_path_available
    ? `Codex ${readiness.version} ready for subscription-compatible auto-dent path (auth=${readiness.auth_mode ?? 'unknown'}).`
    : `Codex present but not ready for accepted auto-dent path: ${readiness.unsupported_reasons.join('; ') || 'unknown reason'}.`;

  return {
    name: 'codex-readiness',
    status,
    detail,
    data: readiness,
  };
}

export function runAllChecks(opts: DoctorOpts): CheckResult[] {
  return [
    checkSingleRegistrationPath(opts),
    checkPluginDoubleInstall(opts),
    checkDanglingHookPaths(opts),
    checkStalePluginCache(opts),
    checkRestartNeeded(opts),
    checkHookExecSmoke(opts),
    checkHookSyntaxSmoke(opts),
    checkCodexReadiness(opts.codexReadiness),
  ];
}

export function formatResult(r: CheckResult): string {
  return `[${r.status}] ${r.name} — ${r.detail}`;
}

export function exitCodeFor(results: CheckResult[]): number {
  return results.some(r => r.status === 'FAIL') ? 1 : 0;
}

/** Write the session-start snapshot. Invoked from the SessionStart hook. */
export function writeSessionSnapshot(opts: DoctorOpts): string {
  const path = snapshotPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const snap = buildSnapshot(opts);
  writeFileSync(path, JSON.stringify(snap, null, 2));
  return path;
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
  const opts: DoctorOpts = { projectRoot: process.cwd(), homeDir: homedir() };

  // `snapshot` subcommand — for the SessionStart hook. Writes snapshot, exits 0.
  if (argv[0] === 'snapshot') {
    try { writeSessionSnapshot(opts); } catch {}
    process.exit(0);
  }

  // Narrow SessionStart/doctor path for #371. Avoids noisy unrelated WARNs
  // (for example Codex readiness) while still surfacing corrupt hook files.
  if (argv[0] === 'hook-syntax') {
    const result = checkHookSyntaxSmoke(opts);
    if (!(argv.includes('--quiet') && result.status === 'PASS')) {
      process.stdout.write(formatResult(result) + '\n');
    }
    process.exit(result.status === 'FAIL' ? 1 : 0);
  }

  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
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
