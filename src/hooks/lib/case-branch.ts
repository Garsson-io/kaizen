/**
 * case-branch.ts — parse the canonical kaizen case-branch shape.
 *
 * Lives in `hooks/lib/` (a shared primitive) so both the plan-gate hook and
 * non-hook modules (e.g. `src/issue-binding.ts`) can reuse it without crossing
 * the #923 architectural boundary that forbids importing hook *entry points*.
 */

/**
 * Parse the issue number from a canonical case branch (`case/<date>-k<N>-<slug>`,
 * e.g. `case/260626-k950-outcome-verification`). Returns null for ANY other
 * branch shape (main, feature/*, worktree-*, bare k<N>-*), so it never misfires
 * on names the case system did not create. This anchored, case-prefixed match is
 * what makes the result safe to trust as a cross-check rather than a guess.
 */
export function extractCaseIssueFromBranch(branch: string): string | null {
  const m = branch.match(/^case\/\d{6,}-k(\d+)(?:-|$)/);
  return m ? m[1] : null;
}
