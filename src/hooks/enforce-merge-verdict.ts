/**
 * enforce-merge-verdict.ts — PreToolUse gate: bind `gh pr merge` to the review verdict.
 *
 * @enforces I15/I18 at the irreversible step — the merge.
 *
 * The category (#1227): kaizen computes review verdicts correctly but no
 * mechanism honoured them at the point of no return. PR #1212 was merged to
 * main while its own review battery returned FAIL and the fix loop was
 * exhausted, because the only merge-aware hook (`check-dirty-files`) checks
 * dirty files, never the verdict. #1220 is that hole.
 *
 * This gate reads the latest stored review round for the PR being merged and
 * DENIES the merge when the derived verdict is FAIL (which also covers a
 * fix-loop that exhausted leaving the last round red). PASS /
 * PASS_WITH_PARTIALS allow. A PR with no stored review WARNs (surfaced, not
 * blocked — categorically blocking unreviewed merges is a different gap, #843,
 * and would over-block in host-project mode). Override is explicit and logged:
 * KAIZEN_ALLOW_MERGE_FAIL=1.
 */

import { readHookInput, traceNullInput } from './hook-io.js';
import { isGhPrCommand, reconstructPrUrl, stripHeredocBody } from './parse-command.js';
import { prTarget, latestReviewRound, deriveStoredRoundVerdict } from '../structured-data.js';
import type { RoundVerdict } from '../review-finding-contract.js';

export const MERGE_BYPASS_ENV = 'KAIZEN_ALLOW_MERGE_FAIL';

export interface MergeVerdict {
  /** Latest review round with data, or null when no review exists for the PR. */
  round: number | null;
  verdict: RoundVerdict | null;
}

export type MergeVerdictReader = (repo: string, prNumber: string) => MergeVerdict;

export interface CheckMergeVerdictDeps {
  reader: MergeVerdictReader;
  env?: NodeJS.ProcessEnv;
  /** Repo (owner/name) detected from the git remote, for bare `gh pr merge N`. */
  repoFromGit?: string;
}

export type MergeGateAction = 'allow' | 'warn' | 'deny';

export interface MergeGateResult {
  action: MergeGateAction;
  message?: string;
  bypassed?: boolean;
}

/** Parse the repo + PR number a `gh pr merge` invocation targets. */
export function parseMergeTarget(
  cmdLine: string,
  repoFromGit?: string,
): { repo: string; prNumber: string } | null {
  const url = reconstructPrUrl(cmdLine, '', '', 'merge', repoFromGit);
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { repo: match[1], prNumber: match[2] };
}

export function checkMergeVerdict(
  command: string,
  deps: CheckMergeVerdictDeps,
): MergeGateResult {
  const cmdLine = stripHeredocBody(command);
  if (!isGhPrCommand(cmdLine, 'merge')) return { action: 'allow' };

  const env = deps.env ?? process.env;

  const target = parseMergeTarget(cmdLine, deps.repoFromGit);
  if (!target) {
    return {
      action: 'warn',
      message:
        `[merge-verdict] Could not determine the PR being merged from the command, so the ` +
        `review verdict was not checked. Ensure the merge targets the intended PR.`,
    };
  }

  if (env[MERGE_BYPASS_ENV] === '1') {
    return {
      action: 'allow',
      bypassed: true,
      message:
        `[merge-verdict] OVERRIDE: ${MERGE_BYPASS_ENV}=1 — merging PR #${target.prNumber} ` +
        `WITHOUT honouring the review verdict. This override is logged.`,
    };
  }

  let result: MergeVerdict;
  try {
    result = deps.reader(target.repo, target.prNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: 'warn',
      message: `[merge-verdict] Could not read the review verdict for PR #${target.prNumber} (${msg}). Proceeding without the verdict check.`,
    };
  }

  if (result.verdict === 'FAIL') {
    return {
      action: 'deny',
      message:
        `MERGE BLOCKED — PR #${target.prNumber}'s latest review round (round ${result.round}) ` +
        `derived a FAIL verdict.\n\n` +
        `A FAIL means MISSING requirements remain (or the fix loop exhausted and the last round ` +
        `is still red). Merging now lands unreviewed-as-failing code on main — exactly the #1212 ` +
        `incident this gate (#1220) exists to prevent.\n\n` +
        `Do ONE of:\n` +
        `  • Fix the findings and re-run the review battery until the round derives PASS, then merge.\n` +
        `  • If a human has reviewed and accepts the risk, set ${MERGE_BYPASS_ENV}=1 to override ` +
        `(explicit + logged).\n\n` +
        `Inspect: npx tsx src/cli-structured-data.ts read-review-summary --pr ${target.prNumber} --repo ${target.repo} --round ${result.round}`,
    };
  }

  if (result.round == null) {
    return {
      action: 'warn',
      message:
        `[merge-verdict] PR #${target.prNumber} has no stored review round, so the verdict could ` +
        `not be honoured at merge. (Unreviewed-merge enforcement is tracked separately — #843.)`,
    };
  }

  return { action: 'allow' };
}

/** Production reader — reads the latest stored review verdict from the PR. */
export function defaultMergeVerdictReader(repo: string, prNumber: string): MergeVerdict {
  const target = prTarget(prNumber, repo);
  const round = latestReviewRound(target);
  if (!round || round < 1) return { round: null, verdict: null };
  return { round, verdict: deriveStoredRoundVerdict(target, round) };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-merge-verdict'); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const result = checkMergeVerdict(command, { reader: defaultMergeVerdictReader });

  if (result.action === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.message,
      },
    }));
  } else if ((result.action === 'warn' || result.bypassed) && result.message) {
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
