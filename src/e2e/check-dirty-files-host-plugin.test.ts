/**
 * check-dirty-files-host-plugin.test.ts — live fixture for #1073.
 *
 * Reproduces the exact scenario that blocked the langsmith-cli host repo:
 * a project that ships its own `.claude-plugin/plugin.json`, with kaizen's
 * check-dirty-files hook invoked from an UNRELATED cwd via a compound
 * `cd <host-repo> && gh pr create …` payload.
 *
 * System-level: real tmp git repo, real subprocess invocation of the hook
 * via tsx. The only way to prove the fix works against cwd-drift.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveTsxBin } from './test-runtime.js';

const KAIZEN_REPO_ROOT = path.resolve(__dirname, '../..');
const HOOK_TS = path.join(KAIZEN_REPO_ROOT, 'src/hooks/check-dirty-files.ts');

const TSX_BIN = resolveTsxBin(KAIZEN_REPO_ROOT);

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
}

function runHook(command: string, cwd: string, extraEnv: Record<string, string> = {}): HookResult {
  if (!TSX_BIN) throw new Error('tsx not found — cannot run live hook test');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
  const r = spawnSync(TSX_BIN, [HOOK_TS], {
    input: payload,
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv },
  });
  let parsed: unknown = null;
  if (r.stdout.trim()) {
    try { parsed = JSON.parse(r.stdout); } catch { /* non-JSON stdout is fine */ }
  }
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, parsed };
}

function isDeny(res: HookResult): boolean {
  const p = res.parsed as { hookSpecificOutput?: { permissionDecision?: string } } | null;
  return p?.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('check-dirty-files live fixture — host repo with own .claude-plugin/plugin.json (#1073)', () => {
  if (!TSX_BIN) {
    it.skip('tsx not found — skipping live test', () => {});
    return;
  }

  let tmpRoot: string;
  let hostRepo: string;
  let unrelatedCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-1073-'));
    hostRepo = path.join(tmpRoot, 'host-project');
    unrelatedCwd = path.join(tmpRoot, 'elsewhere');
    fs.mkdirSync(hostRepo, { recursive: true });
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    // Init a non-kaizen git repo that happens to have its own plugin.json.
    execSync('git init -q -b main', { cwd: hostRepo });
    execSync('git config user.email "t@e"', { cwd: hostRepo });
    execSync('git config user.name "t"', { cwd: hostRepo });

    const pluginDir = path.join(hostRepo, '.claude-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'host-project', version: '0.1.0' }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(hostRepo, 'README.md'), '# host\n');
    execSync('git add -A && git commit -q -m init', { cwd: hostRepo });

    // `unrelatedCwd` is not even a git repo — it's some random dir the agent
    // might be in when it runs `cd /host-project && gh pr create`.
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('allows gh pr create when cd into a clean host repo (the #1073 scenario)', () => {
    // Sanity: host repo is genuinely clean.
    const status = execSync('git status --porcelain', { cwd: hostRepo, encoding: 'utf-8' });
    expect(status).toBe('');

    const res = runHook(`cd ${hostRepo} && gh pr create --title t`, unrelatedCwd);

    expect(isDeny(res)).toBe(false);
    // Hook exited 0 with either empty stdout or a non-deny response.
    expect(res.exitCode).toBe(0);
  });

  it('still denies when the host repo has a real uncommitted change', () => {
    // Make a genuine content change.
    fs.writeFileSync(
      path.join(hostRepo, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'host-project', version: '0.2.0' }, null, 2) + '\n',
    );

    const res = runHook(`cd ${hostRepo} && gh pr create --title t`, unrelatedCwd);
    expect(isDeny(res)).toBe(true);

    // Diagnostic block must be visible.
    const msg =
      (res.parsed as { hookSpecificOutput?: { permissionDecisionReason?: string } } | null)
        ?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(msg).toContain('[cwd]');
    expect(msg).toContain('[target]');
    expect(msg).toContain('[porcelain]');
    expect(msg).toContain(unrelatedCwd); // cwd where hook actually ran
    expect(msg).toContain(hostRepo); // resolved target
  });

  it('respects KAIZEN_ALLOW_DIRTY_FILES=1 escape hatch', () => {
    fs.writeFileSync(
      path.join(hostRepo, '.claude-plugin/plugin.json'),
      JSON.stringify({ changed: true }) + '\n',
    );

    const res = runHook(
      `cd ${hostRepo} && gh pr create --title t`,
      unrelatedCwd,
      { KAIZEN_ALLOW_DIRTY_FILES: '1' },
    );
    expect(isDeny(res)).toBe(false);
    expect(res.stderr).toContain('BYPASS');
  });

  it('allows when agent cwd is a DIFFERENT git repo with staged drift (#1073 field scenario)', () => {
    // Strongest end-to-end proof. The field bug: the agent process's cwd
    // was a git repo (e.g. the main kaizen checkout) with a phantom
    // `M  .claude-plugin/plugin.json` entry left by kaizen-bump-plugin-
    // version. When `cd <host-repo> && gh pr create` ran, PreToolUse
    // fired before the shell cd, so `git status --porcelain` inherited
    // the drifted cwd and denied. We reproduce that exact topology here:
    // `driftedCwd` is a real git repo with a real staged change, the
    // target `hostRepo` is clean, and the hook must allow.
    const driftedCwd = path.join(tmpRoot, 'drifted-agent-repo');
    fs.mkdirSync(driftedCwd, { recursive: true });
    execSync('git init -q -b main', { cwd: driftedCwd });
    execSync('git config user.email t@e', { cwd: driftedCwd });
    execSync('git config user.name t', { cwd: driftedCwd });
    fs.mkdirSync(path.join(driftedCwd, '.claude-plugin'));
    fs.writeFileSync(
      path.join(driftedCwd, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'drifted', version: '0.1.0' }) + '\n',
    );
    execSync('git add -A && git commit -q -m init', { cwd: driftedCwd });
    // Stage a change without committing — the exact shape of the #1073
    // phantom.
    fs.writeFileSync(
      path.join(driftedCwd, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'drifted', version: '0.2.0' }) + '\n',
    );
    execSync('git add .claude-plugin/plugin.json', { cwd: driftedCwd });
    // Sanity: drift is real in driftedCwd, hostRepo stays clean.
    expect(execSync('git status --porcelain', { cwd: driftedCwd, encoding: 'utf-8' })).toContain(
      '.claude-plugin/plugin.json',
    );
    expect(execSync('git status --porcelain', { cwd: hostRepo, encoding: 'utf-8' })).toBe('');

    const res = runHook(`cd ${hostRepo} && gh pr create --title t`, driftedCwd);

    expect(isDeny(res)).toBe(false);
    expect(res.exitCode).toBe(0);
  });

  it('allows gh pr create when porcelain is stat-dirty but content matches HEAD (#871)', () => {
    // Induce stat-dirty-but-content-clean: touch the file without changing
    // content. On most filesystems this bumps mtime enough to make git's
    // stat cache unhappy, though `git status --porcelain` alone may or may
    // not flag it depending on the racy stat check. The content-level
    // `git diff --quiet HEAD --` will always confirm identity.
    const target = path.join(hostRepo, '.claude-plugin/plugin.json');
    const contents = fs.readFileSync(target);
    // Rewrite identical bytes a second later to perturb stat.
    const future = new Date(Date.now() + 2000);
    fs.writeFileSync(target, contents);
    fs.utimesSync(target, future, future);

    const res = runHook(`cd ${hostRepo} && gh pr create --title t`, unrelatedCwd);
    expect(isDeny(res)).toBe(false);
  });
});
