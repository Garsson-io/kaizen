/**
 * pre-push-live.test.ts — end-to-end test for the pre-push git hook (epic #1059).
 *
 * Creates an isolated tmp git repo with a mocked `gh` binary on PATH, wires
 * up kaizen's .githooks/pre-push, and exercises the full push pipeline
 * for three scenarios per the testplan.
 *
 * System-level test — hits real `git`, real shell wrapper, real TS dispatch,
 * real state-utils. Only `gh` is stubbed (no network, fast, deterministic).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;
let remoteDir: string;
let stateDir: string;
let mockBin: string;
let traceFile: string;

const KAIZEN_REPO_ROOT = path.resolve(__dirname, '../..');
const GITHOOKS_PRE_PUSH = path.join(KAIZEN_REPO_ROOT, '.githooks/pre-push');
const HOOK_TS = path.join(KAIZEN_REPO_ROOT, 'src/hooks/pre-push.ts');

/**
 * Find `tsx` in the worktree's own node_modules, or fall back to the shared
 * main repo's node_modules (symlinked by kaizen-worktree-setup.sh, sometimes
 * absent). If neither exists we skip the test rather than fail opaquely.
 */
function findTsx(): string | null {
  const local = path.join(KAIZEN_REPO_ROOT, 'node_modules/.bin/tsx');
  if (fs.existsSync(local)) return local;

  // Walk up from KAIZEN_REPO_ROOT looking for node_modules/.bin/tsx in case
  // we're in a worktree whose node_modules symlink is missing.
  let dir = path.dirname(KAIZEN_REPO_ROOT);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'node_modules/.bin/tsx');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: common-dir-based resolution for git worktrees
  try {
    const common = execSync('git rev-parse --git-common-dir', {
      cwd: KAIZEN_REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    const mainRoot = path.dirname(common);
    const mainTsx = path.join(mainRoot, 'node_modules/.bin/tsx');
    if (fs.existsSync(mainTsx)) return mainTsx;
  } catch { /* ignore */ }

  return null;
}

const TSX_BIN = findTsx();

function writeMockGh(response: unknown): void {
  const content = `#!/usr/bin/env bash
# Mock gh: responds to any pr list invocation with a canned JSON array.
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${JSON.stringify(response)}
JSON
  exit 0
fi
exit 1
`;
  const ghPath = path.join(mockBin, 'gh');
  fs.writeFileSync(ghPath, content);
  fs.chmodSync(ghPath, 0o755);
}

/**
 * Simulate `git push` by invoking the pre-push TS hook directly with the
 * git pre-push protocol on stdin. The shell wrapper's agent-gate + dispatch
 * is tested separately in .claude/hooks/tests/test-pre-push-wrapper.sh.
 *
 * Here we exercise the full TS pipeline end-to-end against a real git repo +
 * stubbed gh binary — the "live" part of the test.
 */
function runHook(options: {
  cwd: string;
  env?: Record<string, string>;
  stdinRefs?: string;
}): { exitCode: number; stderr: string; stateFiles: string[] } {
  if (!TSX_BIN) throw new Error('tsx not found — cannot run E2E test');
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH ?? ''}`,
    STATE_DIR: stateDir,
    KAIZEN_HOOK_TRACE: traceFile,
    ...(options.env ?? {}),
  };
  const result = spawnSync(TSX_BIN, [HOOK_TS], {
    cwd: options.cwd,
    env,
    input: options.stdinRefs ?? '',
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stateFiles: fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [],
  };
}

beforeAll(() => {
  if (!TSX_BIN) {
    // eslint-disable-next-line no-console
    console.warn('SKIP: tsx not found — E2E test requires npm install');
  }
});

beforeEach(() => {
  if (!TSX_BIN) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-e2e-'));
  remoteDir = path.join(tmpDir, 'remote.git');
  stateDir = path.join(tmpDir, 'state');
  mockBin = path.join(tmpDir, 'bin');
  traceFile = path.join(tmpDir, 'trace.jsonl');

  fs.mkdirSync(mockBin, { recursive: true });

  // Create a bare remote
  execSync(`git init --bare "${remoteDir}"`, { stdio: 'pipe' });

  // Create the working clone
  const workDir = path.join(tmpDir, 'work');
  execSync(`git clone "${remoteDir}" "${workDir}"`, { stdio: 'pipe' });
  execSync('git config user.email "test@example.com" && git config user.name "Test"', {
    cwd: workDir,
    stdio: 'pipe',
  });
  // Set the remote origin URL pattern that detectRepo can parse
  execSync(`git remote set-url origin https://github.com/testowner/testrepo.git`, {
    cwd: workDir,
    stdio: 'pipe',
  });
  // Create an initial commit so HEAD is valid
  fs.writeFileSync(path.join(workDir, 'README.md'), '# test\n');
  execSync('git add . && git commit -m init', { cwd: workDir, stdio: 'pipe' });
  execSync('git checkout -b feat/test-branch', { cwd: workDir, stdio: 'pipe' });

  // Replace tmpDir.work with tmpDir for subsequent calls
  tmpDir = workDir;
});

