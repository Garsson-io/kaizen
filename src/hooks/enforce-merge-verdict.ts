/**
 * PreToolUse gate: bind direct `gh pr merge` commands to the stored review verdict.
 *
 * Auto-dent now blocks unsafe auto-merge queueing before it asks GitHub to merge.
 * This hook covers the sibling L2 path: a direct interactive `gh pr merge` must
 * not bypass a latest review round that derives FAIL.
 */

import { parseGithubPrUrl } from '../lib/github-pr.js';
import type { RoundVerdict } from '../review-finding-contract.js';
import {
  deriveStoredRoundVerdict,
  latestReviewRound,
  prTarget,
} from '../structured-data.js';
import { readHookInput, traceHookEvent, traceNullInput } from './hook-io.js';
import {
  extractPrNumber,
  extractPrUrl,
  extractRepoFlag,
  isGhPrCommand,
  stripHeredocBody,
} from './parse-command.js';

export const MERGE_OVERRIDE_ENV = 'KAIZEN_ALLOW_MERGE_ON_FAIL';

export interface MergeTarget {
  pr: string;
  repo: string;
}

export type MergeVerdict = RoundVerdict | null;
export type VerdictReader = (target: MergeTarget) => MergeVerdict;

export interface MergeGateResult {
  action: 'allow' | 'warn' | 'deny';
  message?: string;
  bypassed?: boolean;
}

export function parseMergeTarget(cmdLine: string): MergeTarget | null {
  const url = extractPrUrl(cmdLine);
  const parsedUrl = parseGithubPrUrl(url);
  if (parsedUrl) return { repo: parsedUrl.repo, pr: String(parsedUrl.number) };

  const pr = extractPrNumber(cmdLine, 'merge');
  const repo = extractRepoFlag(cmdLine);
  if (pr && repo) return { pr, repo };
  return null;
}

export const defaultVerdictReader: VerdictReader = (target) => {
  const t = prTarget(target.pr, target.repo);
  const round = latestReviewRound(t);
  if (round === 0) return null;
  return deriveStoredRoundVerdict(t, round);
};

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
          `[enforce-merge-verdict] OVERRIDE: ${MERGE_OVERRIDE_ENV} is set; ` +
          `merging ${prRef} despite a FAIL review verdict.`,
      };
    }
    return {
      action: 'deny',
      message: `MERGE BLOCKED: ${prRef}'s latest review round derives FAIL.

Fix the findings and re-run the review until the latest round derives PASS, or
use an explicit logged human override:

  ${MERGE_OVERRIDE_ENV}=1 gh pr merge ...

This gate binds the stored review verdict to the irreversible merge step.`,
    };
  }

  if (verdict === null) {
    return {
      action: 'warn',
      message:
        `[enforce-merge-verdict] No stored review rounds found for ${prRef}; ` +
        `merge-verdict gate is advisory for this invocation.`,
    };
  }

  return { action: 'allow' };
}

export interface CheckMergeVerdictOptions {
  readVerdict?: VerdictReader;
  env?: NodeJS.ProcessEnv;
}

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
        `[enforce-merge-verdict] Could not resolve PR number/repo from the merge command; ` +
        `merge-verdict gate is advisory for this invocation.`,
    };
  }

  const read = options.readVerdict ?? defaultVerdictReader;
  const override = (options.env ?? process.env)[MERGE_OVERRIDE_ENV] === '1';

  try {
    return decideMergeGate(read(target), { override, target });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: 'warn',
      message:
        `[enforce-merge-verdict] Could not read review verdict for PR #${target.pr} ` +
        `(${msg}); merge-verdict gate is advisory for this invocation.`,
    };
  }
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) {
    traceNullInput('enforce-merge-verdict');
    process.exit(0);
  }

  const result = checkMergeVerdict(input.tool_input?.command ?? '');
  traceHookEvent('enforce-merge-verdict', {
    action: result.action,
    bypassed: result.bypassed ?? false,
    reason: result.bypassed ? 'override' : result.action === 'deny' ? 'fail_verdict' : result.action,
  });
  if (result.action === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.message,
      },
    }));
  } else if (result.message) {
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
