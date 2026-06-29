/**
 * Smoke tests for bash wrapper -> tsx -> hook chain.
 *
 * Verifies the ACTUAL deployment path: thin bash wrappers
 * (.claude/hooks/*-ts.sh) correctly invoke npx tsx and the
 * TypeScript hooks produce expected output.
 *
 * IMPORTANT: All tests use isolated STATE_DIR (tmpDir) AND randomized
 * PR numbers to prevent state leaking into the real hook state directory.
 * This prevents accidental kaizen gate triggers (learned from incident
 * where smoke tests with PR 99999 blocked the entire session).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOKS_DIR = path.resolve(__dirname, '../../.claude/hooks');
const GIT_PRE_PUSH = path.resolve(__dirname, '../../.githooks/pre-push');
const HOOKS_DESIGN = path.resolve(__dirname, '../../docs/hooks-design.md');
const TRUSTED_DEFAULT_STATE_DIR_ENV = 'KAIZEN_TRUST_DEFAULT_STATE_DIR';

interface SmokeContext {
  tmpDir: string;
  testPrNum: string;
}

function createSmokeContext(): SmokeContext {
  return {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-smoke-')),
    testPrNum: String(Math.floor(Math.random() * 900000) + 100000),
  };
}

function cleanupSmokeContext(ctx: SmokeContext): void {
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  // Safety cleanup: remove any state that leaked to the default dir
  const defaultDir = '/tmp/.pr-review-state';
  for (const pattern of [
    `pr-kaizen-Garsson-io_smoke-test_${ctx.testPrNum}`,
    `Garsson-io_smoke-test_${ctx.testPrNum}`,
    `kaizen-done-Garsson-io_smoke-test_${ctx.testPrNum}`,
    `post-merge-Garsson-io_smoke-test_${ctx.testPrNum}`,
  ]) {
    try {
      fs.unlinkSync(path.join(defaultDir, pattern));
    } catch {}
  }
}

async function withSmokeContext<T>(fn: (ctx: SmokeContext) => T | Promise<T>): Promise<T> {
  const ctx = createSmokeContext();
  try {
    return await fn(ctx);
  } finally {
    cleanupSmokeContext(ctx);
  }
}

function testPrUrl(ctx: SmokeContext): string {
  // Use a fake repo name "smoke-test" that doesn't match any real repo
  return `https://github.com/Garsson-io/smoke-test/pull/${ctx.testPrNum}`;
}

/** Run a bash wrapper with optional stdin, return { stdout, exitCode }.
 *  Pass `input` as an object to send JSON, or omit/null for empty stdin. */
function runWrapper(
  ctx: SmokeContext,
  wrapperName: string,
  input: object | null,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const wrapperPath = path.join(HOOKS_DIR, wrapperName);
  if (!fs.existsSync(wrapperPath)) {
    throw new Error(`Wrapper not found: ${wrapperPath}`);
  }

  const stdinData = input != null ? JSON.stringify(input) : '';
  return new Promise((resolve) => {
    const child = spawn('bash', [wrapperPath], {
      env: {
        ...process.env,
        STATE_DIR: ctx.tmpDir,
        AUDIT_DIR: path.join(ctx.tmpDir, 'audit'),
        IPC_DIR: path.join(ctx.tmpDir, 'ipc'),
        HOOK_TIMING_SENTINEL_DISABLED: 'true',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), exitCode: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), exitCode: code ?? 1 });
    });
    child.stdin.end(stdinData);
  });
}

const NOOP_INPUT = {
  tool_input: { command: 'echo hello' },
  tool_response: { stdout: 'hello', stderr: '', exit_code: '0' },
};

describe('wrapper smoke: root-resolution boilerplate', () => {
  it('keeps hook wrappers from duplicating root resolution (#365)', () => {
    const wrappers = fs
      .readdirSync(HOOKS_DIR)
      .filter((name) => name.endsWith('.sh'))
      .sort();
    const forbidden = [
      { name: 'SCRIPT_DIR=', pattern: /^\s*SCRIPT_DIR=/m },
      { name: 'PROJECT_ROOT=', pattern: /^\s*PROJECT_ROOT=/m },
      {
        name: 'inline KAIZEN_DIR dirname resolution',
        pattern: /^\s*KAIZEN_DIR=.*dirname/m,
      },
    ];

    const offenders = wrappers.flatMap((wrapper) => {
      const content = fs.readFileSync(path.join(HOOKS_DIR, wrapper), 'utf-8');
      return forbidden
        .filter(({ pattern }) => pattern.test(content))
        .map(({ name }) => `${wrapper}: ${name}`);
    });

    expect(offenders).toEqual([]);
  });
});

