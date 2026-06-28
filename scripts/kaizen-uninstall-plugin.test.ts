import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isPathUnder,
  runUninstall,
  stepRemoveCacheDir,
  stepRemoveEnabledPlugin,
  stepRemoveInstalledRecord,
} from './kaizen-uninstall-plugin.ts';

function setup(): { home: string; proj: string } {
  const home = mkdtempSync(join(tmpdir(), 'kai-un-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'kai-un-proj-'));
  mkdirSync(join(home, '.claude/plugins/cache/kaizen'), { recursive: true });
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({ plugins: { 'kaizen@kaizen': [{ installPath: '/fake' }] } }),
  );
  writeFileSync(
    join(proj, '.claude/settings.json'),
    JSON.stringify({ enabledPlugins: { 'kaizen@kaizen': true }, hooks: {} }),
  );
  return { home, proj };
}

function teardown(home: string, proj: string): void {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}

describe('isPathUnder (path-segment-aware scope check)', () => {
  it('true for direct child', () => {
    expect(isPathUnder('/a/b/c', '/a/b')).toBe(true);
  });
  it('true for equal paths', () => {
    expect(isPathUnder('/a/b', '/a/b')).toBe(true);
  });
  it('false for sibling path that shares a string prefix', () => {
    // Literal string prefix matching would return true here. Bug fix vs bash version.
    expect(isPathUnder('/a/b-evil', '/a/b')).toBe(false);
  });
  it('false for parent path', () => {
    expect(isPathUnder('/a', '/a/b')).toBe(false);
  });
});

describe('runUninstall — TS implementation', () => {
  let home: string, proj: string;
  beforeEach(() => { const s = setup(); home = s.home; proj = s.proj; });
  afterEach(() => teardown(home, proj));

  it('removes enabledPlugins entry', () => {
    runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    const settings = JSON.parse(readFileSync(join(proj, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toBeUndefined();
  });

  it('removes installed_plugins record', () => {
    runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    const data = JSON.parse(readFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'utf-8'));
    expect(data.plugins['kaizen@kaizen']).toBeUndefined();
  });

  it('removes cache dir', () => {
    runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    expect(existsSync(join(home, '.claude/plugins/cache/kaizen'))).toBe(false);
  });

  it('banner contains RESTART + issue link', () => {
    const r = runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    expect(r.banner).toContain('RESTART CLAUDE CODE NOW');
    expect(r.banner).toContain('issues/1061');
  });

  it('idempotent on second run — no throw', () => {
    runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    const r2 = runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    expect(r2.exitCode).toBe(0);
    expect(r2.steps.some(s => s.includes('already absent'))).toBe(true);
  });

  it('preserves other enabledPlugins entries', () => {
    writeFileSync(
      join(proj, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'kaizen@kaizen': true, 'other@x': true }, hooks: {} }),
    );
    runUninstall({ plugin: 'kaizen@kaizen', homeDir: home, projectRoot: proj, skipNpmInstall: true });
    const settings = JSON.parse(readFileSync(join(proj, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'other@x': true });
  });
});

describe('input validation — rejects path-traversal / injection attempts', () => {
  let home: string, proj: string;
  beforeEach(() => { const s = setup(); home = s.home; proj = s.proj; });
  afterEach(() => teardown(home, proj));

  const BAD_PLUGINS = [
    '../evil@x',
    'foo@bar/../../etc',
    "foo@bar'; rm -rf /",
    'foo@bar\nbaz',
    'no-at-sign',
    'a@b@c',
    '',
  ];
  for (const p of BAD_PLUGINS) {
    it(`rejects --plugin ${JSON.stringify(p)}`, () => {
      expect(() => runUninstall({ plugin: p, homeDir: home, projectRoot: proj, skipNpmInstall: true }))
        .toThrow(/invalid --plugin/);
    });
  }
});

describe('stepRemoveCacheDir — refuses paths outside sandbox (symlink attack)', () => {
  let home: string, proj: string, outside: string;
  beforeEach(() => {
    const s = setup(); home = s.home; proj = s.proj;
    outside = mkdtempSync(join(tmpdir(), 'kai-outside-'));
  });
  afterEach(() => { teardown(home, proj); rmSync(outside, { recursive: true, force: true }); });

  it('refuses to rm -rf when cache dir is a symlink pointing outside the sandbox', () => {
    // Replace the cache dir with a symlink aimed at `outside`.
    rmSync(join(home, '.claude/plugins/cache/kaizen'), { recursive: true, force: true });
    symlinkSync(outside, join(home, '.claude/plugins/cache/kaizen'));
    expect(() => stepRemoveCacheDir(home, 'kaizen@kaizen')).toThrow(/REFUSED/);
    // The symlink target must still exist — we refused, we did not delete it.
    expect(existsSync(outside)).toBe(true);
  });
});

describe('stepRemove* return values — idempotency surface for the test-quality gap', () => {
  let home: string, proj: string;
  beforeEach(() => { const s = setup(); home = s.home; proj = s.proj; });
  afterEach(() => teardown(home, proj));

  it('stepRemoveEnabledPlugin returns changed:false when file missing', () => {
    rmSync(join(proj, '.claude/settings.json'));
    expect(stepRemoveEnabledPlugin(proj, 'kaizen@kaizen').changed).toBe(false);
  });
  it('stepRemoveInstalledRecord returns changed:false when file malformed', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{{{ not json');
    expect(stepRemoveInstalledRecord(home, 'kaizen@kaizen').changed).toBe(false);
  });
  it('stepRemoveCacheDir returns changed:false when cache already absent', () => {
    rmSync(join(home, '.claude/plugins/cache/kaizen'), { recursive: true, force: true });
    expect(stepRemoveCacheDir(home, 'kaizen@kaizen').changed).toBe(false);
  });
});

describe('JSON object parsing', () => {
  it('delegates JSON object file reads to the shared file helper', () => {
    const source = readFileSync(new URL('./kaizen-uninstall-plugin.ts', import.meta.url), 'utf-8');

    expect(source).toContain('../src/lib/json-file.js');
    expect(source).not.toContain('function readJsonOrNull');
    expect(source).not.toContain('parseJsonObject(readFileSync');
    expect(source).not.toContain('JSON.parse(raw)');
  });
});

describe('CLI — end-to-end via execFileSync', () => {
  let home: string, proj: string;
  beforeEach(() => { const s = setup(); home = s.home; proj = s.proj; });
  afterEach(() => teardown(home, proj));

  const SCRIPT = resolve(__dirname, 'kaizen-uninstall-plugin.ts');

  it('exits 0 and prints banner', () => {
    const out = execFileSync('npx', ['tsx', SCRIPT, '--home', home, '--project', proj, '--skip-npm-install'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('RESTART CLAUDE CODE NOW');
  });
});
