/**
 * worktree-setup.test.ts — Tests for kaizen-worktree-setup.sh
 *
 * INVARIANTS:
 *   1. In a worktree missing node_modules/dist: symlinks created pointing at main repo
 *   2. In the main checkout (git-common-dir == .git): no symlinks created
 *   3. Idempotent: second run with existing symlinks is a no-op
 *   4. Real dirs (e.g. after npm install) are not replaced with symlinks
 *   5. Only missing artifacts are symlinked — existing real dirs left alone
 *   6. git failure (not in a git repo): exits 0 without creating symlinks
 *   7. main repo missing artifact: no symlink created, exits 0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockDir, type MockDir } from '../e2e/hook-runner.js';

const HOOK = resolve(__dirname, '../../.claude/hooks/kaizen-worktree-setup.sh');

/** Write a git mock that returns the given path for --git-common-dir */
function setGitCommonDir(mockDir: MockDir, commonDir: string): void {
  const script = `#!/bin/bash\ncase "$*" in\n  *"rev-parse --git-common-dir"*) echo "${commonDir}"; exit 0 ;;\n  *) /usr/bin/git "$@" ;;\nesac\n`;
  writeFileSync(join(mockDir.path, 'git'), script, { mode: 0o755 });
}

/** Write a git mock that exits non-zero (simulates "not a git repo") */
function setGitFails(mockDir: MockDir): void {
  const script = `#!/bin/bash\nexit 128\n`;
  writeFileSync(join(mockDir.path, 'git'), script, { mode: 0o755 });
}

function runSetupHook(cwd: string, mockDir: MockDir): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [HOOK], {
    cwd,
    env: { ...process.env, PATH: mockDir.pathWithMocks },
    encoding: 'utf-8',
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('kaizen-worktree-setup.sh', () => {
  let mainRepo: string;
  let mainGitDir: string;

  beforeEach(() => {
    mainRepo = mkdtempSync(join(tmpdir(), 'kaizen-main-'));
    mainGitDir = join(mainRepo, '.git');
    mkdirSync(join(mainRepo, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(mainRepo, 'dist', 'hooks'), { recursive: true });
    mkdirSync(mainGitDir);
  });

  afterEach(() => {
    rmSync(mainRepo, { recursive: true, force: true });
  });

  describe('Invariant 1: creates symlinks in a fresh worktree', () => {
    it('creates both node_modules and dist symlinks pointing at main repo', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        setGitCommonDir(mockDir, mainGitDir);
        const { exitCode } = runSetupHook(wdir, mockDir);
        expect(exitCode).toBe(0);
        expect(readlinkSync(join(wdir, 'node_modules'))).toBe(join(mainRepo, 'node_modules'));
        expect(readlinkSync(join(wdir, 'dist'))).toBe(join(mainRepo, 'dist'));
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 2: skips main checkout', () => {
    it('exits 0 without creating symlinks when git-common-dir is .git', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        setGitCommonDir(mockDir, '.git');
        const { exitCode } = runSetupHook(wdir, mockDir);
        expect(exitCode).toBe(0);
        expect(() => readlinkSync(join(wdir, 'node_modules'))).toThrow();
        expect(() => readlinkSync(join(wdir, 'dist'))).toThrow();
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 3: idempotent', () => {
    it('second run leaves existing symlinks unchanged', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        setGitCommonDir(mockDir, mainGitDir);
        const firstRun = runSetupHook(wdir, mockDir);
        expect(firstRun.exitCode).toBe(0);
        const firstTarget = readlinkSync(join(wdir, 'node_modules'));
        const { exitCode } = runSetupHook(wdir, mockDir);
        expect(exitCode).toBe(0);
        expect(readlinkSync(join(wdir, 'node_modules'))).toBe(firstTarget);
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 4: real node_modules dir not replaced', () => {
    it('leaves existing real node_modules dir as-is', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        mkdirSync(join(wdir, 'node_modules', '.bin'), { recursive: true });
        setGitCommonDir(mockDir, mainGitDir);
        runSetupHook(wdir, mockDir);
        // Must still be a real directory, not replaced with a symlink
        expect(statSync(join(wdir, 'node_modules')).isDirectory()).toBe(true);
        expect(() => readlinkSync(join(wdir, 'node_modules'))).toThrow();
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 5: only missing artifacts are symlinked', () => {
    it('symlinks node_modules but not dist when dist is already a real dir', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        mkdirSync(join(wdir, 'dist', 'hooks'), { recursive: true });
        setGitCommonDir(mockDir, mainGitDir);
        runSetupHook(wdir, mockDir);
        expect(readlinkSync(join(wdir, 'node_modules'))).toBe(join(mainRepo, 'node_modules'));
        // dist must still be a real directory
        expect(statSync(join(wdir, 'dist')).isDirectory()).toBe(true);
        expect(() => readlinkSync(join(wdir, 'dist'))).toThrow();
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 7: main repo missing artifact — no symlink created', () => {
    it('exits 0 without creating symlink when main repo has no node_modules', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      // Main repo has dist but NOT node_modules
      rmSync(join(mainRepo, 'node_modules'), { recursive: true, force: true });
      try {
        setGitCommonDir(mockDir, mainGitDir);
        const { exitCode } = runSetupHook(wdir, mockDir);
        expect(exitCode).toBe(0);
        expect(() => readlinkSync(join(wdir, 'node_modules'))).toThrow();
        expect(readlinkSync(join(wdir, 'dist'))).toBe(join(mainRepo, 'dist'));
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });

  describe('Invariant 6: git failure — exits 0 without creating symlinks', () => {
    it('exits 0 and creates no symlinks when git is not available or fails', () => {
      const wdir = mkdtempSync(join(tmpdir(), 'kaizen-wt-'));
      const mockDir = createMockDir();
      try {
        setGitFails(mockDir);
        const { exitCode } = runSetupHook(wdir, mockDir);
        expect(exitCode).toBe(0);
        expect(() => readlinkSync(join(wdir, 'node_modules'))).toThrow();
        expect(() => readlinkSync(join(wdir, 'dist'))).toThrow();
      } finally {
        rmSync(wdir, { recursive: true, force: true });
        mockDir.cleanup();
      }
    });
  });
});
