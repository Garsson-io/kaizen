import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPluginDoubleInstall,
  checkDanglingHookPaths,
  checkStalePluginCache,
  checkRestartNeeded,
  checkHookExecSmoke,
  runAllChecks,
  exitCodeFor,
  buildSnapshot,
  snapshotPath,
  resolveHookPath,
  restartSensitiveFiles,
  DoctorOpts,
} from './kaizen-doctor.ts';

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'kaizen-doctor-proj-'));
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kaizen-doctor-home-'));
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  return home;
}

function writeSettings(projectRoot: string, content: unknown): void {
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude/settings.json'), JSON.stringify(content, null, 2));
}

function writePluginJson(projectRoot: string, content: unknown): void {
  mkdirSync(join(projectRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude-plugin/plugin.json'), JSON.stringify(content, null, 2));
}

function writeHook(projectRoot: string, rel: string, executable = true): string {
  const p = join(projectRoot, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '#!/bin/bash\nexit 0\n');
  if (executable) chmodSync(p, 0o755);
  else chmodSync(p, 0o644);
  return p;
}

describe('resolveHookPath', () => {
  it('expands ${CLAUDE_PLUGIN_ROOT} against projectRoot', () => {
    const resolved = resolveHookPath('${CLAUDE_PLUGIN_ROOT}/.claude/hooks/foo.sh', '/my/proj');
    expect(resolved).toBe('/my/proj/.claude/hooks/foo.sh');
  });
  it('resolves relative paths against projectRoot', () => {
    expect(resolveHookPath('./.claude/hooks/foo.sh', '/my/proj')).toBe('/my/proj/.claude/hooks/foo.sh');
  });
  it('leaves absolute paths as-is', () => {
    expect(resolveHookPath('/abs/hook.sh', '/my/proj')).toBe('/abs/hook.sh');
  });
  it('strips arguments — takes first whitespace token', () => {
    expect(resolveHookPath('/wrap.sh TAG ./real.sh', '/my/proj')).toBe('/wrap.sh');
  });
});

describe('checkPluginDoubleInstall', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('FAIL when enabledPlugins set AND own hooks present', () => {
    writeSettings(proj, {
      enabledPlugins: { 'kaizen@kaizen': true },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/foo.sh' }] }] },
    });
    const r = checkPluginDoubleInstall({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('duplicate registration');
  });

  it('WARN when enabledPlugins set but no own hooks', () => {
    writeSettings(proj, { enabledPlugins: { 'kaizen@kaizen': true } });
    const r = checkPluginDoubleInstall({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('WARN');
  });

  it('PASS when enabledPlugins absent', () => {
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/foo.sh' }] }] } });
    const r = checkPluginDoubleInstall({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });

  it('PASS when settings.json missing', () => {
    const r = checkPluginDoubleInstall({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });
});

describe('checkDanglingHookPaths', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('PASS when every hook resolves', () => {
    writeHook(proj, '.claude/hooks/foo.sh');
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/foo.sh' }] }] } });
    const r = checkDanglingHookPaths({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });

  it('FAIL when a hook is missing', () => {
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/missing.sh' }] }] } });
    const r = checkDanglingHookPaths({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('missing.sh');
  });

  it('expands ${CLAUDE_PLUGIN_ROOT} in plugin.json', () => {
    writeHook(proj, '.claude/hooks/bar.sh');
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/.claude/hooks/bar.sh' }] }] } });
    const r = checkDanglingHookPaths({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });

  it('WARN when no hooks registered', () => {
    const r = checkDanglingHookPaths({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('WARN');
  });
});

describe('checkStalePluginCache', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('FAIL when record present but cache missing', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'kaizen@kaizen': [{ installPath: '/nope' }] } }));
    const r = checkStalePluginCache({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('cache dir missing');
  });

  it('WARN when cache present but no record', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: {} }));
    mkdirSync(join(home, '.claude/plugins/cache/kaizen'), { recursive: true });
    const r = checkStalePluginCache({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('WARN');
  });

  it('PASS when both consistent (not installed, no cache)', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: {} }));
    const r = checkStalePluginCache({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });
});

describe('checkRestartNeeded + buildSnapshot', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('WARN when no snapshot exists', () => {
    const r = checkRestartNeeded({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('no session-start snapshot');
  });

  it('PASS when snapshot matches current state', () => {
    writeSettings(proj, { hooks: {} });
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const snap = buildSnapshot(opts);
    mkdirSync(join(home, '.claude/kaizen-snapshots'), { recursive: true });
    writeFileSync(snapshotPath(opts), JSON.stringify(snap));
    const r = checkRestartNeeded(opts);
    expect(r.status).toBe('PASS');
  });

  it('FAIL when plugin.json has drifted since snapshot', () => {
    writePluginJson(proj, { hooks: {} });
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const snap = buildSnapshot(opts);
    mkdirSync(join(home, '.claude/kaizen-snapshots'), { recursive: true });
    writeFileSync(snapshotPath(opts), JSON.stringify(snap));
    writePluginJson(proj, { hooks: { PreToolUse: [] } }); // drift
    const r = checkRestartNeeded(opts);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('restart REQUIRED');
    expect(r.detail).toContain('project-plugin-manifest');
  });

  it('PASS when only settings.json changes (hot-reloads, not restart-sensitive)', () => {
    writeSettings(proj, { hooks: {} });
    writePluginJson(proj, { hooks: {} });
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const snap = buildSnapshot(opts);
    mkdirSync(join(home, '.claude/kaizen-snapshots'), { recursive: true });
    writeFileSync(snapshotPath(opts), JSON.stringify(snap));
    writeSettings(proj, { hooks: { PreToolUse: [] } }); // drift, but settings.json hot-reloads
    const r = checkRestartNeeded(opts);
    expect(r.status).toBe('PASS');
  });

  it('buildSnapshot hashes all restart-sensitive files', () => {
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const labels = restartSensitiveFiles(opts).map(f => f.label);
    const snap = buildSnapshot(opts);
    for (const l of labels) expect(snap.hashes).toHaveProperty(l);
  });
});

describe('checkHookExecSmoke', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('FAIL when a hook file is not executable', () => {
    writeHook(proj, '.claude/hooks/foo.sh', false);
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/foo.sh' }] }] } });
    const r = checkHookExecSmoke({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
  });

  it('PASS when all hook files are executable', () => {
    writeHook(proj, '.claude/hooks/foo.sh', true);
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/foo.sh' }] }] } });
    const r = checkHookExecSmoke({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
  });
});

describe('runAllChecks + exitCodeFor', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('returns 5 checks in defined order', () => {
    const results = runAllChecks({ projectRoot: proj, homeDir: home });
    expect(results.map(r => r.name)).toEqual([
      'plugin-double-install',
      'dangling-hook-paths',
      'stale-plugin-cache',
      'restart-needed',
      'hook-exec-smoke',
    ]);
  });

  it('exitCodeFor returns 1 when any FAIL', () => {
    expect(exitCodeFor([{ name: 'x', status: 'PASS', detail: '' }, { name: 'y', status: 'FAIL', detail: '' }])).toBe(1);
  });

  it('exitCodeFor returns 0 when no FAIL', () => {
    expect(exitCodeFor([{ name: 'x', status: 'PASS', detail: '' }, { name: 'y', status: 'WARN', detail: '' }])).toBe(0);
  });
});