describe('wrapper smoke: bash wrappers exist and are executable', () => {
  for (const wrapper of [
    'pr-review-loop-ts.sh',
    'pr-kaizen-clear-ts.sh',
    'kaizen-reflect-ts.sh',
  ]) {
    it.concurrent(`${wrapper} exists and is executable`, () => {
      const wrapperPath = path.join(HOOKS_DIR, wrapper);
      expect(fs.existsSync(wrapperPath)).toBe(true);
      const stats = fs.statSync(wrapperPath);
      expect(stats.mode & 0o100).toBeGreaterThan(0);
    });
  }
});

describe('wrapper smoke: default state trust boundary', () => {
  it('marks Claude TS hook trampolines as trusted default-state writers (#1072)', () => {
    const source = fs.readFileSync(path.join(HOOKS_DIR, 'lib/run-tsx.sh'), 'utf-8');

    expect(source).toContain(`export ${TRUSTED_DEFAULT_STATE_DIR_ENV}=1`);
  });

  it('marks the git pre-push wrapper as a trusted default-state writer (#1072)', () => {
    const source = fs.readFileSync(GIT_PRE_PUSH, 'utf-8');

    expect(source).toContain(`export ${TRUSTED_DEFAULT_STATE_DIR_ENV}=1`);
  });

  it('documents isolated STATE_DIR for direct hook smoke tests (#1072)', () => {
    const source = fs.readFileSync(HOOKS_DESIGN, 'utf-8');

    expect(source).toContain('STATE_DIR=$(mktemp -d)');
    expect(source).toContain(TRUSTED_DEFAULT_STATE_DIR_ENV);
  });
});

describe('wrapper smoke: pr-review-loop-ts.sh', () => {
  it.concurrent('exits 0 with no output on non-matching command', async () => withSmokeContext(async (ctx) => {
    const { stdout, exitCode } = await runWrapper(ctx, 'pr-review-loop-ts.sh', NOOP_INPUT);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  }));

  it.concurrent('produces review prompt on PR create', async () => withSmokeContext(async (ctx) => {
    const { stdout, exitCode } = await runWrapper(ctx, 'pr-review-loop-ts.sh', {
      tool_input: { command: 'gh pr create --title "smoke test"' },
      tool_response: {
        stdout: testPrUrl(ctx),
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MANDATORY SELF-REVIEW');
    expect(stdout).toContain(`pull/${ctx.testPrNum}`);
  }));
});

describe('wrapper smoke: kaizen-reflect-ts.sh', () => {
  it.concurrent('exits 0 with no output on non-matching command', async () => withSmokeContext(async (ctx) => {
    const { stdout, exitCode } = await runWrapper(ctx, 'kaizen-reflect-ts.sh', NOOP_INPUT);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  }));

  it.concurrent('produces reflection prompt on PR create', async () => withSmokeContext(async (ctx) => {
    const { stdout, exitCode } = await runWrapper(ctx, 'kaizen-reflect-ts.sh', {
      tool_input: { command: 'gh pr create --title "smoke test"' },
      tool_response: {
        stdout: testPrUrl(ctx),
        stderr: '',
        exit_code: '0',
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('KAIZEN REFLECTION');
    expect(stdout).toContain('kaizen-bg');
  }));
});

describe('wrapper smoke: pr-kaizen-clear-ts.sh', () => {
  it.concurrent('exits 0 silently when no gate is active', async () => withSmokeContext(async (ctx) => {
    const { stdout, exitCode } = await runWrapper(ctx, 'pr-kaizen-clear-ts.sh', {
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
  }));

  it.concurrent('clears gate when valid KAIZEN_NO_ACTION submitted', async () => withSmokeContext(async (ctx) => {
    // Create a gate state file in tmpDir
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    const key = `Garsson-io_smoke-test_${ctx.testPrNum}`;
    fs.writeFileSync(
      path.join(ctx.tmpDir, `pr-kaizen-${key}`),
      `PR_URL=${testPrUrl(ctx)}\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );

    const { stdout, exitCode } = await runWrapper(ctx, 'pr-kaizen-clear-ts.sh', {
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
  }));
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
    'kaizen-enforce-merge-verdict-ts.sh',
    'kaizen-pr-kaizen-clear-fallback.sh',
    'kaizen-enforce-pr-reflect-ts.sh',
    'kaizen-post-merge-clear-ts.sh',
    'kaizen-pr-quality-checks-ts.sh',
  ];

  for (const wrapper of traceNullInputWrappers) {
    it.concurrent(`${wrapper} exits 0 silently on empty stdin`, async () => withSmokeContext(async (ctx) => {
      const { stdout, exitCode } = await runWrapper(ctx, wrapper, null, { KAIZEN_HOOK_TRACE: '0' });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    }));
  }
});
