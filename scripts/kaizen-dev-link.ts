#!/usr/bin/env npx tsx
/**
 * kaizen-dev-link — contributor-only local hook development override.
 *
 * Claude Code registers plugin hook command paths at session start. This tool
 * keeps the registered install path stable and swaps the cache version dir for
 * a symlink to a kaizen working tree, so hook body edits hot-reload without a
 * plugin publish/update/restart cycle.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { readJsonValueFile } from '../src/lib/json-file.js';
import { KAIZEN_PLUGIN_SOURCE } from '../src/kaizen-plugin-identity.js';

export type DevLinkCommand = 'status' | 'enable' | 'disable';

export interface DevLinkOpts {
  command: DevLinkCommand;
  homeDir: string;
  projectRoot: string;
  plugin?: string;
}

export interface PluginInstall {
  plugin: string;
  installPath: string;
  projectPath: string | null;
  version: string | null;
}

export interface DevLinkStatus {
  plugin: string;
  installPath: string | null;
  active: boolean;
  state: 'not-installed' | 'missing' | 'inactive' | 'active' | 'foreign-link';
  targetPath: string | null;
  backupPath: string | null;
  detail: string;
}

export interface DevLinkResult extends DevLinkStatus {
  status: 'enabled' | 'disabled' | 'unchanged' | 'status';
}

const DEFAULT_PLUGIN = KAIZEN_PLUGIN_SOURCE;
const PLUGIN_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/;

function validatePlugin(plugin: string): string {
  if (!PLUGIN_RE.test(plugin)) {
    throw new Error(`invalid plugin "${plugin}" (must match ${PLUGIN_RE.source})`);
  }
  return plugin;
}

function shortNameOf(plugin: string): string {
  return plugin.split('@')[0] ?? plugin;
}

function ownerOf(plugin: string): string {
  return plugin.split('@')[1] ?? '';
}

function normalizePath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function pathWithSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep;
}

export function isPathUnderOrEqual(child: string, parent: string): boolean {
  const c = pathWithSep(resolve(child));
  const p = pathWithSep(resolve(parent));
  return c === p || c.startsWith(p);
}

function cacheVersionsRoot(homeDir: string, plugin: string): string {
  return join(homeDir, '.claude/plugins/cache', ownerOf(plugin), shortNameOf(plugin));
}

function backupPathFor(installPath: string): string {
  return `${installPath}.kaizen-dev-link-backup`;
}

function readInstalledEntries(homeDir: string, plugin: string): Array<Record<string, unknown>> {
  const installedPath = join(homeDir, '.claude/plugins/installed_plugins.json');
  const data = readJsonValueFile(installedPath) as
    | { plugins?: Record<string, unknown> }
    | null;
  const entry = data?.plugins?.[plugin];
  if (Array.isArray(entry)) return entry.filter(e => e && typeof e === 'object') as Array<Record<string, unknown>>;
  if (entry && typeof entry === 'object') return [entry as Record<string, unknown>];
  return [];
}

function validateInstallPath(homeDir: string, plugin: string, installPath: string): string {
  const resolvedInstall = resolve(installPath);
  const versionsRoot = cacheVersionsRoot(homeDir, plugin);
  if (resolvedInstall === resolve(versionsRoot) || !isPathUnderOrEqual(resolvedInstall, versionsRoot)) {
    throw new Error(
      `installed_plugins installPath is outside the kaizen plugin cache: ${resolvedInstall} (expected under ${versionsRoot})`,
    );
  }
  return resolvedInstall;
}

export function resolvePluginInstall(opts: {
  homeDir: string;
  projectRoot: string;
  plugin?: string;
}): PluginInstall | null {
  const plugin = validatePlugin(opts.plugin ?? DEFAULT_PLUGIN);
  const normalizedProject = normalizePath(opts.projectRoot);
  const entries = readInstalledEntries(opts.homeDir, plugin);
  const matching = entries.find(entry => {
    const projectPath = entry.projectPath;
    return typeof projectPath === 'string' && normalizePath(projectPath) === normalizedProject;
  }) ?? (entries.length === 1 ? entries[0] : undefined);

  if (!matching) return null;
  const rawInstallPath = matching.installPath;
  if (typeof rawInstallPath !== 'string' || rawInstallPath.trim() === '') {
    throw new Error(`installed_plugins record for ${plugin} has no installPath`);
  }
  const rawProjectPath = matching.projectPath;
  const rawVersion = matching.version;
  return {
    plugin,
    installPath: validateInstallPath(opts.homeDir, plugin, rawInstallPath),
    projectPath: typeof rawProjectPath === 'string' ? rawProjectPath : null,
    version: typeof rawVersion === 'string' ? rawVersion : null,
  };
}

export function checkDevLinkStatus(opts: {
  homeDir: string;
  projectRoot: string;
  plugin?: string;
}): DevLinkStatus {
  const plugin = validatePlugin(opts.plugin ?? DEFAULT_PLUGIN);
  const install = resolvePluginInstall({ ...opts, plugin });
  if (!install) {
    return {
      plugin,
      installPath: null,
      active: false,
      state: 'not-installed',
      targetPath: null,
      backupPath: null,
      detail: `${plugin} is not installed for this project; no dev override active.`,
    };
  }

  const backupPath = backupPathFor(install.installPath);
  if (!existsSync(install.installPath)) {
    return {
      plugin,
      installPath: install.installPath,
      active: false,
      state: 'missing',
      targetPath: null,
      backupPath,
      detail: `install path missing (${install.installPath}); no dev override active.`,
    };
  }

  const stat = lstatSync(install.installPath);
  if (!stat.isSymbolicLink()) {
    return {
      plugin,
      installPath: install.installPath,
      active: false,
      state: 'inactive',
      targetPath: null,
      backupPath,
      detail: `dev override inactive; install path is a normal cache directory (${install.installPath}).`,
    };
  }

  const rawTarget = readlinkSync(install.installPath);
  const target = normalizePath(resolve(dirname(install.installPath), rawTarget));
  const project = normalizePath(opts.projectRoot);
  const active = target === project;
  return {
    plugin,
    installPath: install.installPath,
    active,
    state: active ? 'active' : 'foreign-link',
    targetPath: target,
    backupPath,
    detail: active
      ? `dev override active: ${install.installPath} -> ${target}`
      : `install path is a symlink to ${target}, not this project (${project}).`,
  };
}

function enable(opts: DevLinkOpts): DevLinkResult {
  const install = resolvePluginInstall(opts);
  if (!install) {
    throw new Error(`${opts.plugin ?? DEFAULT_PLUGIN} is not installed for this project`);
  }
  const current = checkDevLinkStatus(opts);
  if (current.active) return { ...current, status: 'unchanged' };
  if (current.state === 'foreign-link') {
    throw new Error(`refusing to replace foreign symlink at ${install.installPath}: ${current.targetPath}`);
  }
  if (current.state === 'missing') {
    throw new Error(`refusing to enable dev link because install path is missing: ${install.installPath}`);
  }
  const backupPath = backupPathFor(install.installPath);
  if (existsSync(backupPath)) {
    throw new Error(`backup already exists (${backupPath}); run disable or inspect before enabling`);
  }

  mkdirSync(dirname(install.installPath), { recursive: true });
  renameSync(install.installPath, backupPath);
  symlinkSync(normalizePath(opts.projectRoot), install.installPath, 'dir');
  return { ...checkDevLinkStatus(opts), status: 'enabled' };
}

function disable(opts: DevLinkOpts): DevLinkResult {
  const current = checkDevLinkStatus(opts);
  if (!current.installPath) return { ...current, status: 'unchanged' };
  if (!current.active && current.state !== 'foreign-link') return { ...current, status: 'unchanged' };
  if (current.state === 'foreign-link') {
    throw new Error(`refusing to remove foreign symlink at ${current.installPath}: ${current.targetPath}`);
  }

  rmSync(current.installPath, { force: true });
  if (current.backupPath && existsSync(current.backupPath)) {
    renameSync(current.backupPath, current.installPath);
  }
  return { ...checkDevLinkStatus(opts), status: 'disabled' };
}

export function runDevLink(opts: DevLinkOpts): DevLinkResult {
  const normalized: DevLinkOpts = {
    ...opts,
    plugin: validatePlugin(opts.plugin ?? DEFAULT_PLUGIN),
    homeDir: resolve(opts.homeDir),
    projectRoot: resolve(opts.projectRoot),
  };
  switch (normalized.command) {
    case 'status': return { ...checkDevLinkStatus(normalized), status: 'status' };
    case 'enable': return enable(normalized);
    case 'disable': return disable(normalized);
  }
}

function parseArgv(argv: string[]): DevLinkOpts {
  const first = argv[0];
  const command: DevLinkCommand =
    first === 'enable' || first === 'disable' || first === 'status'
      ? first
      : 'status';
  const rest = first === command ? argv.slice(1) : argv;
  let homeDir = homedir();
  let projectRoot = process.cwd();
  let plugin = DEFAULT_PLUGIN;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--home': homeDir = rest[++i] ?? ''; break;
      case '--project': projectRoot = rest[++i] ?? ''; break;
      case '--plugin': plugin = rest[++i] ?? ''; break;
      case '-h':
      case '--help':
        process.stdout.write([
          'kaizen-dev-link [status|enable|disable] [--home PATH] [--project PATH] [--plugin kaizen@kaizen]',
          '',
          'Contributor-only override: replace the active plugin install path with a symlink to this worktree.',
        ].join('\n') + '\n');
        process.exit(0);
      default:
        throw new Error(`unknown arg: ${arg}`);
    }
  }
  return { command, homeDir, projectRoot, plugin };
}

function format(result: DevLinkResult): string {
  const lines = [
    `kaizen-dev-link: ${result.state}`,
    `plugin: ${result.plugin}`,
    `installPath: ${result.installPath ?? '(none)'}`,
    `target: ${result.targetPath ?? '(none)'}`,
    `detail: ${result.detail}`,
  ];
  if (result.backupPath) lines.push(`backup: ${result.backupPath}`);
  return lines.join('\n') + '\n';
}

const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; }
})();

if (isMain) {
  try {
    const result = runDevLink(parseArgv(process.argv.slice(2)));
    process.stdout.write(format(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kaizen-dev-link: ${message}\n`);
    process.exit(2);
  }
}