afterEach(() => {
  const base = path.dirname(path.dirname(tmpDir));
  if (base.includes('pre-push-e2e-')) {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── Scenario 1: agent push to branch with open PR → gate opens ────────

describe('E2E: agent push with open PR (I-C)', () => {
  it('opens needs_review gate when CLAUDECODE is set and branch has open PR', () => {
    writeMockGh([
      { number: 42, state: 'OPEN', url: 'https://github.com/testowner/testrepo/pull/42' },
    ]);

    const result = runHook({
      cwd: tmpDir,
      env: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).toBe(0);
    // Gate state file written (idempotent with pr-review-loop's key)
    expect(result.stateFiles.some(f => f.includes('testowner_testrepo_42'))).toBe(true);

    // Verify state file contents
    const stateFile = result.stateFiles.find(f => f.includes('testowner_testrepo_42'))!;
    const content = fs.readFileSync(path.join(stateDir, stateFile), 'utf-8');
    expect(content).toContain('STATUS=needs_review');
    expect(content).toContain('PR_URL=https://github.com/testowner/testrepo/pull/42');

    // Trace JSONL emitted
    expect(fs.existsSync(traceFile)).toBe(true);
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
    expect(trace.hook).toBe('pre-push');
    expect(trace.agent_detected).toBe(true);
    expect(trace.action).toBe('allow_gate');
  });
});

// ── Scenario 2: human push (no CLAUDECODE) → no side effects ─────────

describe('E2E: human push without agent env (I-A)', () => {
  it('TS hook emits no_agent_env trace + no side effects when CLAUDECODE is absent', () => {
    writeMockGh([
      { number: 42, state: 'OPEN', url: 'https://github.com/testowner/testrepo/pull/42' },
    ]);

    // Strip CLAUDECODE and all agent env vars
    const result = spawnSync(TSX_BIN, [HOOK_TS], {
      cwd: tmpDir,
      env: {
        PATH: `${mockBin}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? '/tmp',
        STATE_DIR: stateDir,
        KAIZEN_HOOK_TRACE: traceFile,
      },
      input: '',
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    // No state files written (no gate opened)
    expect(fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []).toEqual([]);
    // TS-level trace shows no_agent_env decision (written by the TS hook
    // before exit, even though shell wrapper would short-circuit earlier)
    if (fs.existsSync(traceFile)) {
      const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
      expect(trace.agent_detected).toBe(false);
      expect(trace.action).toBe('allow_silent');
      expect(trace.reason).toBe('no_agent_env');
    }
  });
});

// ── Scenario 3: merged-branch push → denied with recovery ────────────

describe('E2E: merged-branch push denied (I-B, #1032)', () => {
  it('denies push when most-recent PR is MERGED and no newer OPEN', () => {
    writeMockGh([
      { number: 41, state: 'MERGED', url: 'https://github.com/testowner/testrepo/pull/41' },
    ]);

    const result = runHook({
      cwd: tmpDir,
      env: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('merged PR');
    expect(result.stderr).toContain('kaizen-force');
    // No state file written on deny
    expect(result.stateFiles).toEqual([]);

    // Trace shows deny decision
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
    expect(trace.action).toBe('deny');
    expect(trace.reason).toBe('merged_branch_push');
  });

  it('allows push with kaizen-force override (I-F)', () => {
    writeMockGh([
      { number: 41, state: 'MERGED', url: 'https://github.com/testowner/testrepo/pull/41' },
    ]);

    const result = runHook({
      cwd: tmpDir,
      env: {
        CLAUDECODE: '1',
        GIT_PUSH_OPTION_COUNT: '1',
        GIT_PUSH_OPTION_0: 'kaizen-force',
      },
    });

    expect(result.exitCode).toBe(0);
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
    expect(trace.reason).toBe('push_option_override');
  });
});

// ── Scenario 4: fresh branch (no PR history) → silent allow ──────────

describe('E2E: fresh branch with no PR history (I-D)', () => {
  it('allows silently when gh returns no PRs', () => {
    writeMockGh([]);

    const result = runHook({
      cwd: tmpDir,
      env: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stateFiles).toEqual([]);

    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf-8').trim().split('\n')[0]);
    expect(trace.reason).toBe('no_pr_history');
  });
});
