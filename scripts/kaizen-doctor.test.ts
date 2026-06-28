import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPluginDoubleInstall,
  checkDanglingHookPaths,
  checkStalePluginCache,
  checkRestartNeeded,
  checkHookExecSmoke,
  checkHookSyntaxSmoke,
  checkSingleRegistrationPath,
  checkCodexReadiness,
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

function writeHook(projectRoot: string, rel: string, executable = true, content = '#!/bin/bash\nexit 0\n'): string {
  const p = join(projectRoot, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  if (executable) chmodSync(p, 0o755);
  else chmodSync(p, 0o644);
  return p;
}

describe('safe JSON parsing', () => {
  it('delegates JSON value file reads to the shared file helper', () => {
    const source = readFileSync(new URL('./kaizen-doctor.ts', import.meta.url), 'utf-8');

    expect(source).toContain('../src/lib/json-file.js');
    expect(source).not.toContain('function safeReadJson');
    expect(source).not.toContain('parseJsonValue(readFileSync');
    expect(source).not.toContain('JSON.parse(readFileSync');
  });
});

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

  it('PASS when enabledPlugins set with no duplicate hooks (the #1063 target)', () => {
    writeSettings(proj, { enabledPlugins: { 'kaizen@kaizen': true } });
    const r = checkPluginDoubleInstall({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
    expect(r.detail).toContain('activated via enabledPlugins');
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

  it('FAIL when record for THIS project present but cache missing', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'kaizen@kaizen': [{ installPath: '/nope', projectPath: proj }] } }));
    const r = checkStalePluginCache({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('cache dir missing');
  });

  it('PASS when record scoped to OTHER project (#1061 detection-parity)', () => {
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'kaizen@kaizen': [{ installPath: '/nope', projectPath: '/some/other/project' }] } }));
    const r = checkStalePluginCache({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
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

describe('tokenize + resolveHookPath edge cases (#1062 review)', () => {
  it('tokenize handles double-quoted paths with spaces', () => {
    const r = resolveHookPath('"/path with spaces/foo.sh" arg', '/proj');
    expect(r).toBe('/path with spaces/foo.sh');
  });
  it('resolveHookPath skips env-var prefixes', () => {
    const r = resolveHookPath('FOO=1 BAR=baz ./hook.sh', '/proj');
    expect(r).toBe('/proj/hook.sh');
  });
  it('resolveHookPath expands ${CLAUDE_PLUGIN_ROOT} even with env prefix', () => {
    const r = resolveHookPath('X=1 ${CLAUDE_PLUGIN_ROOT}/hooks/foo.sh', '/proj');
    expect(r).toBe('/proj/hooks/foo.sh');
  });
});

describe('normalizeProjectRoot snapshot-key collision fixes', () => {
  it('snapshotPath is stable across trailing-slash differences', async () => {
    const { snapshotPath, normalizeProjectRoot } = await import('./kaizen-doctor.ts');
    const a = snapshotPath({ projectRoot: '/usr', homeDir: '/tmp/h' });
    const b = snapshotPath({ projectRoot: '/usr/', homeDir: '/tmp/h' });
    // /usr exists — normalize via realpath which strips trailing slash
    expect(normalizeProjectRoot('/usr/')).toBe('/usr');
    expect(a).toBe(b);
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

  it('#1065: PASS when only known_marketplaces.json drifts (Claude refreshes it mid-session)', () => {
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    mkdirSync(join(home, '.claude/plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({ kaizen: { refreshedAt: 't0' } }),
    );
    const snap = buildSnapshot(opts);
    mkdirSync(join(home, '.claude/kaizen-snapshots'), { recursive: true });
    writeFileSync(snapshotPath(opts), JSON.stringify(snap));
    // Claude rewrites the marketplace file mid-session — no user action.
    writeFileSync(
      join(home, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({ kaizen: { refreshedAt: 't1' } }),
    );
    const r = checkRestartNeeded(opts);
    expect(r.status).toBe('PASS');
  });

  it('#1065: known-marketplaces label is not in the snapshot set', () => {
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const labels = restartSensitiveFiles(opts).map(f => f.label);
    expect(labels).not.toContain('known-marketplaces');
  });

  it('#1065: stale snapshots with retired labels do not drift forever', () => {
    // A pre-#1065 snapshot contains the retired `known-marketplaces` label.
    // The check must iterate over the current label set, not the snapshot's,
    // so retired labels are ignored rather than compared to `undefined`.
    const opts: DoctorOpts = { projectRoot: proj, homeDir: home };
    const current = buildSnapshot(opts);
    const staleSnap = {
      ...current,
      hashes: { ...current.hashes, 'known-marketplaces': 'deadbeef-old-hash' },
    };
    mkdirSync(join(home, '.claude/kaizen-snapshots'), { recursive: true });
    writeFileSync(snapshotPath(opts), JSON.stringify(staleSnap));
    const r = checkRestartNeeded(opts);
    expect(r.status).toBe('PASS');
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

describe('checkHookSyntaxSmoke', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('PASS when referenced hooks have valid bash syntax', () => {
    writeHook(proj, '.claude/hooks/foo.sh', true);
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/.claude/hooks/foo.sh' }] }] } });

    const r = checkHookSyntaxSmoke({ projectRoot: proj, homeDir: home });

    expect(r.status).toBe('PASS');
    expect(r.detail).toContain('all 1 hook files pass syntax checks');
  });

  it('FAILs on conflict markers even when the hook is present and executable', () => {
    writeHook(proj, '.claude/hooks/conflicted.sh', true, [
      '#!/bin/bash',
      '<<<<<<< HEAD',
      'echo ours',
      '=======',
      'echo theirs',
      '>>>>>>> branch',
      '',
    ].join('\n'));
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/.claude/hooks/conflicted.sh' }] }] } });

    const r = checkHookSyntaxSmoke({ projectRoot: proj, homeDir: home });

    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('conflicted.sh');
    expect(r.detail).toContain('conflict markers');
  });

  it('FAILs on shell syntax errors with bounded diagnostic detail', () => {
    writeHook(proj, '.claude/hooks/bad.sh', true, '#!/bin/bash\necho "unterminated\n');
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/bad.sh' }] }] } });

    const r = checkHookSyntaxSmoke({ projectRoot: proj, homeDir: home });

    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('bad.sh');
    expect(r.detail).toContain('syntax error');
    expect(r.detail.length).toBeLessThan(700);
  });
});

describe('hook-syntax CLI and SessionStart wrapper', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  function writeConflictedPluginHook(): void {
    writeHook(proj, '.claude/hooks/conflicted.sh', true, [
      '#!/bin/bash',
      '<<<<<<< HEAD',
      'echo ours',
      '=======',
      'echo theirs',
      '>>>>>>> branch',
      '',
    ].join('\n'));
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/.claude/hooks/conflicted.sh' }] }] } });
  }

  it('hook-syntax --quiet is silent on pass and exits non-zero on corrupt hooks', () => {
    writeHook(proj, '.claude/hooks/foo.sh', true);
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/.claude/hooks/foo.sh' }] }] } });

    const ok = spawnSync('npx', ['--prefix', process.cwd(), 'tsx', join(process.cwd(), 'scripts/kaizen-doctor.ts'), 'hook-syntax', '--quiet'], {
      cwd: proj,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('');

    rmSync(join(proj, '.claude/hooks/foo.sh'));
    writeConflictedPluginHook();
    const bad = spawnSync('npx', ['--prefix', process.cwd(), 'tsx', join(process.cwd(), 'scripts/kaizen-doctor.ts'), 'hook-syntax', '--quiet'], {
      cwd: proj,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('[FAIL] hook-syntax-smoke');
    expect(bad.stdout).toContain('conflict markers');
  });

  it('SessionStart snapshot hook surfaces corrupt hooks but exits 0', () => {
    writeConflictedPluginHook();

    const result = spawnSync('bash', [join(process.cwd(), '.claude/hooks/kaizen-session-snapshot.sh')], {
      cwd: proj,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[FAIL] hook-syntax-smoke');
    expect(result.stdout).toContain('conflict markers');
  });
});

describe('checkSingleRegistrationPath (#1063)', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('FAIL when BOTH settings.json and plugin.json have hook entries', () => {
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './foo.sh' }] }] } });
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './bar.sh' }] }] } });
    const r = checkSingleRegistrationPath({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('both sources register hooks');
  });

  it('PASS when only plugin.json has hooks (the #1063 target state)', () => {
    writeSettings(proj, { enabledPlugins: { 'kaizen@kaizen': true } });
    writePluginJson(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './bar.sh' }] }] } });
    const r = checkSingleRegistrationPath({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
    expect(r.detail).toContain('plugin.json');
  });

  it('PASS when only settings.json has hooks (valid for non-kaizen direct registration)', () => {
    writeSettings(proj, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './foo.sh' }] }] } });
    const r = checkSingleRegistrationPath({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
    expect(r.detail).toContain('settings.json');
  });

  it('PASS when neither source has hooks', () => {
    const r = checkSingleRegistrationPath({ projectRoot: proj, homeDir: home });
    expect(r.status).toBe('PASS');
    expect(r.detail).toContain('no hook registrations');
  });
});

