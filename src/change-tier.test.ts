/**
 * change-tier.test.ts — Unit tests for the proportional-ceremony tier
 * contract (#1748). Pure functions, no git.
 */

import { describe, expect, it } from 'vitest';
import {
  parseChangeTier,
  isEnforcementSurface,
  verifyTrivialTier,
  checkMiniPlanSubstance,
  TRIVIAL_LIMITS,
} from './change-tier.js';

describe('parseChangeTier', () => {
  it.each([
    ['trivial', 'trivial'],
    ['  TRIVIAL ', 'trivial'],
    ['standard', 'standard'],
    ['', 'standard'],
    ['tiny', 'standard'],
    ['trivial; rm -rf', 'standard'],
  ])('parses %j as %s', (raw, expected) => {
    expect(parseChangeTier(raw)).toBe(expected);
  });

  it('null and undefined fall to the stricter bar', () => {
    expect(parseChangeTier(null)).toBe('standard');
    expect(parseChangeTier(undefined)).toBe('standard');
  });
});

describe('isEnforcementSurface', () => {
  it.each([
    'src/hooks/enforce-plan-stored.ts',
    '.claude/hooks/kaizen-worktree-setup.sh',
    '.githooks/pre-push',
    '.claude-plugin/plugin.json',
    '.agents/skills/kaizen-do/SKILL.md',
    '.agents/kaizen/policies.md',
    '.claude/skills/kaizen-wip/SKILL.md',
    '.codex/skills/kaizen-wip/SKILL.md',
    '.gemini/skills/kaizen-wip/SKILL.md',
    '.opencode/skills/kaizen-wip/SKILL.md',
    'prompts/review-correctness.md',
    'src/change-tier.ts',
    'src/case-system.ts',
    'src/review-sentinel.ts',
    '.claude/settings.json',
    './src/hooks/pre-push.ts',
  ])('flags %s', (path) => {
    expect(isEnforcementSurface(path)).toBe(true);
  });

  it.each([
    'src/structured-data.ts',
    'scripts/auto-dent.ts',
    'docs/hooks-design.md',
    'README.md',
    'src/hooks-adjacent.ts',
  ])('passes %s', (path) => {
    expect(isEnforcementSurface(path)).toBe(false);
  });
});

describe('verifyTrivialTier', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.ts`);

  it('accepts a diff exactly at the limits (boundary)', () => {
    const r = verifyTrivialTier(files(TRIVIAL_LIMITS.maxFiles), {
      files: TRIVIAL_LIMITS.maxFiles,
      lines: TRIVIAL_LIMITS.maxLines,
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('rejects one file over the limit', () => {
    const r = verifyTrivialTier(files(5), { files: 5, lines: 20 });
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toContain('5 changed files');
  });

  it('rejects one line over the limit', () => {
    const r = verifyTrivialTier(files(2), { files: 2, lines: TRIVIAL_LIMITS.maxLines + 1 });
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toContain('81 changed lines');
  });

  it('rejects any enforcement-surface file and names it', () => {
    const r = verifyTrivialTier(['src/ok.ts', 'src/hooks/pre-push.ts'], { files: 2, lines: 10 });
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toContain('src/hooks/pre-push.ts');
  });

  it('reports ALL violations, not just the first', () => {
    const r = verifyTrivialTier(['prompts/review-x.md', ...files(9)], { files: 10, lines: 500 });
    expect(r.violations.length).toBe(3);
  });
});

describe('checkMiniPlanSubstance', () => {
  const GOOD_MINI = 'Rename the stale /kaizen reference in the wip skill doc to /kaizen-reflect '
    + 'so the trigger list matches the shipped skill name. Verify: existing skill-doc lint test passes.';

  it('accepts a real mini plan', () => {
    expect(checkMiniPlanSubstance(GOOD_MINI)).toEqual([]);
  });

  it('rejects a too-short plan', () => {
    const failures = checkMiniPlanSubstance('Fix the bug. Verify with tests.');
    expect(failures.join()).toContain('too short');
  });

  it('rejects a plan with no verification mention', () => {
    const failures = checkMiniPlanSubstance(
      'Rename the stale reference in the wip skill doc so the trigger list matches the shipped '
      + 'skill name and update the surrounding sentence for grammar.',
    );
    expect(failures.join()).toContain('verified');
  });

  it('reports both failures independently', () => {
    expect(checkMiniPlanSubstance('do stuff')).toHaveLength(2);
  });

  it('boundary: exactly 120 trimmed chars with a verification mention passes', () => {
    const base = 'Verify: unit test covers it. ';
    const plan = base + 'x'.repeat(120 - base.length);
    expect(plan.trim().length).toBe(120);
    expect(checkMiniPlanSubstance(plan)).toEqual([]);
    expect(checkMiniPlanSubstance(plan.slice(0, 119)).join()).toContain('too short');
  });
});
