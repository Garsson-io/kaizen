/**
 * Smoke tests for bash wrapper -> tsx -> hook chain.
 *
 * Verifies the ACTUAL deployment path: thin bash wrappers
 * (.claude/kaizen/hooks/*-ts.sh) correctly invoke npx tsx and the
 * TypeScript hooks produce expected output.
 *
 * IMPORTANT: All tests use isolated STATE_DIR (tmpDir) AND randomized
 * PR numbers to prevent state leaking into the real hook state directory.
 * This prevents accidental kaizen gate triggers (learned from incident
 * where smoke tests with PR 99999 blocked the entire session).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOKS_DIR = path.resolve(__dirname, '../../.claude/hooks');

let tmpDir: string;
let testPrNum: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-smoke-'));
  testPrNum = String(Math.floor(Math.random() * 900000) + 100000);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Safety cleanup: remove any state that leaked to the default dir
  const defaultDir = '/tmp/.pr-review-state';
  for (const pattern of [
    `pr-kaizen-Garsson-io_smoke-test_${testPrNum}`,
    `Garsson-io_smoke-test_${testPrNum}`,
    `kaizen-done-Garsson-io_smoke-test_${testPrNum}`,
    `post-merge-Garsson-io_smoke-test_${testPrNum}`,
  ]) {
    try {
      fs.unlinkSync(path.join(defaultDir, pattern));
    } catch {}
  }
});

function testPrUrl(): string {
  // Use a fake repo name "smoke-test" that doesn't match any real repo
  return `https://github.com/Garsson-io/smoke-test/pull/${testPrNum}`;
}

/** Run a bash wrapper with optional stdin, return { stdout, exitCode }.
 *  Pass `input` as an object to send JSON, or omit/null for empty stdin. */
function runWrapper(
  wrapperName: string,
  input: object | null,
  extraEnv?: Record<string, string>,
): { stdout: string; exitCode: number } {
  const wrapperPath = path.join(HOOKS_DIR, wrapperName);
  if (!fs.existsSync(wrapperPath)) {
    throw new Error(`Wrapper not found: ${wrapperPath}`);
  }

  const stdinData = input != null ? JSON.stringify(input) : '';
  try {
    const stdout = execSync(`bash "${wrapperPath}"`, {
      encoding: 'utf-8',
      input: stdinData,
      env: {
        ...process.env,
        STATE_DIR: tmpDir,
        AUDIT_DIR: path.join(tmpDir, 'audit'),
        IPC_DIR: path.join(tmpDir, 'ipc'),
        HOOK_TIMING_SENTINEL_DISABLED: 'true',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim?.() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

const NOOP_INPUT = {
  tool_input: { command: 'echo hello' },
  tool_response: { stdout: 'hello', stderr: '', exit_code: '0' },
};

describe('wrapper smoke: bash wrappers exist and are executable', () => {
  for (const wrapper of [
    'pr-review-loop-ts.sh',
    'pr-kaizen-clear-ts.sh',
    'kaizen-reflect-ts.sh',
  ]) {
    it(`${wrapper} exists and is executable`, () => {
      const wrapperPath = path.join(HOOKS_DIR, wrapper);
      expect(fs.existsSync(wrapperPath)).toBe(true);
      const stats = fs.statSync(wrapperPath);
      expect(stats.mode & 0o100).toBeGreaterThan(0);
    });
  }
});

describe('wrapper smoke: pr-review-loop-ts.sh', () => {
  it('exits 0 with no output on non-matching command', () => {
    const { stdout, exitCode } = runWrapper('pr-review-loop-ts.sh', NOOP_INPUT);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('produces review prompt on PR create', () => {
    const { stdout, exitCode } = runWrapper('pr-review-loop-ts.sh', {
      tool_input: { command: 'gh pr create --title "smoke test"' },
      tool_response: {
        stdout: testPrUrl(),
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MANDATORY SELF-REVIEW');
    expect(stdout).toContain(`pull/${testPrNum}`);
  });
});

describe('wrapper smoke: kaizen-reflect-ts.sh', () => {
  it('exits 0 with no output on non-matching command', () => {
    const { stdout, exitCode } = runWrapper('kaizen-reflect-ts.sh', NOOP_INPUT);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('produces reflection prompt on PR create', () => {
    const { stdout, exitCode } = runWrapper('kaizen-reflect-ts.sh', {
      tool_input: { command: 'gh pr create --title "smoke test"' },
      tool_response: {
        stdout: testPrUrl(),
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('KAIZEN REFLECTION');
    expect(stdout).toContain('kaizen-bg');
  });
});

describe('wrapper smoke: pr-kaizen-clear-ts.sh', () => {
  it('exits 0 silently when no gate is active', () => {
    const { stdout, exitCode } = runWrapper('pr-kaizen-clear-ts.sh', {
      tool_name: 'Bash',
      tool_input: {
        command: "echo 'KAIZEN_NO_ACTION [test-only]: smoke test'",
      },
      tool_response: {
        stdout: 'KAIZEN_NO_ACTION [test-only]: smoke test',
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('clears gate when valid KAIZEN_NO_ACTION submitted', () => {
    // Create a gate state file in tmpDir
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    const key = `Garsson-io_smoke-test_${testPrNum}`;
    fs.writeFileSync(
      path.join(tmpDir, `pr-kaizen-${key}`),
      `PR_URL=${testPrUrl()}\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );

    const { stdout, exitCode } = runWrapper('pr-kaizen-clear-ts.sh', {
      tool_name: 'Bash',
      tool_input: {
        command: "echo 'KAIZEN_NO_ACTION [test-only]: smoke test'",
      },
      tool_response: {
        stdout: 'KAIZEN_NO_ACTION [test-only]: smoke test',
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PR kaizen gate cleared');
  });
});

describe('wrapper smoke: null stdin — all traceNullInput hooks exit 0 silently', () => {
  // INVARIANT: every hook that calls traceNullInput() MUST exit 0 with no stdout
  // when it receives empty stdin. Null input = Claude Code didn't send a hook event.
  // The hook must be a no-op, not crash or block the agent.
  const traceNullInputWrappers = [
    'pr-review-loop-ts.sh',
    'kaizen-reflect-ts.sh',
    'pr-kaizen-clear-ts.sh',
    'kaizen-check-dirty-files-ts.sh',
    'kaizen-bump-plugin-version-ts.sh',
    'kaizen-enforce-pr-review-ts.sh',
    'kaizen-pr-kaizen-clear-fallback.sh',
    'kaizen-enforce-pr-reflect-ts.sh',
    'kaizen-post-merge-clear-ts.sh',
    'kaizen-pr-quality-checks-ts.sh',
  ];

  for (const wrapper of traceNullInputWrappers) {
    it(`${wrapper} exits 0 silently on empty stdin`, () => {
      const { stdout, exitCode } = runWrapper(wrapper, null, { KAIZEN_HOOK_TRACE: '0' });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    });
  }
});
