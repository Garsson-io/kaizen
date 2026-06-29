#!/usr/bin/env npx tsx
/**
 * review-round.ts - Focused authoritative review-round operator CLI.
 *
 * This is intentionally a thin workflow boundary over existing primitives:
 * reviewBattery() runs reviews, structured-data stores authoritative review
 * attachments, and rerun-review-verdict-gate handles the PR-attached check.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  reviewBattery,
  listPrDimensions,
  type BatteryResult,
  type DimensionReview,
  type ReviewDimensionFailure,
} from '../src/review-battery.js';
import {
  issueTarget,
  nextReviewRound,
  prTarget,
  retrievePlan,
  storeReviewBatch,
  type ReviewFindingData,
} from '../src/structured-data.js';
import { gh } from '../src/lib/gh-exec.js';
import {
  parseSubscriptionAgentProvider,
  subscriptionAgentProvider,
  type SubscriptionAgentProvider,
} from '../src/provider-contract.js';
import { rerunReviewVerdictGate, type RerunResult } from './rerun-review-verdict-gate.js';

export type ReviewRoundCommand = 'run' | 'store' | 'run-and-store';

export interface ReviewRoundCliArgs {
  command: ReviewRoundCommand;
  pr?: string;
  issue?: string;
  repo?: string;
  dimensions: string[];
  allPrDimensions: boolean;
  reviewProvider: SubscriptionAgentProvider;
  timeoutMs?: number;
  out?: string;
  file?: string;
  round?: number;
  dryRun: boolean;
  rerunGate: boolean;
  storeOnlyIfPass: boolean;
}

export interface ReviewRoundArtifact {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  pr: string;
  prUrl?: string;
  issue?: string;
  headSha?: string;
  provider: SubscriptionAgentProvider;
  requestedDimensions: string[];
  result: {
    verdict: 'pass' | 'fail';
    dimensions: DimensionReview[];
    missingCount: number;
    partialCount: number;
    failedDimensions: string[];
    failedDimensionFailures: ReviewDimensionFailure[];
    skippedDimensions: string[];
    durationMs: number;
    costUsd: number;
  };
  context: {
    issueTitle?: string;
    prTitle?: string;
    issueChars?: number;
    prBodyChars?: number;
    diffChars?: number;
    planChars?: number;
  };
}

export interface StoreReviewArtifactOptions {
  round?: number;
  dryRun?: boolean;
  rerunGate?: boolean;
}

export interface StoreReviewArtifactDeps {
  nextReviewRound: typeof nextReviewRound;
  storeReviewBatch: typeof storeReviewBatch;
  rerunReviewVerdictGate: typeof rerunReviewVerdictGate;
}

export interface StoreReviewArtifactResult {
  round: number;
  urls: string[];
  summaryUrl?: string;
  gate?: string;
}

interface ReviewRoundContext {
  repo: string;
  pr: string;
  prUrl?: string;
  issue?: string;
  headSha?: string;
  requestedDimensions: string[];
  issueTitle?: string;
  prTitle?: string;
  issueBody?: string;
  prBody?: string;
  prDiff?: string;
  planText?: string;
  result: BatteryResult;
  nowIso?: string;
}

interface RunReviewRoundDeps {
  reviewBattery: typeof reviewBattery;
  listPrDimensions: typeof listPrDimensions;
  gh: typeof gh;
  retrievePlan: typeof retrievePlan;
  writeArtifact: typeof writeArtifact;
  now: () => string;
}

const DEFAULT_PROVIDER = subscriptionAgentProvider('claude');

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseTimeoutMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+)(ms|s|m)?$/);
  if (!match) throw new Error(`invalid --timeout ${JSON.stringify(value)}; use values like 30000ms, 180s, or 3m`);
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 'ms';
  if (unit === 'm') return amount * 60_000;
  if (unit === 's') return amount * 1000;
  return amount;
}

export function parseCliArgs(argv = process.argv.slice(2)): ReviewRoundCliArgs {
  const command = argv[0] as ReviewRoundCommand | undefined;
  if (!command || command === '--help' || command === '-h') {
    return {
      command: 'run',
      dimensions: [],
      allPrDimensions: false,
      reviewProvider: DEFAULT_PROVIDER,
      dryRun: false,
      rerunGate: false,
      storeOnlyIfPass: false,
    };
  }
  if (!['run', 'store', 'run-and-store'].includes(command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }

  const providerName = readFlag(argv, '--provider') ?? readFlag(argv, '--review-provider') ?? 'claude';
  const reviewProvider = parseSubscriptionAgentProvider(providerName);
  if (!reviewProvider) {
    throw new Error(`unknown provider ${JSON.stringify(providerName)}; expected claude or codex`);
  }

  return {
    command,
    pr: normalizePr(readFlag(argv, '--pr')),
    issue: readFlag(argv, '--issue'),
    repo: readFlag(argv, '--repo') ?? process.env.GITHUB_REPOSITORY,
    dimensions: splitCsv(readFlag(argv, '--dimensions')),
    allPrDimensions: hasFlag(argv, '--all-pr'),
    reviewProvider,
    timeoutMs: parseTimeoutMs(readFlag(argv, '--timeout')),
    out: readFlag(argv, '--out'),
    file: readFlag(argv, '--file'),
    round: parsePositiveInt(readFlag(argv, '--round'), '--round'),
    dryRun: hasFlag(argv, '--dry-run'),
    rerunGate: hasFlag(argv, '--rerun-gate'),
    storeOnlyIfPass: hasFlag(argv, '--store-only-if-pass'),
  };
}

function normalizePr(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\/pull\/(\d+)/);
  return match ? match[1] : value;
}

function prUrl(repo: string, pr: string): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function selectDimensions(args: ReviewRoundCliArgs, listPr: () => string[]): string[] {
  if (args.dimensions.length > 0) return args.dimensions;
  return listPr();
}

function parseJsonObject<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} returned invalid JSON: ${msg}`);
  }
}

function ghJson<T>(ghFn: typeof gh, args: string[], label: string): T {
  return parseJsonObject<T>(ghFn(args), label);
}

export function reviewResultToArtifact(ctx: ReviewRoundContext): ReviewRoundArtifact {
  const provider = ctx.result.reviewProvider ?? DEFAULT_PROVIDER;
  return {
    schemaVersion: 1,
    generatedAt: ctx.nowIso ?? new Date().toISOString(),
    repo: ctx.repo,
    pr: ctx.pr,
    prUrl: ctx.prUrl,
    issue: ctx.issue,
    headSha: ctx.headSha,
    provider,
    requestedDimensions: ctx.requestedDimensions,
    result: {
      verdict: ctx.result.verdict,
      dimensions: ctx.result.dimensions,
      missingCount: ctx.result.missingCount,
      partialCount: ctx.result.partialCount,
      failedDimensions: ctx.result.failedDimensions,
      failedDimensionFailures: ctx.result.failedDimensionFailures ?? [],
      skippedDimensions: ctx.result.skippedDimensions,
      durationMs: ctx.result.durationMs,
      costUsd: ctx.result.costUsd,
    },
    context: {
      issueTitle: ctx.issueTitle,
      prTitle: ctx.prTitle,
      issueChars: ctx.issueBody?.length,
      prBodyChars: ctx.prBody?.length,
      diffChars: ctx.prDiff?.length,
      planChars: ctx.planText?.length,
    },
  };
}

export function writeArtifact(path: string, artifact: ReviewRoundArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export function defaultArtifactPath(pr: string, nowIso: string): string {
  const stamp = nowIso
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[^0-9TZ]/g, '');
  return `logs/review/pr-${pr}-${stamp}.json`;
}

export function readArtifact(path: string): ReviewRoundArtifact {
  return JSON.parse(readFileSync(path, 'utf8')) as ReviewRoundArtifact;
}

export function assertArtifactStoreable(artifact: ReviewRoundArtifact): void {
  if (artifact.result.failedDimensions.length > 0) {
    throw new Error(
      `Refusing to store authoritative review round: provider failures in dimensions ` +
      artifact.result.failedDimensions.join(', '),
    );
  }
  if (artifact.result.missingCount > 0) {
    throw new Error(
      `Refusing to store authoritative review round: ${artifact.result.missingCount} MISSING findings present`,
    );
  }
  const missing = artifact.result.dimensions.flatMap((dimension) =>
    dimension.findings
      .filter((finding) => finding.status === 'MISSING')
      .map((finding) => `${dimension.dimension}: ${finding.requirement}`),
  );
  if (missing.length > 0) {
    throw new Error(`Refusing to store authoritative review round: MISSING findings present (${missing.join('; ')})`);
  }
  if (artifact.result.verdict !== 'pass') {
    throw new Error(`Refusing to store authoritative review round: artifact verdict is ${artifact.result.verdict}`);
  }
}

function toReviewFindingData(dimension: DimensionReview): ReviewFindingData {
  return {
    dimension: dimension.dimension,
    verdict: dimension.verdict,
    summary: dimension.summary,
    findings: dimension.findings,
  };
}

export async function storeReviewArtifact(
  artifact: ReviewRoundArtifact,
  options: StoreReviewArtifactOptions = {},
  deps: StoreReviewArtifactDeps = { nextReviewRound, storeReviewBatch, rerunReviewVerdictGate },
): Promise<StoreReviewArtifactResult> {
  assertArtifactStoreable(artifact);
  const target = prTarget(artifact.pr, artifact.repo);
  const round = options.round ?? deps.nextReviewRound(target);
  if (options.dryRun) {
    return { round, urls: [], summaryUrl: undefined, gate: undefined };
  }

  const stored = deps.storeReviewBatch(target, round, artifact.result.dimensions.map(toReviewFindingData));
  let gate: string | undefined;
  if (options.rerunGate) {
    const rerun: RerunResult = deps.rerunReviewVerdictGate(artifact.repo, artifact.pr);
    gate = rerun.message;
  }
  return { round, urls: stored.urls, summaryUrl: stored.summaryUrl, gate };
}

export async function runReviewRound(
  args: ReviewRoundCliArgs,
  deps: RunReviewRoundDeps = {
    reviewBattery,
    listPrDimensions,
    gh,
    retrievePlan,
    writeArtifact,
    now: () => new Date().toISOString(),
  },
): Promise<ReviewRoundArtifact> {
  const repo = required(args.repo, '--repo');
  const pr = required(args.pr, '--pr');
  const issue = required(args.issue, '--issue');
  const dimensions = selectDimensions(args, deps.listPrDimensions);
  if (dimensions.length === 0) throw new Error('No review dimensions selected');

  const issueInfo = ghJson<{ title?: string; body?: string }>(
    deps.gh,
    ['issue', 'view', issue, '--repo', repo, '--json', 'title,body'],
    'gh issue view',
  );
  const prInfo = ghJson<{ title?: string; body?: string; headRefOid?: string; url?: string }>(
    deps.gh,
    ['pr', 'view', pr, '--repo', repo, '--json', 'title,body,headRefOid,url'],
    'gh pr view',
  );
  const diff = deps.gh(['pr', 'diff', pr, '--repo', repo], 120_000);
  const planText = deps.retrievePlan(issueTarget(issue, repo)) ?? undefined;

  const result = await deps.reviewBattery({
    dimensions,
    prUrl: prInfo.url ?? prUrl(repo, pr),
    issueNum: issue,
    repo,
    issueBody: [issueInfo.title, issueInfo.body].filter(Boolean).join('\n\n'),
    prBody: [prInfo.title, prInfo.body].filter(Boolean).join('\n\n'),
    prDiffStat: diff,
    planText,
    timeoutMs: args.timeoutMs,
    reviewProvider: args.reviewProvider,
  });

  const nowIso = deps.now();
  const artifact = reviewResultToArtifact({
    repo,
    pr,
    prUrl: prInfo.url ?? prUrl(repo, pr),
    issue,
    headSha: prInfo.headRefOid,
    requestedDimensions: dimensions,
    issueTitle: issueInfo.title,
    prTitle: prInfo.title,
    issueBody: issueInfo.body,
    prBody: prInfo.body,
    prDiff: diff,
    planText,
    result,
    nowIso,
  });
  deps.writeArtifact(args.out ?? defaultArtifactPath(pr, nowIso), artifact);
  return artifact;
}

export function buildHelp(): string {
  return `review-round - run and store focused authoritative review rounds

Usage:
  npx tsx scripts/review-round.ts run --pr N --issue N --repo owner/repo [--dimensions a,b|--all-pr] [--provider claude|codex] [--timeout 360s] --out file.json
  npx tsx scripts/review-round.ts store --file file.json [--round N] [--dry-run] [--rerun-gate]
  npx tsx scripts/review-round.ts run-and-store --pr N --issue N --repo owner/repo --store-only-if-pass --out file.json [--rerun-gate]

Examples:
  # focused rerun
  npx tsx scripts/review-round.ts run --pr 1735 --issue 1732 --repo Garsson-io/kaizen --provider codex --dimensions plan-completeness,security,test-quality --timeout 360s --out logs/review/pr-1735-r2.json

  # full PR review
  npx tsx scripts/review-round.ts run --pr 1735 --issue 1732 --repo Garsson-io/kaizen --all-pr --out logs/review/pr-1735-full.json

  # dry-run artifact only
  npx tsx scripts/review-round.ts store --file logs/review/pr-1735-r2.json --dry-run

  # store after inspection
  npx tsx scripts/review-round.ts store --file logs/review/pr-1735-r2.json --round 2 --rerun-gate

  # run-and-store
  npx tsx scripts/review-round.ts run-and-store --pr 1735 --issue 1732 --repo Garsson-io/kaizen --dimensions security,test-quality --store-only-if-pass --out logs/review/pr-1735-r2.json --rerun-gate
`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length <= 2) {
    console.log(buildHelp());
    return;
  }

  const args = parseCliArgs();
  if (args.command === 'run') {
    const artifact = await runReviewRound(args);
    console.log(`Review round artifact: ${args.out ?? defaultArtifactPath(artifact.pr, artifact.generatedAt)}`);
    console.log(`Verdict: ${artifact.result.verdict}; missing=${artifact.result.missingCount}; failed=${artifact.result.failedDimensions.length}`);
    return;
  }

  if (args.command === 'store') {
    const artifact = readArtifact(required(args.file, '--file'));
    const stored = await storeReviewArtifact(artifact, {
      round: args.round,
      dryRun: args.dryRun,
      rerunGate: args.rerunGate,
    });
    console.log(args.dryRun ? `Dry-run OK: would store round ${stored.round}` : `Stored review round ${stored.round}: ${stored.summaryUrl}`);
    if (stored.gate) console.log(`Review verdict gate: ${stored.gate}`);
    return;
  }

  if (!args.storeOnlyIfPass) {
    throw new Error('run-and-store requires --store-only-if-pass');
  }
  const artifact = await runReviewRound(args);
  const stored = await storeReviewArtifact(artifact, {
    round: args.round,
    dryRun: args.dryRun,
    rerunGate: args.rerunGate,
  });
  console.log(args.dryRun ? `Dry-run OK: would store round ${stored.round}` : `Stored review round ${stored.round}: ${stored.summaryUrl}`);
  if (stored.gate) console.log(`Review verdict gate: ${stored.gate}`);
}

if (process.argv[1]?.endsWith('review-round.ts') || process.argv[1]?.endsWith('review-round.js')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
