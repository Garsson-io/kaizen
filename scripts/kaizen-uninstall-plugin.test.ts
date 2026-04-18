import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = resolve(__dirname, 'kaizen-uninstall-plugin.sh');

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

function run(home: string, proj: string): string {
  return execFileSync('bash', [SCRIPT, '--home', home, '--project', proj], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('kaizen-uninstall-plugin.sh', () => {
  let home: string, proj: string;
  beforeEach(() => { const s = setup(); home = s.home; proj = s.proj; });
  afterEach(() => teardown(home, proj));

  it('removes enabledPlugins entry from project settings.json', () => {
    run(home, proj);
    const settings = JSON.parse(readFileSync(join(proj, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toBeUndefined();
  });

  it('removes installed_plugins.json record', () => {
    run(home, proj);
    const installed = JSON.parse(readFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'utf-8'));
    expect(installed.plugins['kaizen@kaizen']).toBeUndefined();
  });

  it('removes cache dir', () => {
    run(home, proj);
    expect(existsSync(join(home, '.claude/plugins/cache/kaizen'))).toBe(false);
  });

  it('prints RESTART banner', () => {
    const out = run(home, proj);
    expect(out).toContain('RESTART CLAUDE CODE NOW');
    expect(out).toContain('issues/1061');
  });

  it('idempotent on second run — exit 0, no error', () => {
    run(home, proj);
    // second run should succeed
    const out = run(home, proj);
    expect(out).toContain('already absent');
    expect(out).toContain('RESTART CLAUDE CODE NOW');
  });

  it('preserves other enabledPlugins entries', () => {
    writeFileSync(
      join(proj, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'kaizen@kaizen': true, 'other@x': true }, hooks: {} }),
    );
    run(home, proj);
    const settings = JSON.parse(readFileSync(join(proj, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'other@x': true });
  });
});
