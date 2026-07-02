/**
 * change-tier.ts — Proportional ceremony: the change-tier contract (#1748).
 *
 * A worktree may DECLARE its change trivial (`git config --worktree
 * kaizen.tier trivial`). Declaration relaxes the plan-substance bar at the
 * edit gate; the declaration is VERIFIED against the real diff at
 * `gh pr create` (outcome, not command — the #943/#1106 lesson). A change
 * that outgrew its declaration is blocked there, fail closed.
 *
 * Everything here is pure: callers inject file lists and diff totals, so the
 * module tests without git (see docs/hooks-design.md § testing conventions).
 */

export type ChangeTier = 'trivial' | 'standard';

/** Unknown/empty/garbage tier values fall to the STRICTER bar. */
export function parseChangeTier(raw: string | null | undefined): ChangeTier {
  return raw?.trim().toLowerCase() === 'trivial' ? 'trivial' : 'standard';
}

/**
 * Hard ceiling for a trivial change. maxLines is adds+dels across the whole
 * diff — sized so a small fix plus its co-committed test (I17) still fits
 * (p25 of all merged PRs is 64 changed lines).
 */
export const TRIVIAL_LIMITS = { maxFiles: 4, maxLines: 80 } as const;

/**
 * Paths where a change is never trivial: the enforcement machinery itself.
 * Prefix match on the repo-relative path. Kept intentionally conservative —
 * a false "enforcement surface" costs one full plan; a false "trivial" costs
 * an unreviewed hole in the gates.
 */
const ENFORCEMENT_SURFACE_PREFIXES = [
  'src/hooks/',
  '.claude/hooks/',
  '.githooks/',
  '.claude-plugin/',
  '.agents/skills/',
  '.agents/kaizen/',
  // Symlinked views of .agents/skills (agentsync layout) — an edit addressed
  // through any of them is a skills edit and must hit the same wall.
  '.claude/skills/',
  '.codex/skills/',
  '.gemini/skills/',
  '.opencode/skills/',
  'prompts/',
];

const ENFORCEMENT_SURFACE_FILES = new Set([
  'src/change-tier.ts',
  'src/change-tier.test.ts',
  'src/case-system.ts',
  'src/case-system.test.ts',
  'src/review-sentinel.ts',
  'src/review-sentinel.test.ts',
  // Hook registrations hot-reload from here — editing it IS editing the gates.
  '.claude/settings.json',
]);

/** True if this repo-relative path is part of the enforcement machinery. */
export function isEnforcementSurface(filePath: string): boolean {
  // Normalize Windows separators so platform-dependent path.relative()
  // output still matches the forward-slash prefixes.
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (ENFORCEMENT_SURFACE_FILES.has(normalized)) return true;
  return ENFORCEMENT_SURFACE_PREFIXES.some(p => normalized.startsWith(p));
}

export interface DiffTotals {
  files: number;
  /** Total changed lines: additions + deletions across the diff. */
  lines: number;
  /**
   * File paths from the SAME snapshot the totals came from. When present,
   * verifiers use these for the surface check so counts and surface matching
   * can never disagree across two git invocations (TOCTOU).
   */
  paths?: string[];
}

/**
 * Parse `git diff --numstat -z` (NUL-separated) output into totals + paths.
 * The -z format carries VERBATIM paths — no `{old => new}` munging, no
 * quoting — which categorically eliminates the filename-encoding ambiguity
 * class (filenames containing ' => ', braces, tabs, newlines cannot confuse
 * the parser). Entries are either `adds\tdels\tpath\0` or, for renames,
 * `adds\tdels\t\0old\0new\0`; BOTH rename sides count for surface matching
 * (a rename into src/hooks/ creates a hook, out of it removes one). Binary
 * files report "-" for adds/dels — 0 lines but 1 file. Pure so all of this
 * is testable outside the git-calling lambda.
 */
export function parseNumstat(numstat: string): DiffTotals {
  const fields = numstat.split('\0');
  let files = 0;
  let lines = 0;
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = fields[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    files++;
    lines += (parseInt(m[1], 10) || 0) + (parseInt(m[2], 10) || 0);
    if (m[3] !== '') {
      paths.push(m[3]);
    } else {
      // Rename entry: the next two NUL-separated fields are old, new.
      if (fields[i + 1]) paths.push(fields[i + 1]);
      if (fields[i + 2]) paths.push(fields[i + 2]);
      i += 2;
    }
  }
  return { files, lines, paths };
}

export interface TierVerification {
  ok: boolean;
  violations: string[];
}

/**
 * Verify a `trivial` declaration against the actual diff. Every violation is
 * reported (not just the first) so the author sees the full distance to the
 * bar in one round.
 */
export function verifyTrivialTier(changedFiles: string[], totals: DiffTotals): TierVerification {
  const violations: string[] = [];
  if (totals.files > TRIVIAL_LIMITS.maxFiles) {
    violations.push(`${totals.files} changed files (trivial allows ≤ ${TRIVIAL_LIMITS.maxFiles})`);
  }
  if (totals.lines > TRIVIAL_LIMITS.maxLines) {
    violations.push(`${totals.lines} changed lines (trivial allows ≤ ${TRIVIAL_LIMITS.maxLines})`);
  }
  const surface = changedFiles.filter(isEnforcementSurface);
  for (const f of surface) {
    violations.push(`touches enforcement surface: ${f}`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The mini-plan bar for trivial changes: the stored plan must still exist and
 * must say enough to guide the change AND name how it will be verified. That
 * keeps I8's spirit (think + declare verification before code, durable audit
 * trail) at a fraction of the full-ceremony cost.
 */
export function checkMiniPlanSubstance(planText: string): string[] {
  const failures: string[] = [];
  if (planText.trim().length < 120) {
    failures.push(`Mini plan is too short (${planText.trim().length} chars, need 120+): say what changes and why`);
  }
  if (!/\b(test(s|ed|ing)?|verif\w+|check(s|ed|ing)?|assert(s|ed|ing|ions?)?)\b/i.test(planText)) {
    failures.push('Mini plan must say how the change will be verified (mention a test/verification step)');
  }
  return failures;
}
