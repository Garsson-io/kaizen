/**
 * change-tier.test.ts — Unit tests for the proportional-ceremony tier
 * contract (#1748). Pure functions, no git.
 */

import { describe, expect, it } from 'vitest';
import {
  expandRenamePaths,
  parseChangeTier,
  parseNumstat,
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
    'src/change-tier.test.ts',
    'src/case-system.test.ts',
    'src/review-sentinel.test.ts',
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

describe('expandRenamePaths', () => {
  it('plain paths pass through', () => {
    expect(expandRenamePaths('src/a.ts')).toEqual(['src/a.ts']);
  });

  it('braced renames expand to old AND new concrete paths', () => {
    expect(expandRenamePaths('src/{other/moved.ts => hooks/newhook.ts}'))
      .toEqual(['src/other/moved.ts', 'src/hooks/newhook.ts']);
  });

  it('empty-side braces collapse double slashes', () => {
    expect(expandRenamePaths('src/{ => hooks}/x.ts')).toEqual(['src/x.ts', 'src/hooks/x.ts']);
  });

  it('unbraced renames split on the arrow', () => {
    expect(expandRenamePaths('old.ts => src/hooks/new.ts')).toEqual(['old.ts', 'src/hooks/new.ts']);
  });

  it("a filename containing ' => ' cannot hide the real rename target", () => {
    // git emits this unquoted for a file literally named 'weird => name.ts'
    // renamed into src/hooks/ — every split candidate is emitted, so the
    // hook path is always among them.
    const paths = expandRenamePaths('weird => name.ts => src/hooks/newhook.ts');
    expect(paths).toContain('src/hooks/newhook.ts');
    expect(paths.some(isEnforcementSurface)).toBe(true);
  });

  it("braced renames with ' => ' inside the filename still surface the hook side", () => {
    const paths = expandRenamePaths('src/{weird => name.ts => hooks/new.ts}');
    expect(paths).toContain('src/hooks/new.ts');
  });
});

describe('parseNumstat', () => {
  it('rename rows expand so a rename INTO the surface is visible to the prefix match', () => {
    const totals = parseNumstat('4\t1\tsrc/{other/moved.ts => hooks/newhook.ts}');
    expect(totals.files).toBe(1);
    expect(totals.paths).toEqual(['src/other/moved.ts', 'src/hooks/newhook.ts']);
  });

  it('sums adds+dels across rows, counts files, and carries the snapshot paths', () => {
    expect(parseNumstat('10\t5\tsrc/a.ts\n3\t0\tsrc/b.ts'))
      .toEqual({ files: 2, lines: 18, paths: ['src/a.ts', 'src/b.ts'] });
  });

  it("counts binary '-' sentinel rows as 0 lines but 1 file", () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n2\t1\tsrc/a.ts'))
      .toEqual({ files: 2, lines: 3, paths: ['assets/logo.png', 'src/a.ts'] });
  });

  it('empty output → zero totals', () => {
    expect(parseNumstat('')).toEqual({ files: 0, lines: 0, paths: [] });
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

  it("does not accept incidental words like 'testament' as a verification mention", () => {
    const failures = checkMiniPlanSubstance(
      'Rename the stale reference in the wip skill doc — a testament to tidy docs — so the '
      + 'trigger list matches the shipped skill name everywhere it appears in the document.',
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
