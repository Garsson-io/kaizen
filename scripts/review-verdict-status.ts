#!/usr/bin/env tsx
/**
 * CI status check for stored PR review verdicts.
 *
 * This is the non-Claude backstop for #1220: when branch protection requires
 * the "Review verdict gate" check, a PR whose latest stored review round
 * derives FAIL cannot land even outside an interactive Claude session.
 */

import { parseGithubPrUrl } from '../src/lib/github-pr.js';
import {
  deriveStoredRoundVerdict,
  latestReviewRound,
  prTarget,
} from '../src/structured-data.js';
import type { RoundVerdict } from '../src/review-finding-contract.js';

export interface ReviewVerdictStatus {
  outcome: 'pass' | 'fail' | 'no_data';
  message: string;
  round: number;
  verdict: RoundVerdict | null;
}

export function decideReviewVerdictStatus(round: number, verdict: RoundVerdict | null): ReviewVerdictStatus {
  if (round === 0 || verdict === null) {
    return {
      outcome: 'no_data',
      message: 'No stored review rounds found; review verdict gate has no failing verdict to block.',
      round,
      verdict: null,
    };
  }
  if (verdict === 'FAIL') {
    return {
      outcome: 'fail',
      message: `Latest stored review round r${round} derives FAIL; merge is blocked.`,
      round,
      verdict,
    };
  }
  return {
    outcome: 'pass',
    message: `Latest stored review round r${round} derives ${verdict}.`,
    round,
    verdict,
  };
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/review-verdict-status.ts --repo owner/repo --pr N|https://github.com/owner/repo/pull/N');
  process.exit(2);
}

export function resolveTarget(): { repo: string; pr: string } {
  const repo = readArg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const prRaw = readArg('--pr') ?? process.env.PR_NUMBER ?? process.env.GITHUB_PR_NUMBER;
  if (!prRaw) usage();

  const parsed = parseGithubPrUrl(prRaw);
  if (parsed) return { repo: parsed.repo, pr: String(parsed.number) };
  if (!repo || !/^\d+$/.test(prRaw)) usage();
  return { repo, pr: prRaw };
}

export function getReviewVerdictStatus(repo: string, pr: string): ReviewVerdictStatus {
  const target = prTarget(pr, repo);
  const round = latestReviewRound(target);
  const verdict = round === 0 ? null : deriveStoredRoundVerdict(target, round);
  return decideReviewVerdictStatus(round, verdict);
}

if (process.argv[1]?.endsWith('review-verdict-status.ts') || process.argv[1]?.endsWith('review-verdict-status.js')) {
  const target = resolveTarget();
  const status = getReviewVerdictStatus(target.repo, target.pr);
  console.log(status.message);
  process.exit(status.outcome === 'fail' ? 1 : 0);
}
