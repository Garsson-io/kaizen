/**
 * issue-binding.test.ts — per-worktree kaizen.issue binding (#1111).
 *
 * Two layers:
 *  - Unit: drive the pure functions with a scripted GitRun stub, no real git.
 *  - Integration: real temp git repo with two worktrees, proving a binding in
 *    one worktree cannot leak to or clobber a sibling (the #1111 provisioning
 *    guarantee).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type GitResult,
  type GitRun,
  bindIssue,
  detectLeak,
  ensureWorktreeConfig,
  makeGitRun,
  readBoundIssue,
  sharedIssue,
  unsetSharedIssue,
  worktreeScopedIssue,
} from './issue-binding.js';

// ── Unit: scripted GitRun stub ──────────────────────────────────────

/**
 * Minimal in-memory git config model: distinguishes shared (`--local`) from
 * worktree (`--worktree`) scope and a merged read (worktree wins). Enough to
 * exercise the binding logic without a real repo.
 */
function makeStub(initial: {
  worktreeConfig?: boolean;
  shared?: number | null;
  worktree?: number | null;
  branch?: string;
}): { run: GitRun; state: Required<typeof initial> } {
  const state = {
    worktreeConfig: initial.worktreeConfig ?? false,
    shared: initial.shared ?? null,
    worktree: initial.worktree ?? null,
    branch: initial.branch ?? 'main',
  };
  const ok = (stdout = ''): GitResult => ({ stdout, code: 0 });
  const fail = (): GitResult => ({ stdout: '', code: 1 });

  const run: GitRun = (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return ok(state.branch);
    if (a === 'config --get extensions.worktreeConfig') {
      return state.worktreeConfig ? ok('true') : fail();
    }
    if (a === 'config extensions.worktreeConfig true') {
      state.worktreeConfig = true;
      return ok();
    }
    if (a.startsWith('config --worktree kaizen.issue ')) {
      state.worktree = Number(args[args.length - 1]);
      return ok();
    }
    if (a === 'config --worktree --get kaizen.issue') {
      return state.worktree != null ? ok(String(state.worktree)) : fail();
    }
    if (a === 'config --local --get kaizen.issue') {
      return state.shared != null ? ok(String(state.shared)) : fail();
    }
    if (a === 'config --local --unset kaizen.issue') {
      const had = state.shared != null;
      state.shared = null;
      return had ? ok() : { stdout: '', code: 5 };
    }
    if (a === 'config --get kaizen.issue') {
      // Merged view: worktree wins over shared.
      const v = state.worktree ?? state.shared;
      return v != null ? ok(String(v)) : fail();
    }
    return fail();
  };
  return { run, state: state as Required<typeof initial> };
}

describe('ensureWorktreeConfig', () => {
  it('enables when off and reports the change', () => {
    const { run, state } = makeStub({ worktreeConfig: false });
    expect(ensureWorktreeConfig(run)).toBe(true);
    expect(state.worktreeConfig).toBe(true);
  });

  it('is idempotent when already on', () => {
    const { run } = makeStub({ worktreeConfig: true });
    expect(ensureWorktreeConfig(run)).toBe(false);
  });
});

describe('bindIssue', () => {
  it('writes a worktree-scoped value, leaving shared untouched', () => {
    const { run, state } = makeStub({ shared: 1106 });
    const r = bindIssue(1111, run);
    expect(r.issue).toBe(1111);
    expect(r.enabledWorktreeConfig).toBe(true);
    expect(state.worktree).toBe(1111);
    expect(state.shared).toBe(1106); // shared not clobbered
    expect(readBoundIssue(run)).toBe(1111); // merged view sees the worktree value
  });

  it('rejects a non-positive issue rather than writing a bad binding', () => {
    const { run } = makeStub({});
    expect(() => bindIssue(0, run)).toThrow();
    expect(() => bindIssue(-3, run)).toThrow();
    // @ts-expect-error — exercising the runtime guard
    expect(() => bindIssue('7', run)).toThrow();
  });
});

describe('reads', () => {
  it('worktreeScopedIssue is null when only shared is set', () => {
    const { run } = makeStub({ shared: 1106 });
    expect(worktreeScopedIssue(run)).toBeNull();
    expect(sharedIssue(run)).toBe(1106);
    expect(readBoundIssue(run)).toBe(1106);
  });
});