describe('checkCodexReadiness (#1151)', () => {
  const supportedFeatures = [
    'shell_tool stable true',
    'unified_exec stable true',
    'hooks stable true',
    'apply_patch removed false',
  ].join('\n');

  const subscriptionDoctorJson = JSON.stringify({
    codexVersion: '0.142.3',
    overallStatus: 'ok',
    checks: {
      'auth.credentials': {
        status: 'ok',
        details: {
          'stored API key': 'false',
          'stored ChatGPT tokens': 'true',
          'stored auth mode': 'chatgpt',
        },
      },
      'config.load': {
        status: 'ok',
        details: {
          'enabled feature flags': 'shell_tool, unified_exec, hooks',
        },
      },
    },
  });

  const runner = (responses: Record<string, string | Error>) =>
    (cmd: string, args: readonly string[]): string => {
      const key = `${cmd} ${args.join(' ')}`;
      const value = responses[key];
      if (value instanceof Error) throw value;
      if (value == null) throw new Error(`unexpected command: ${key}`);
      return value;
    };

  it('WARNs with machine-readable unavailable state when the Codex CLI is missing', () => {
    const r = checkCodexReadiness({
      run: runner({ 'codex --version': new Error('ENOENT') }),
    });

    expect(r.status).toBe('WARN');
    expect(r.name).toBe('codex-readiness');
    expect(r.data).toMatchObject({
      available: false,
      accepted_path_available: false,
      subscription_compatible: false,
    });
  });

  it('reports codex-cli 0.142.3 as supported and subscription-compatible', () => {
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.142.3\n',
        'codex doctor --json': subscriptionDoctorJson,
        'codex features list': supportedFeatures,
      }),
    });

    expect(r.status).toBe('PASS');
    expect(r.data).toMatchObject({
      available: true,
      version: '0.142.3',
      supported_version: true,
      auth_mode: 'chatgpt',
      subscription_compatible: true,
      api_token_only: false,
      accepted_path_available: true,
    });
  });

  it('reports unsupported old versions as present but not accepted', () => {
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.90.0\n',
        'codex doctor --json': subscriptionDoctorJson,
        'codex features list': supportedFeatures,
      }),
    });

    expect(r.status).toBe('WARN');
    expect(r.data).toMatchObject({
      available: true,
      version: '0.90.0',
      supported_version: false,
      accepted_path_available: false,
    });
  });

  it('keeps version/auth readiness when feature probing fails', () => {
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.142.3\n',
        'codex doctor --json': subscriptionDoctorJson,
        'codex features list': new Error('not supported'),
      }),
    });

    expect(r.status).toBe('PASS');
    expect(r.data).toMatchObject({
      available: true,
      supported_version: true,
      feature_probe: 'unavailable',
      accepted_path_available: true,
    });
  });

  it('does not accept readiness when a required Codex feature is disabled', () => {
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.142.3\n',
        'codex doctor --json': subscriptionDoctorJson,
        'codex features list': [
          'shell_tool stable true',
          'unified_exec stable false',
          'hooks stable true',
        ].join('\n'),
      }),
    });

    expect(r.status).toBe('WARN');
    expect(r.data).toMatchObject({
      required_features: { unified_exec: false },
      accepted_path_available: false,
    });
  });

  it('does not accept API-token-only auth as subscription-compatible readiness', () => {
    const apiTokenDoctorJson = JSON.stringify({
      codexVersion: '0.142.3',
      checks: {
        'auth.credentials': {
          status: 'ok',
          details: {
            'stored API key': 'true',
            'stored ChatGPT tokens': 'false',
            'stored auth mode': 'api-key',
          },
        },
      },
    });
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.142.3\n',
        'codex doctor --json': apiTokenDoctorJson,
        'codex features list': supportedFeatures,
      }),
    });

    expect(r.status).toBe('WARN');
    expect(r.data).toMatchObject({
      available: true,
      api_token_only: true,
      subscription_compatible: false,
      accepted_path_available: false,
    });
  });

  it('serializes readiness data for JSON doctor output', () => {
    const r = checkCodexReadiness({
      run: runner({
        'codex --version': 'codex-cli 0.142.3\n',
        'codex doctor --json': subscriptionDoctorJson,
        'codex features list': supportedFeatures,
      }),
    });

    expect(JSON.parse(JSON.stringify({ results: [r] })).results[0].data).toMatchObject({
      accepted_path_available: true,
    });
  });
});

