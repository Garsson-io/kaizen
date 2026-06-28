/**
 * case-branch.test.ts — direct contract test for `extractCaseIssueFromBranch` (#1193).
 *
 * This parser is the load-bearing cross-check for the #1106 plan-gate fix:
 * `enforce-plan-stored.ts` uses it to verify the declared `kaizen.issue` matches
 * the canonical case-branch token and FAILS CLOSED on mismatch. It is also the
 * basis of the per-worktree binding self-heal in `issue-binding.ts` (#1111).
 *
 * Before this file the function was covered only INDIRECTLY (via the binding
 * suite), so a regex regression could silently weaken the gate (false-null →
 * over-block) or break it (false-match → gate passes the wrong issue) while the
 * suite stayed green. The cases below pin every documented edge the regex
 * `^case\/\d{6,}-k(\d+)(?:-|$)` decides.
 */

import { describe, expect, it } from 'vitest';

import { extractCaseIssueFromBranch } from './case-branch.js';

describe('extractCaseIssueFromBranch', () => {
  describe('matches and extracts the issue number', () => {
    const matches: Array<[string, string]> = [
      // Happy path: canonical `case/<date>-k<N>-<slug>`.
      ['case/260626-k950-outcome-verification', '950'],
      // Slug-less branch terminated by `$` (the `(?:-|$)` alternative).
      ['case/260626-k950', '950'],
      // Multi-digit issue numbers.
      ['case/260626-k12345-x', '12345'],
      ['case/260626-k12345', '12345'],
      // Single-digit issue number at the `\d{6,}` date lower bound.
      ['case/123456-k7-z', '7'],
      // Longer (timestamped) date prefixes still satisfy `\d{6,}`.
      ['case/2606261200-k950-x', '950'],
    ];

    it.each(matches)('%s -> %s', (branch, expected) => {
      expect(extractCaseIssueFromBranch(branch)).toBe(expected);
    });
  });

  describe('returns null for any other branch shape', () => {
    const nonMatches: Array<[string, string]> = [
      // `\d{6,}` lower boundary: a 5-digit date must NOT match.
      ['case/26-k950-x', '5-digit date below the \\d{6,} bound'],
      ['case/12345-k7', '5-digit date below the \\d{6,} bound (no slug)'],
      // `^` anchor: the token must not be matched as a substring.
      ['feature/case/260626-k950-x', 'not anchored at start (prefixed)'],
      [' case/260626-k950', 'leading whitespace defeats the ^ anchor'],
      // Missing / non-numeric issue token after `-k`.
      ['case/260626-kfoo', 'non-numeric issue token'],
      ['case/260626-k', 'no issue number at all'],
      ['case/260626-k-slug', 'dash where the number should be'],
      // Separator discipline: the number must be followed by `-` or end.
      ['case/260626-k950x', 'number not terminated by - or end of string'],
      // Date present but `-k` segment missing entirely.
      ['case/260626-outcome', 'no -k segment'],
      // Non-case branch shapes the case system never produces.
      ['k950-slug', 'bare k<N> branch'],
      ['worktree-2606281815-7b6c', 'auto-dent worktree branch'],
      ['main', 'default branch'],
      ['', 'empty string'],
    ];

    it.each(nonMatches)('%s -> null (%s)', (branch) => {
      expect(extractCaseIssueFromBranch(branch)).toBeNull();
    });
  });
});
