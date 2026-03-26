/**
 * worktree-isolation.test.ts — Category prevention tests.
 *
 * Two categories:
 * 1. Worktree lifecycle blindness (#939): vitest config excludes .claude/worktrees
 * 2. Skill-CLI contract drift (#966): skills must reference the store-review-* CLI commands
 *    they depend on, so review findings are posted to PRs and the gate guard passes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VITEST_CONFIG = resolve(__dirname, '../vitest.config.ts');
const REVIEW_PR_SKILL = resolve(__dirname, '../.claude/skills/kaizen-review-pr/SKILL.md');
const IMPLEMENT_SKILL = resolve(__dirname, '../.claude/skills/kaizen-implement/SKILL.md');

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

// ── Skill-CLI contract: review findings storage (#966) ──────────────────────
// These tests verify that skills referencing the review battery also reference
// the CLI commands that store findings. Without these references, findings are
// collected in-context but never posted to PRs and lost on session end.

describe('kaizen-review-pr SKILL.md — review findings storage contract (#966)', () => {
  it('references store-review-batch or store-review-finding', () => {
    // INVARIANT: the review skill must instruct the agent to persist per-dimension
    // findings as PR marker comments. Without this, findings live only in session
    // memory and disappear when the session ends or the worktree is deleted.
    const skill = readFileSync(REVIEW_PR_SKILL, 'utf8');
    expect(skill).toMatch(/store-review-batch|store-review-finding/);
  });

  it('references store-review-summary', () => {
    // INVARIANT: the review skill must call store-review-summary to write the
    // review sentinel. Without the sentinel, the pr-review-loop gate guard blocks
    // and the agent is forced to use KAIZEN_UNFINISHED to bypass it.
    const skill = readFileSync(REVIEW_PR_SKILL, 'utf8');
    expect(skill).toMatch(/store-review-summary/);
  });
});

describe('kaizen-implement SKILL.md — review battery storage reference (#966)', () => {
  it('references store-review-batch or store-review-finding in review task', () => {
    // INVARIANT: the implement skill's review battery task must reference finding
    // storage so implementing agents don't silently skip it.
    const skill = readFileSync(IMPLEMENT_SKILL, 'utf8');
    expect(skill).toMatch(/store-review-batch|store-review-finding/);
  });
});
