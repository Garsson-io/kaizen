/**
 * worktree-isolation.test.ts — Category prevention tests for worktree lifecycle blindness.
 *
 * These tests catch the whole class of "system assumes CWD is stable" bugs (#939).
 * Adding .claude/worktrees to vitest exclude prevents cross-worktree test contamination (#938).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VITEST_CONFIG = resolve(__dirname, '../vitest.config.ts');

describe('vitest config — worktree isolation (#938, #939)', () => {
  it('excludes .claude/worktrees from test discovery', () => {
    // INVARIANT: test files inside active worktrees must never be picked up
    // by npm test in the main checkout. 94 worktrees × their test files = noise.
    const config = readFileSync(VITEST_CONFIG, 'utf8');

    // The exclude array must contain a pattern that excludes worktree directories
    expect(config).toMatch(/['"]\.claude\/worktrees['"]/);
  });

  it('exclude list contains node_modules, dist, .kaizen, and .claude/worktrees', () => {
    // INVARIANT: the exclusion list must not regress. All four patterns are required.
    const config = readFileSync(VITEST_CONFIG, 'utf8');

    // Extract the exclude array content (between exclude: [ ... ])
    const excludeMatch = config.match(/exclude\s*:\s*\[([^\]]+)\]/s);
    expect(excludeMatch).not.toBeNull();
    const excludeContent = excludeMatch![1];

    expect(excludeContent).toMatch(/node_modules/);
    expect(excludeContent).toMatch(/dist/);
    expect(excludeContent).toMatch(/\.kaizen/);
    expect(excludeContent).toMatch(/\.claude\/worktrees/);
  });
});
