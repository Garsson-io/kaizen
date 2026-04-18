import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSetupFiles } from './hook-gym-harness.js';

// seedSetupFiles writes scenario-level files into the fixture repo and
// commits them. Covers the behavior the `install-git-hooks-skill` scenario
// relies on: framework detection requires `.pre-commit-config.yaml` to be
// present before the agent turns.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'seed@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'seed'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], { cwd: dir });
  return dir;
}

describe('seedSetupFiles', () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes files, commits them, and reports the count', () => {
    const res = seedSetupFiles(dir, 'scn', {
      '.pre-commit-config.yaml': 'repos: []\n',
      'nested/file.txt': 'hi\n',
    });
    expect(res).toEqual({ wrote: 2, committed: true });
    expect(readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf-8')).toBe('repos: []\n');
    expect(readFileSync(join(dir, 'nested/file.txt'), 'utf-8')).toBe('hi\n');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf-8' });
    expect(log).toMatch(/chore: seed files for scn \(hook-gym\)/);
  });

  it('is idempotent — a second run with identical content makes no commit', () => {
    seedSetupFiles(dir, 'scn', { 'a.yaml': 'x\n' });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();

    const res = seedSetupFiles(dir, 'scn', { 'a.yaml': 'x\n' });
    expect(res).toEqual({ wrote: 0, committed: false });

    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('refuses paths that escape the fixture dir', () => {
    const logs: unknown[][] = [];
    const res = seedSetupFiles(dir, 'scn', { '../escape.txt': 'bad\n' }, (...a) => logs.push(a));
    expect(res.wrote).toBe(0);
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
    expect(logs.some((l) => String(l[0]).includes('refusing setupFile escape'))).toBe(true);
  });
});