describe('runAllChecks + exitCodeFor', () => {
  let proj: string, home: string;
  beforeEach(() => { proj = makeProject(); home = makeHome(); });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('returns checks in defined order', () => {
    const codexRun = vi.fn((cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'codex --version') return 'codex-cli 0.142.3\n';
      if (key === 'codex doctor --json') {
        return JSON.stringify({
          checks: {
            'auth.credentials': {
              details: {
                'stored API key': 'false',
                'stored ChatGPT tokens': 'true',
                'stored auth mode': 'chatgpt',
              },
            },
          },
        });
      }
      if (key === 'codex features list') {
        return [
          'shell_tool stable true',
          'unified_exec stable true',
          'hooks stable true',
        ].join('\n');
      }
      throw new Error(`unexpected command: ${key}`);
    });
    const results = runAllChecks({
      projectRoot: proj,
      homeDir: home,
      codexReadiness: { run: codexRun },
    });
    expect(results.map(r => r.name)).toEqual([
      'single-registration-path',
      'plugin-double-install',
      'dangling-hook-paths',
      'stale-plugin-cache',
      'restart-needed',
      'hook-exec-smoke',
      'hook-syntax-smoke',
      'codex-readiness',
    ]);
    expect(codexRun).toHaveBeenCalledWith('codex', ['--version']);
  });

  it('exitCodeFor returns 1 when any FAIL', () => {
    expect(exitCodeFor([{ name: 'x', status: 'PASS', detail: '' }, { name: 'y', status: 'FAIL', detail: '' }])).toBe(1);
  });

  it('exitCodeFor returns 0 when no FAIL', () => {
    expect(exitCodeFor([{ name: 'x', status: 'PASS', detail: '' }, { name: 'y', status: 'WARN', detail: '' }])).toBe(0);
  });
});
