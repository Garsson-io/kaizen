#!/usr/bin/env npx tsx
/**
 * kaizen-uninstall-plugin — idempotent uninstall of a Claude Code plugin.
 *
 * Usage:
 *   npx tsx scripts/kaizen-uninstall-plugin.ts                    # uninstalls kaizen@kaizen
 *   npx tsx scripts/kaizen-uninstall-plugin.ts --plugin foo@bar
 *   npx tsx scripts/kaizen-uninstall-plugin.ts --home /tmp/fake   # for tests
 *
 * TS replacement for the earlier bash version. Motivation: the bash
 * version interpolated shell variables into `node -e '...'` bodies
 * (JS-injection) and used literal string-prefix matching for the
 * cache-dir scope check (path-traversal via --plugin '../../x@y').
 * Both fail shapes are eliminated here: arguments are validated with
 * a strict identifier regex and cache paths are realpath-normalized
 * before the prefix check.
 *
 * After uninstall, prints a loud "RESTART CLAUDE CODE NOW" banner.
 * Mid-session plugin state changes do NOT take effect until restart (#1061).
 */

import {
  existsSync,
  rmSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readJsonObjectFile, writeJsonObjectFile } from '../src/lib/json-file.js';

export interface UninstallOpts {
  plugin: string;
  homeDir: string;
  projectRoot: string;
  /** Skip npm install even if node_modules missing (tests). */
  skipNpmInstall?: boolean;
}

export interface UninstallResult {
  steps: string[];
  banner: string;
  exitCode: number;
}

/** Plugin names must match this shape — rejects path-traversal inputs. */
const PLUGIN_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/;

function validatePlugin(plugin: string): string {
  if (!PLUGIN_RE.test(plugin)) {
    throw new Error(
      `invalid --plugin "${plugin}" (must match ${PLUGIN_RE.source})`,
    );
  }
  return plugin;
}

function shortNameOf(plugin: string): string {
  const idx = plugin.indexOf('@');
  return idx < 0 ? plugin : plugin.slice(0, idx);
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** True if `child` resides under `parent` by path-segment comparison.
 *  Both arguments must be realpath-normalized first. */
export function isPathUnder(child: string, parent: string): boolean {
  const c = child.endsWith(sep) ? child : child + sep;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return c === p || c.startsWith(p);
}

export function stepRemoveEnabledPlugin(
  projectRoot: string,
  plugin: string,
): { changed: boolean; detail: string } {
  const path = join(projectRoot, '.claude', 'settings.json');
  if (!existsSync(path)) return { changed: false, detail: `no ${path}` };
  const data = readJsonObjectFile(path);
  if (!data) return { changed: false, detail: `unreadable ${path}` };
  const enabled = (data.enabledPlugins ?? {}) as Record<string, unknown>;
  if (!(plugin in enabled)) return { changed: false, detail: `enabledPlugins[${plugin}] already absent` };
  delete enabled[plugin];
  if (Object.keys(enabled).length === 0) delete (data as Record<string, unknown>).enabledPlugins;
  else (data as Record<string, unknown>).enabledPlugins = enabled;
  writeJsonObjectFile(path, data, { trailingNewline: false });
  return { changed: true, detail: `removed enabledPlugins[${plugin}]` };
}

export function stepRemoveInstalledRecord(
  homeDir: string,
  plugin: string,
): { changed: boolean; detail: string } {
  const path = join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(path)) return { changed: false, detail: `no ${path}` };
  const data = readJsonObjectFile(path);
  if (!data) return { changed: false, detail: `unreadable ${path}` };
  const plugins = (data.plugins ?? {}) as Record<string, unknown>;
  if (!(plugin in plugins)) return { changed: false, detail: `record for ${plugin} already absent` };
  delete plugins[plugin];
  (data as Record<string, unknown>).plugins = plugins;
  writeJsonObjectFile(path, data, { trailingNewline: false });
  return { changed: true, detail: `removed installed_plugins record for ${plugin}` };
}

