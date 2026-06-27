/**
 * enforce-merge-verdict.ts — PreToolUse gate: bind `gh pr merge` to the stored
 * review verdict.
 *
 * @enforces I15/I18 at the irreversible step — a merge cannot land while the
 *           latest review round derives FAIL. Canonical: docs/kaizen-invariants.md.
 *
 * #1220 / #1227: merge was the unguarded choke point. The only merge-aware hook
 * (check-dirty-files) blocks `pr_merge` on DIRTY FILES only — nothing read the
 * review verdict. So a PR whose review battery returned FAIL / whose fix loop
 * exhausted could be merged straight to main (exactly how PR #1212 landed). The
 * verdict was computed correctly and then NO mechanism consumed it at the
 * point of no return — a BINDING gap, not a measurement gap.
 *
 * This hook closes the binding: on `gh pr merge <N|url>`, read the latest stored
 * review round's DERIVED verdict (authoritative — from stored per-dimension
 * findings, never caller text; an exhausted fix loop leaves the latest round
 * still deriving FAIL) and DENY the merge when it is FAIL.
 *
 * Fail-CLOSED on FAIL, but false-positive-free elsewhere:
 *   - FAIL                       → DENY (explicit, logged override only).
 *   - PASS / PASS_WITH_PARTIALS  → allow.
 *   - no review data (null)      → WARN only — never block a legitimate
 *                                  non-kaizen merge that simply has no battery.
 *
 * Override: KAIZEN_ALLOW_MERGE_ON_FAIL=1 allows the merge but emits a loud,
 * logged override line — the human override is explicit and recorded, never the
 * silent default.
 *
 * The verdict read is injectable (readVerdict) so the decision logic is
 * unit-testable without shelling out to `gh` — the same injectable-runner
 * discipline #1222 asks for in the storage layer.
 */

import { readHookInput, traceNullInput } from './hook-io.js';
import {
  isGhPrCommand,
  extractPrNumber,
  extractRepoFlag,
  extractPrUrl,
  stripHeredocBody,
} from './parse-command.js';
import {
  prTarget,
  latestReviewRound,
  deriveStoredRoundVerdict,
} from '../structured-data.js';
import type { RoundVerdict } from '../review-finding-contract.js';

/** Env flag that allows a merge past a FAIL verdict (explicit + logged). */
export const MERGE_OVERRIDE_ENV = 'KAIZEN_ALLOW_MERGE_ON_FAIL';

export interface MergeTarget {
  pr: string;
  repo: string;
}

/**
 * Parse the PR number + repo a `gh pr merge` command targets. Handles both the
 * bare-number form (`gh pr merge 123 --repo R`) and the URL form
 * (`gh pr merge https://github.com/owner/repo/pull/123` — what auto-dent emits).
 * Returns null when neither a PR ref nor a repo can be resolved.
 */
export function parseMergeTarget(cmdLine: string): MergeTarget | null {
  const url = extractPrUrl(cmdLine);
  if (url) {
    const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) return { repo: m[1], pr: m[2] };
  }
  const pr = extractPrNumber(cmdLine, 'merge');
  const repo = extractRepoFlag(cmdLine);
  if (pr && repo) return { pr, repo };
  return null;
}

/** Verdict a reader returns: the derived round verdict, or null (no review data). */
export type MergeVerdict = RoundVerdict | null;

/** Reads the latest stored review verdict for a PR. Injectable for tests. */
export type VerdictReader = (target: MergeTarget) => MergeVerdict;

/**
 * Default reader: derive the latest round verdict from stored findings on the
 * PR (authoritative). Returns null when the PR has no review rounds at all.
 */
export const defaultVerdictReader: VerdictReader = (target) => {
  const t = prTarget(target.pr, target.repo);
  const round = latestReviewRound(t);
  if (round === 0) return null;
  return deriveStoredRoundVerdict(t, round);
};

export interface MergeGateResult {
  action: 'allow' | 'warn' | 'deny';
  message?: string;
  bypassed?: boolean;
}

/**
 * Pure decision: given the verdict and whether an override is set, decide
 * whether to allow, warn, or deny the merge. No I/O — the testable core.
 */
export function decideMergeGate(
  verdict: MergeVerdict,
  opts: { override: boolean; target?: MergeTarget } = { override: false },
): MergeGateResult {
  const prRef = opts.target ? `PR #${opts.target.pr}` : 'this PR';

  if (verdict === 'FAIL') {
    if (opts.override) {
      return {
        action: 'allow',
        bypassed: true,
        message:
          `[enforce-merge-verdict] OVERRIDE: ${MERGE_OVERRIDE_ENV} is set — ` +
          `merging ${prRef} despite a FAIL review verdict. This override is logged.`,
      };
    }
    return {
      action: 'deny',
      message: `MERGE BLOCKED — ${prRef}'s latest review round derives FAIL.

A PR whose review battery FAILED (or whose fix loop exhausted, leaving MISSING
findings) must NOT be merged to main. The verdict was computed by the review
battery; merge is the irreversible step that must honour it (#1220 / #1227).

To proceed you MUST do ONE of:
  1. Fix the findings and re-run the review until the latest round derives PASS
     (re-run /kaizen-review-pr — a fresh round supersedes the FAIL), OR
  2. Explicitly override with a logged human decision:
       ${MERGE_OVERRIDE_ENV}=1 gh pr merge ...
     (override is recorded — do not make it the silent default).

This is the exact failure class that let PR #1212 merge past a red battery.`,
    };
  }

  if (verdict === null) {
    return {
      action: 'warn',
      message:
        `[enforce-merge-verdict] No stored review rounds found for ${prRef}; ` +
        `merge-verdict gate is advisory here (cannot confirm a passing review).`,
    };
  }

  // PASS / PASS_WITH_PARTIALS
  return { action: 'allow' };
}

export interface CheckMergeVerdictOptions {
  readVerdict?: VerdictReader;
  env?: NodeJS.ProcessEnv;
}

/**
 * Top-level check: detect a `gh pr merge`, resolve the target, read the verdict,
 * and decide. Verdict read failures fail OPEN with a warning (a network/auth
 * hiccup must not wedge every merge) — the FAIL block only fires on a verdict
 * the reader actually returned as FAIL.
 */
export function checkMergeVerdict(
  command: string,
  options: CheckMergeVerdictOptions = {},
): MergeGateResult {
  const cmdLine = stripHeredocBody(command);
  if (!isGhPrCommand(cmdLine, 'merge')) return { action: 'allow' };

  const target = parseMergeTarget(cmdLine);
  if (!target) {
    return {
      action: 'warn',
      message:
        `[enforce-merge-verdict] could not resolve PR number/repo from the merge ` +
        `command — gate is advisory for this invocation.`,
    };
  }

  const env = options.env ?? process.env;
  const override = env[MERGE_OVERRIDE_ENV] === '1';
  const read = options.readVerdict ?? defaultVerdictReader;

  let verdict: MergeVerdict;
  try {
    verdict = read(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: 'warn',
      message:
        `[enforce-merge-verdict] could not read review verdict for PR #${target.pr} ` +
        `(${msg}) — gate is advisory for this invocation.`,
    };
  }

  return decideMergeGate(verdict, { override, target });
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-merge-verdict'); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const result = checkMergeVerdict(command);

  if (result.action === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.message,
        },
      }),
    );
  } else if (result.message) {
    // warn / logged override — surface on stderr, do not block.
    process.stderr.write(`\n${result.message}\n`);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('enforce-merge-verdict.ts') ||
  process.argv[1]?.endsWith('enforce-merge-verdict.js')
) {
  main().catch(() => process.exit(0));
}