describe('unsetSharedIssue', () => {
  it('removes a shared value and reports it', () => {
    const { run, state } = makeStub({ shared: 1106 });
    expect(unsetSharedIssue(run)).toBe(true);
    expect(state.shared).toBeNull();
  });
  it('is tolerant when there is nothing to remove', () => {
    const { run } = makeStub({ shared: null });
    expect(unsetSharedIssue(run)).toBe(false);
  });
});

describe('detectLeak', () => {
  it('flags an inherited shared value that disagrees with the case branch', () => {
    const { run } = makeStub({ shared: 1106 });
    const r = detectLeak('case/260626-k1111-foo', run);
    expect(r.leaked).toBe(true);
    expect(r.merged).toBe(1106);
    expect(r.branchToken).toBe(1111);
    expect(r.worktreeScoped).toBeNull();
  });

  it('flags any inherited value on a non-case branch (no token to vouch for it)', () => {
    const { run } = makeStub({ shared: 1106 });
    expect(detectLeak('worktree-2606261147-fd0e', run).leaked).toBe(true);
  });

  it('does not flag when the worktree owns its binding', () => {
    const { run } = makeStub({ shared: 1106, worktree: 1111, worktreeConfig: true });
    // worktree-scoped present → not a provisioning leak, even vs a stale shared.
    expect(detectLeak('case/260626-k1111-foo', run).leaked).toBe(false);
  });

  it('does not flag when an inherited value matches the branch token', () => {
    const { run } = makeStub({ shared: 1111 });
    expect(detectLeak('case/260626-k1111-foo', run).leaked).toBe(false);
  });

  it('does not flag when nothing is bound', () => {
    const { run } = makeStub({});
    expect(detectLeak('worktree-abc', run).leaked).toBe(false);
  });
});

// ── Integration: real git worktrees prove cross-worktree isolation ──

describe('integration: real worktrees do not leak bindings', () => {
  let root: string;
  let mainRepo: string;
  let wtA: string;
  let wtB: string;

  const git = (cwd: string, args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf-8' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'kaizen-binding-'));
    mainRepo = join(root, 'main');
    git(root, ['init', '-q', 'main']);
    git(mainRepo, ['config', 'user.email', 'test@example.com']);
    git(mainRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(mainRepo, 'f.txt'), 'hi\n');
    git(mainRepo, ['add', '.']);
    git(mainRepo, ['commit', '-q', '-m', 'init']);

    // A prior run wrote a binding the OLD way — into shared config.
    git(mainRepo, ['config', 'kaizen.issue', '1106']);

    wtA = join(root, 'wtA');
    wtB = join(root, 'wtB');
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'case/260626-k950-a', wtA]);
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'case/260626-k1111-b', wtB]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a fresh worktree inherits the stale shared binding (the bug)', () => {
    // Before any per-worktree binding, both worktrees read the leaked 1106.
    expect(readBoundIssue(makeGitRun(wtA))).toBe(1106);
    expect(readBoundIssue(makeGitRun(wtB))).toBe(1106);
    expect(detectLeak('case/260626-k1111-b', makeGitRun(wtB)).leaked).toBe(true);
  });

  it('bindIssue scopes per worktree — A and B stay independent (the fix)', () => {
    const runA = makeGitRun(wtA);
    const runB = makeGitRun(wtB);

    bindIssue(950, runA);
    bindIssue(1111, runB);

    expect(readBoundIssue(runA)).toBe(950);
    expect(readBoundIssue(runB)).toBe(1111);
    expect(worktreeScopedIssue(runA)).toBe(950);
    expect(worktreeScopedIssue(runB)).toBe(1111);

    // Neither leaks; neither is a provisioning leak anymore.
    expect(detectLeak('case/260626-k950-a', runA).leaked).toBe(false);
    expect(detectLeak('case/260626-k1111-b', runB).leaked).toBe(false);

    // Re-binding A does not disturb B.
    bindIssue(777, runA);
    expect(readBoundIssue(runA)).toBe(777);
    expect(readBoundIssue(runB)).toBe(1111);
  });
});
