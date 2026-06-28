import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from './hook-io.js';
import {
  generateCreateReflection,
  generateMergeReflection,
  processHookInput,
} from './kaizen-reflect.js';

const TEST_STATE_DIR = '/tmp/.test-kaizen-reflect-ts';

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
});

function makeInput(overrides: {
  command?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  transcript_path?: string;
}): HookInput {
  return {
    tool_name: 'Bash',
    transcript_path: overrides.transcript_path,
    tool_input: { command: overrides.command ?? 'echo test' },
    tool_response: {
      stdout: overrides.stdout ?? '',
      stderr: overrides.stderr ?? '',
      exit_code: overrides.exit_code ?? 0,
    },
  };
}

const defaultOpts = {
  stateDir: TEST_STATE_DIR,
  branch: 'feat-test',
  repoFromGit: 'Garsson-io/kaizen',
  mainCheckout: '/home/user/projects/kaizen',
  changedFiles: 'src/hooks/kaizen-reflect.ts',
  sendNotification: vi.fn(),
  runHookTimingSentinel: () => '',
};

describe('processHookInput', () => {
  describe('gh pr create', () => {
    it('creates state file and returns reflection output', () => {
      const input = makeInput({
        command: 'gh pr create --title "test" --body "test"',
        stdout: 'https://github.com/Garsson-io/kaizen/pull/42',
      });

      const output = processHookInput(input, defaultOpts);

      expect(output).not.toBeNull();
      expect(output).toContain('KAIZEN REFLECTION');
      expect(output).toContain('Post-PR Creation');
      expect(output).toContain('kaizen-bg');
      expect(output).toContain('pull/42');

      // State file should be created
      const stateFiles = readdirSync(TEST_STATE_DIR).filter((f) =>
        f.startsWith('pr-kaizen-'),
      );
      expect(stateFiles).toHaveLength(1);
    });

    it('includes KAIZEN_IMPEDIMENTS format', () => {
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: 'https://github.com/Garsson-io/kaizen/pull/42',
      });

      const output = processHookInput(input, defaultOpts);
      expect(output).toContain('KAIZEN_IMPEDIMENTS');
    });

    it('includes Agent tool instructions', () => {
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: 'https://github.com/Garsson-io/kaizen/pull/42',
      });

      const output = processHookInput(input, defaultOpts);
      expect(output).toContain('Agent');
      expect(output).toContain('kaizen-bg');
    });
  });

  describe('gh pr merge', () => {
    it('creates state file and returns merge reflection output', () => {
      const sendNotification = vi.fn();
      const input = makeInput({
        command:
          'gh pr merge https://github.com/Garsson-io/kaizen/pull/42 --squash --delete-branch --auto',
        stdout: '✓ Pull request merged',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        sendNotification,
      });

      expect(output).not.toBeNull();
      expect(output).toContain('KAIZEN REFLECTION');
      expect(output).toContain('Post-Merge');
      expect(output).toContain('kaizen-bg');
      expect(output).toContain('post-merge steps');
    });

    it('loads merge changed files through the gh argv seam', () => {
      const gh = vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'diff') {
          return 'src/hooks/kaizen-reflect.ts\nsrc/lib/gh-exec.ts';
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return 'Shared gh helper';
        }
        return '';
      });
      const input = makeInput({
        command: 'gh pr merge 42 --repo Garsson-io/kaizen --squash',
        stdout: '✓ Pull request merged',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        changedFiles: undefined,
        gh,
        sendNotification: vi.fn(),
      });

      expect(output).toContain('src/hooks/kaizen-reflect.ts');
      expect(output).toContain('src/lib/gh-exec.ts');
      expect(gh).toHaveBeenCalledWith([
        'pr',
        'diff',
        '42',
        '--name-only',
        '--repo',
        'Garsson-io/kaizen',
      ]);
    });

    it('routes hook timing through the injected seam', () => {
      const runHookTimingSentinel = vi.fn(() => 'TIMING REPORT');
      const input = makeInput({
        command: 'gh pr merge 42 --repo Garsson-io/kaizen --squash',
        stdout: '✓ Pull request merged',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        changedFiles: 'src/a.ts\nsrc/b.ts',
        runHookTimingSentinel,
      });

      expect(runHookTimingSentinel).toHaveBeenCalledWith('src/a.ts\nsrc/b.ts');
      expect(output).toContain('TIMING REPORT');
    });

    it('sends Telegram notification on merge', () => {
      const sendNotification = vi.fn();
      const input = makeInput({
        command:
          'gh pr merge https://github.com/Garsson-io/kaizen/pull/42 --squash',
        stdout: '✓ Pull request merged',
      });

      processHookInput(input, { ...defaultOpts, sendNotification });

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('PR merged'),
      );
    });

    it('loads merge notification title through the gh argv seam', () => {
      const sendNotification = vi.fn();
      const gh = vi.fn((args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'diff') {
          return 'src/hooks/kaizen-reflect.ts';
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return 'Use shared gh helper';
        }
        return '';
      });
      const input = makeInput({
        command:
          'gh pr merge https://github.com/Garsson-io/kaizen/pull/42 --squash',
        stdout: '✓ Pull request merged',
      });

      processHookInput(input, {
        ...defaultOpts,
        changedFiles: undefined,
        gh,
        sendNotification,
      });

      expect(gh).toHaveBeenCalledWith([
        'pr',
        'view',
        '42',
        '--repo',
        'Garsson-io/kaizen',
        '--json',
        'title',
        '--jq',
        '.title',
      ]);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('Use shared gh helper'),
      );
    });
  });

  describe('non-PR commands', () => {
    it('returns null for non-PR commands', () => {
      const input = makeInput({
        command: 'npm run build',
        stdout: 'done',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });

    it('returns null for echo containing gh pr', () => {
      const input = makeInput({
        command: 'echo "gh pr create --title test"',
        stdout: '',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });
  });

  describe('failed commands', () => {
    it('returns null for failed pr create', () => {
      const input = makeInput({
        command: 'gh pr create --title test',
        exit_code: 1,
        stderr: 'error',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });
  });

  describe('empty PR URL', () => {
    it('returns null when PR URL cannot be extracted', () => {
      const input = makeInput({
        command: 'gh pr create --title test',
        stdout: 'Created pull request',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        repoFromGit: undefined,
      });

      expect(output).toBeNull();
    });
  });

  describe('duplicate reflection prevention', () => {
    it('skips reflection when already done for this PR', async () => {
      const prUrl = 'https://github.com/Garsson-io/kaizen/pull/42';
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: prUrl,
      });

      // First call should produce output
      const output1 = processHookInput(input, defaultOpts);
      expect(output1).not.toBeNull();

      // Simulate marking reflection done
      const { markReflectionDone } = await import('./state-utils.js');
      markReflectionDone(prUrl, 'feat-test', TEST_STATE_DIR);

      // Second call should be skipped
      const output2 = processHookInput(input, defaultOpts);
      expect(output2).toBeNull();
    });
  });
});

describe('git runner invariant', () => {
  it('routes kaizen-reflect git reads through argv-style gitStdout calls', () => {
    const source = readFileSync(new URL('./kaizen-reflect.ts', import.meta.url), 'utf-8');

    expect(source).not.toMatch(/execSync\(['"`]git\b/);
    expect(source).toContain("gitStdout(['remote', 'get-url', 'origin'])");
    expect(source).toContain('currentHookBranch');
    expect(source).toContain("from './lib/current-branch.js'");
    expect(source).not.toContain('function getCurrentBranch()');
    expect(source).not.toContain("gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown')");
    expect(source).toContain("gitStdout(['diff', '--name-only', 'main...HEAD'])");
    expect(source).toContain("gitStdout(['worktree', 'list', '--porcelain'], '.')");
  });
});

describe('generateCreateReflection', () => {
  it('includes PR URL and branch', () => {
    const output = generateCreateReflection(
      'https://github.com/test/repo/pull/1',
      'feat-branch',
      'file1.ts\nfile2.ts',
    );
    expect(output).toContain('pull/1');
    expect(output).toContain('feat-branch');
    expect(output).toContain('file1.ts');
  });

  it('mentions gate clearing mechanism (#794)', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('#794');
    expect(output).toContain('gate');
  });

  it('includes KAIZEN_NO_ACTION categories', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('docs-only');
    expect(output).toContain('trivial-refactor');
  });

  it('includes compound improvement prompt (#264)', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('Compound improvements');
    expect(output).toContain('type: "positive"');
  });

  it('includes transcript_path when provided', () => {
    const output = generateCreateReflection(
      'url',
      'branch',
      'files',
      '/home/user/.claude/sessions/abc123.jsonl',
    );
    expect(output).toContain('Session transcript: /home/user/.claude/sessions/abc123.jsonl');
    expect(output).toContain('Read the transcript file');
    expect(output).toContain('user corrections');
    expect(output).toContain('failed tool calls');
  });

  it('shows fallback message when no transcript_path', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('no transcript path available');
  });
});

describe('generateMergeReflection', () => {
  it('includes post-merge steps', () => {
    const output = generateMergeReflection('url', 'branch', 'files', '/main');
    expect(output).toContain('post-merge steps');
    expect(output).toContain('Sync main');
    expect(output).toContain('/main');
  });

  it('includes compound improvement prompt (#264)', () => {
    const output = generateMergeReflection('url', 'branch', 'files', '/main');
    expect(output).toContain('Compound improvements');
    expect(output).toContain('type: "positive"');
  });

  it('includes transcript_path when provided', () => {
    const output = generateMergeReflection(
      'url',
      'branch',
      'files',
      '/main',
      '/tmp/transcript.jsonl',
    );
    expect(output).toContain('Session transcript: /tmp/transcript.jsonl');
    expect(output).toContain('Read the transcript file');
  });

  it('shows fallback message when no transcript_path', () => {
    const output = generateMergeReflection('url', 'branch', 'files', '/main');
    expect(output).toContain('no transcript path available');
  });
});

describe('transcript_path threading', () => {
  it('processHookInput passes transcript_path from input to create reflection', () => {
    const input = makeInput({
      command: 'gh pr create --title "test"',
      stdout: 'https://github.com/Garsson-io/kaizen/pull/42',
      transcript_path: '/sessions/test-session.jsonl',
    });

    const output = processHookInput(input, defaultOpts);
    expect(output).toContain('Session transcript: /sessions/test-session.jsonl');
  });

  it('processHookInput passes transcript_path from input to merge reflection', () => {
    const input = makeInput({
      command:
        'gh pr merge https://github.com/Garsson-io/kaizen/pull/42 --squash',
      stdout: '✓ Pull request merged',
      transcript_path: '/sessions/merge-session.jsonl',
    });

    const output = processHookInput(input, {
      ...defaultOpts,
      sendNotification: vi.fn(),
    });
    expect(output).toContain('Session transcript: /sessions/merge-session.jsonl');
  });

  it('processHookInput handles missing transcript_path gracefully', () => {
    const input = makeInput({
      command: 'gh pr create --title "test"',
      stdout: 'https://github.com/Garsson-io/kaizen/pull/42',
    });

    const output = processHookInput(input, defaultOpts);
    expect(output).toContain('no transcript path available');
  });
});