export function stepRemoveCacheDir(
  homeDir: string,
  plugin: string,
): { changed: boolean; detail: string } {
  const shortName = shortNameOf(plugin);
  const cacheParent = join(homeDir, '.claude', 'plugins', 'cache');
  const cacheDir = join(cacheParent, shortName);
  if (!existsSync(cacheDir)) return { changed: false, detail: `cache dir already absent (${cacheDir})` };
  const realCache = safeRealpath(cacheDir);
  const realParent = existsSync(cacheParent) ? safeRealpath(cacheParent) : resolve(cacheParent);
  if (!isPathUnder(realCache, realParent)) {
    throw new Error(
      `REFUSED: resolved cache path ${realCache} is outside ${realParent}`,
    );
  }
  rmSync(cacheDir, { recursive: true, force: true });
  return { changed: true, detail: `removed cache dir ${cacheDir}` };
}

export function stepNpmInstallIfNeeded(
  projectRoot: string,
  opts: { skipNpmInstall?: boolean } = {},
): { changed: boolean; detail: string } {
  if (opts.skipNpmInstall) return { changed: false, detail: 'npm install skipped' };
  const pkg = join(projectRoot, 'package.json');
  const nm = join(projectRoot, 'node_modules');
  if (!existsSync(pkg)) return { changed: false, detail: 'no package.json' };
  try {
    if (existsSync(nm) && statSync(nm).isDirectory()) return { changed: false, detail: 'node_modules present' };
  } catch {}
  const r = spawnSync('npm', ['install', '--silent'], { cwd: projectRoot, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status})`);
  return { changed: true, detail: 'npm install complete' };
}

const BANNER = `
╔══════════════════════════════════════════════════════════════════════════════╗
║  RESTART CLAUDE CODE NOW                                                     ║
║                                                                              ║
║  Plugin hook registry is loaded at session start and is now stale.           ║
║  Mid-session plugin changes do NOT take effect until Claude Code restarts.   ║
║  Uninstall is INCOMPLETE until you restart.                                  ║
║                                                                              ║
║  See: https://github.com/Garsson-io/kaizen/issues/1061                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
`;

export function runUninstall(opts: UninstallOpts): UninstallResult {
  const plugin = validatePlugin(opts.plugin);
  const steps: string[] = [];
  steps.push(`enabledPlugins: ${stepRemoveEnabledPlugin(opts.projectRoot, plugin).detail}`);
  steps.push(`installed_plugins: ${stepRemoveInstalledRecord(opts.homeDir, plugin).detail}`);
  steps.push(`cache: ${stepRemoveCacheDir(opts.homeDir, plugin).detail}`);
  steps.push(`npm: ${stepNpmInstallIfNeeded(opts.projectRoot, { skipNpmInstall: opts.skipNpmInstall }).detail}`);
  return { steps, banner: BANNER, exitCode: 0 };
}

function parseArgv(argv: string[]): UninstallOpts {
  let plugin = 'kaizen@kaizen';
  let homeDir = homedir();
  let projectRoot = process.cwd();
  let skipNpmInstall = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--plugin': plugin = argv[++i] ?? ''; break;
      case '--home': homeDir = argv[++i] ?? ''; break;
      case '--project': projectRoot = argv[++i] ?? ''; break;
      case '--skip-npm-install': skipNpmInstall = true; break;
      case '-h': case '--help':
        process.stdout.write('kaizen-uninstall-plugin [--plugin kaizen@kaizen] [--home PATH] [--project PATH] [--skip-npm-install]\n');
        process.exit(0); break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  return { plugin, homeDir, projectRoot, skipNpmInstall };
}

const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; }
})();

if (isMain) {
  try {
    const opts = parseArgv(process.argv.slice(2));
    const result = runUninstall(opts);
    for (const s of result.steps) process.stdout.write(`  ${s}\n`);
    process.stdout.write(result.banner);
    process.exit(result.exitCode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`kaizen-uninstall-plugin: ${msg}\n`);
    process.exit(2);
  }
}
