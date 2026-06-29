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
import { parseArgs as parseNodeArgs } from 'node:util';
import { z } from 'zod';
import {
  reviewBattery,
  listPrDimensions,
  loadDimensionMetas,
  type BatteryResult,
  type DimensionReview,
  type ReviewDimensionFailure,
} from '../src/review-battery.js';
import {
  issueTarget,
  nextReviewRound,
  prTarget,
  retrievePlan,
  retrieveTestPlan,
  storeReviewBatch,
  type ReviewFindingData,
} from '../src/structured-data.js';
import { writeAttachment } from '../src/section-editor.js';
import { buildCappedBody } from '../src/capped-attachment.js';
import { gh } from '../src/lib/gh-exec.js';
import {
  parseSubscriptionAgentProvider,
  subscriptionAgentProvider,
  type SubscriptionAgentProvider,
} from '../src/provider-contract.js';
import { validateReviewFindingPayload } from '../src/review-finding-contract.js';
import { writeReviewSentinel } from '../src/cli-structured-data.js';
import { rerunReviewVerdictGate, type RerunResult } from './rerun-review-verdict-gate.js';

export type ReviewRoundCommand = 'run' | 'store' | 'run-and-store';

export interface ReviewRoundCliArgs {
  command: ReviewRoundCommand;
  pr?: string;
  issue?: string;
  repo?: string;
  dimensions: string[];
  groups: string[];
  allPrDimensions: boolean;
  reviewProvider: SubscriptionAgentProvider;
  timeoutMs?: number;
  out?: string;
  file?: string;
  round?: number;
  dryRun: boolean;
  debug: boolean;
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
    error?: string;
  };
  context: {
    issueTitle?: string;
    prTitle?: string;
    issueChars?: number;
    prBodyChars?: number;
    diffChars?: number;
    planChars?: number;
    testPlanChars?: number;
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
  writeReviewSentinel: typeof writeReviewSentinel;
  writeAttachment: typeof writeAttachment;
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
  testPlanText?: string;
  result: BatteryResult;
  nowIso?: string;
}

interface RunReviewRoundDeps {
  reviewBattery: typeof reviewBattery;
  listPrDimensions: typeof listPrDimensions;
  gh: typeof gh;
  retrievePlan: typeof retrievePlan;
  retrieveTestPlan: typeof retrieveTestPlan;
  writeArtifact: typeof writeArtifact;
  now: () => string;
}

const DEFAULT_PROVIDER = subscriptionAgentProvider('claude');

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`);
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
  if (amount <= 0) throw new Error('--timeout must be positive');
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
      groups: [],
      allPrDimensions: false,
      reviewProvider: DEFAULT_PROVIDER,
      dryRun: false,
      debug: false,
      rerunGate: false,
      storeOnlyIfPass: false,
    };
  }
  if (!['run', 'store', 'run-and-store'].includes(command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }

  const parsed = parseNodeArgs({
    args: argv.slice(1),
    allowPositionals: false,
    strict: true,
    options: {
      pr: { type: 'string' },
      issue: { type: 'string' },
      repo: { type: 'string' },
      provider: { type: 'string' },
      'review-provider': { type: 'string' },
      dimensions: { type: 'string' },
      group: { type: 'string' },
      'all-pr': { type: 'boolean' },
      timeout: { type: 'string' },
      out: { type: 'string' },
      file: { type: 'string' },
      round: { type: 'string' },
      'dry-run': { type: 'boolean' },
      debug: { type: 'boolean' },
      'rerun-gate': { type: 'boolean' },
      'store-only-if-pass': { type: 'boolean' },
    },
  });
  const values = parsed.values;

  const providerName = values.provider ?? values['review-provider'] ?? 'claude';
  const reviewProvider = parseSubscriptionAgentProvider(providerName);
  if (!reviewProvider) {
    throw new Error(`unknown provider ${JSON.stringify(providerName)}; expected claude or codex`);
  }

  return {
    command,
    pr: normalizePr(values.pr),
    issue: values.issue,
    repo: values.repo ?? process.env.GITHUB_REPOSITORY,
    dimensions: splitCsv(values.dimensions),
    groups: splitCsv(values.group),
    allPrDimensions: values['all-pr'] === true,
    reviewProvider,
    timeoutMs: parseTimeoutMs(values.timeout),
    out: values.out,
    file: values.file,
    round: parsePositiveInt(values.round, '--round'),
    dryRun: values['dry-run'] === true,
    debug: values.debug === true,
    rerunGate: values['rerun-gate'] === true,
    storeOnlyIfPass: values['store-only-if-pass'] === true,
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

export function expandDimensionGroups(groups: string[], listPr: () => string[]): string[] {
  const metas = loadDimensionMetas();
  const prDims = new Set(listPr());
  const byName = (name: string) => metas.find((meta) => meta.name === name);
  const selected = new Set<string>();
  for (const group of groups) {
    let recognized = false;
    if (group === 'all-pr') {
      for (const dim of prDims) selected.add(dim);
      recognized = true;
      continue;
    }
    for (const dim of prDims) {
      const meta = byName(dim);
      const needs = new Set(meta?.needs ?? []);
      const include =
        (group === 'diff' && needs.size === 1 && needs.has('diff')) ||
        (group === 'issue' && needs.has('issue') && !needs.has('plan') && !needs.has('tests')) ||
        (group === 'plan' && needs.has('plan')) ||
        (group === 'tests' && needs.has('tests')) ||
        (group === 'description' && dim === 'pr-description') ||
        (group === 'skills' && dim === 'skill-changes');
      if (include) {
        selected.add(dim);
        recognized = true;
      }
    }
    if (!recognized && !['diff', 'issue', 'plan', 'tests', 'description', 'skills'].includes(group)) {
      throw new Error(`unknown dimension group ${JSON.stringify(group)}`);
    }
  }
  return [...selected];
}

function selectDimensions(args: ReviewRoundCliArgs, listPr: () => string[]): string[] {
  const selected = new Set<string>();
  for (const dim of args.dimensions) selected.add(dim);
  if (args.allPrDimensions) {
    for (const dim of listPr()) selected.add(dim);
  }
  for (const dim of expandDimensionGroups(args.groups, listPr)) selected.add(dim);
  return selected.size > 0 ? [...selected] : listPr();
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
      error: (ctx.result as BatteryResult & { error?: string }).error,
    },
    context: {
      issueTitle: ctx.issueTitle,
      prTitle: ctx.prTitle,
      issueChars: ctx.issueBody?.length,
      prBodyChars: ctx.prBody?.length,
      diffChars: ctx.prDiff?.length,
      planChars: ctx.planText?.length,
      testPlanChars: ctx.testPlanText?.length,
    },
  };
}

const FindingSchema = z.object({
  requirement: z.string(),
  status: z.enum(['DONE', 'PARTIAL', 'MISSING']),
  detail: z.string(),
  analysis: z.string().optional(),
});

const DimensionSchema = z.object({
  dimension: z.string().min(1),
  verdict: z.enum(['pass', 'fail']),
  summary: z.string(),
  findings: z.array(FindingSchema),
  provider: z.unknown().optional(),
});

const ArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  repo: z.string().min(1),
  pr: z.string().min(1),
  prUrl: z.string().optional(),
  issue: z.string().optional(),
  headSha: z.string().optional(),
  provider: z.object({ provider: z.enum(['claude', 'codex']), billing: z.literal('subscription-cli') }),
  requestedDimensions: z.array(z.string().min(1)),
  result: z.object({
    verdict: z.enum(['pass', 'fail']),
    dimensions: z.array(DimensionSchema),
    missingCount: z.number(),
    partialCount: z.number(),
    failedDimensions: z.array(z.string()),
    failedDimensionFailures: z.array(z.unknown()).default([]),
    skippedDimensions: z.array(z.string()),
    durationMs: z.number(),
    costUsd: z.number(),
    error: z.string().optional(),
  }),
  context: z.object({
    issueTitle: z.string().optional(),
    prTitle: z.string().optional(),
    issueChars: z.number().optional(),
    prBodyChars: z.number().optional(),
    diffChars: z.number().optional(),
    planChars: z.number().optional(),
    testPlanChars: z.number().optional(),
  }),
});

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
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return ArtifactSchema.parse(parsed) as ReviewRoundArtifact;
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
  const stored = new Set(artifact.result.dimensions.map((dimension) => dimension.dimension));
  const missingDimensions = artifact.requestedDimensions.filter((dimension) => !stored.has(dimension));
  if (missingDimensions.length > 0) {
    throw new Error(`Refusing to store authoritative review round: missing requested dimensions ${missingDimensions.join(', ')}`);
  }
  for (const dimension of artifact.result.dimensions) {
    const validation = validateReviewFindingPayload(dimension);
    if (!validation.ok) {
      throw new Error(`Refusing to store authoritative review round: ${dimension.dimension} payload invalid: ${validation.error}`);
    }
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
  deps: StoreReviewArtifactDeps = { nextReviewRound, storeReviewBatch, rerunReviewVerdictGate, writeReviewSentinel, writeAttachment },
): Promise<StoreReviewArtifactResult> {
  assertArtifactStoreable(artifact);
  const target = prTarget(artifact.pr, artifact.repo);
  const round = options.round ?? deps.nextReviewRound(target);
  if (options.dryRun) {
    return { round, urls: [], summaryUrl: undefined, gate: undefined };
  }

  const stored = deps.storeReviewBatch(target, round, artifact.result.dimensions.map(toReviewFindingData));
  deps.writeReviewSentinel(artifact.repo, artifact.pr, round, { strict: true });
  let gate: string | undefined;
  if (options.rerunGate) {
    const rerun: RerunResult = deps.rerunReviewVerdictGate(artifact.repo, artifact.pr);
    gate = rerun.message;
  }
  return { round, urls: stored.urls, summaryUrl: stored.summaryUrl, gate };
}

export function debugAttachmentName(artifact: ReviewRoundArtifact): string {
  return `review/debug/${defaultArtifactPath(artifact.pr, artifact.generatedAt)
    .replace(/^logs\/review\//, '')
    .replace(/\.json$/, '')}`;
}

export function buildDebugAttachmentBody(artifact: ReviewRoundArtifact, artifactPath: string): string {
  const summary = [
    `- Verdict: ${artifact.result.verdict}`,
    `- Missing: ${artifact.result.missingCount}`,
    `- Partial: ${artifact.result.partialCount}`,
    `- Provider failures: ${artifact.result.failedDimensions.join(', ') || 'none'}`,
    `- Artifact path: ${artifactPath}`,
  ].join('\n');
  return buildCappedBody({
    header: '## Non-authoritative Review Debug Artifact\n\nThis attachment is for debugging only. It does not update active review round state and does not satisfy the review verdict gate.',
    summary,
    blocks: [{ label: 'review-round artifact', fence: 'json', content: JSON.stringify(artifact, null, 2) }],
    pointer: artifactPath,
  });
}

export function storeDebugArtifact(
  artifact: ReviewRoundArtifact,
  artifactPath: string,
  deps: Pick<StoreReviewArtifactDeps, 'writeAttachment'> = { writeAttachment },
): string {
  return deps.writeAttachment(prTarget(artifact.pr, artifact.repo), debugAttachmentName(artifact), buildDebugAttachmentBody(artifact, artifactPath));
}

export async function runReviewRound(
  args: ReviewRoundCliArgs,
  deps: RunReviewRoundDeps = {
    reviewBattery,
    listPrDimensions,
    gh,
    retrievePlan,
    retrieveTestPlan,
    writeArtifact,
    now: () => new Date().toISOString(),
  },
): Promise<ReviewRoundArtifact> {
  const repo = required(args.repo, '--repo');
  const pr = required(args.pr, '--pr');
  const issue = required(args.issue, '--issue');
  const dimensions = selectDimensions(args, deps.listPrDimensions);
  if (dimensions.length === 0) throw new Error('No review dimensions selected');
  const nowIso = deps.now();
  const outPath = args.out ?? defaultArtifactPath(pr, nowIso);

  let issueInfo: { title?: string; body?: string } = {};
  let prInfo: { title?: string; body?: string; headRefOid?: string; url?: string } = {};
  let diff = '';
  let planText: string | undefined;
  let testPlanText: string | undefined;

  try {
    issueInfo = ghJson(deps.gh, ['issue', 'view', issue, '--repo', repo, '--json', 'title,body'], 'gh issue view');
    prInfo = ghJson(deps.gh, ['pr', 'view', pr, '--repo', repo, '--json', 'title,body,headRefOid,url'], 'gh pr view');
    diff = deps.gh(['pr', 'diff', pr, '--repo', repo], 120_000);
    planText = deps.retrievePlan(issueTarget(issue, repo)) ?? undefined;
    testPlanText = deps.retrieveTestPlan(issueTarget(issue, repo)) ?? undefined;

    console.log(`  [review-round] queued ${dimensions.length} dimension(s): ${dimensions.join(', ')}`);
    const result = await deps.reviewBattery({
      dimensions,
      prUrl: prInfo.url ?? prUrl(repo, pr),
      issueNum: issue,
      repo,
      issueBody: [issueInfo.title, issueInfo.body].filter(Boolean).join('\n\n'),
      prBody: [prInfo.title, prInfo.body].filter(Boolean).join('\n\n'),
      prDiffStat: diff,
      planText,
      extraVars: { test_plan: testPlanText ?? '' },
      timeoutMs: args.timeoutMs,
      reviewProvider: args.reviewProvider,
    });

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
      testPlanText,
      result,
      nowIso,
    });
    deps.writeArtifact(outPath, artifact);
    return artifact;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = failedBatteryResult(dimensions, args.reviewProvider, message);
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
      testPlanText,
      result,
      nowIso,
    });
    deps.writeArtifact(outPath, artifact);
    throw err;
  }
}

function failedBatteryResult(dimensions: string[], provider: SubscriptionAgentProvider, error: string): BatteryResult & { error: string } {
  return {
    dimensions: [],
    reviewProvider: provider,
    verdict: 'fail',
    missingCount: 0,
    partialCount: 0,
    durationMs: 0,
    costUsd: 0,
    failedDimensions: dimensions,
    failedDimensionFailures: dimensions.map((dimension) => ({
      dimension,
      provider,
      failureClass: provider.provider === 'codex' ? 'codex_review_failed' : 'claude_review_failed',
    })),
    skippedDimensions: [],
    error,
  };
}

export function formatDimensionProgress(artifact: ReviewRoundArtifact): string {
  const failed = new Set(artifact.result.failedDimensions);
  const byDimension = new Map(artifact.result.dimensions.map((dimension) => [dimension.dimension, dimension]));
  return artifact.requestedDimensions.map((dimension) => {
    if (failed.has(dimension)) return `${dimension}: PROVIDER_FAILED`;
    const result = byDimension.get(dimension);
    if (!result) return `${dimension}: MISSING`;
    const missing = result.findings.filter((finding) => finding.status === 'MISSING').length;
    const partial = result.findings.filter((finding) => finding.status === 'PARTIAL').length;
    if (missing > 0) return `${dimension}: MISSING (${missing})`;
    if (partial > 0) return `${dimension}: PARTIAL (${partial})`;
    return `${dimension}: PASS`;
  }).join('\n');
}

export function formatRecoveryCommands(artifact: ReviewRoundArtifact, artifactPath: string): string {
  const failed = new Set(artifact.result.failedDimensions);
  const incomplete = artifact.result.dimensions
    .filter((dimension) => dimension.findings.some((finding) => finding.status === 'MISSING'))
    .map((dimension) => dimension.dimension);
  const rerun = [...new Set([...failed, ...incomplete])];
  const lines: string[] = [];
  if (rerun.length > 0) {
    lines.push(
      `Rerun failed/missing dimensions: npx tsx scripts/review-round.ts run --pr ${artifact.pr} --issue ${artifact.issue ?? '<issue>'} --repo ${artifact.repo} --dimensions ${rerun.join(',')} --provider ${artifact.provider.provider} --out ${artifactPath}`,
    );
  } else {
    lines.push(
      `Store after inspection: npx tsx scripts/review-round.ts store --file ${artifactPath} --repo ${artifact.repo} --rerun-gate`,
    );
  }
  return lines.join('\n');
}

export function buildHelp(): string {
  return `review-round - run and store focused authoritative review rounds

Usage:
  npx tsx scripts/review-round.ts run --pr N --issue N --repo owner/repo [--dimensions a,b|--group diff,plan|--all-pr] [--provider claude|codex] [--timeout 360s] [--out file.json]
  npx tsx scripts/review-round.ts store --file file.json [--round N] [--dry-run] [--debug] [--rerun-gate]
  npx tsx scripts/review-round.ts run-and-store --pr N --issue N --repo owner/repo --store-only-if-pass --out file.json [--rerun-gate]

Examples:
  # focused rerun
  npx tsx scripts/review-round.ts run --pr 1735 --issue 1732 --repo Garsson-io/kaizen --provider codex --dimensions plan-completeness,security,test-quality --timeout 360s --out logs/review/pr-1735-r2.json

  # full PR review
  npx tsx scripts/review-round.ts run --pr 1735 --issue 1732 --repo Garsson-io/kaizen --all-pr --out logs/review/pr-1735-full.json

  # dimension group
  npx tsx scripts/review-round.ts run --pr 1735 --issue 1732 --repo Garsson-io/kaizen --group diff,tests --out logs/review/pr-1735-focused.json

  # dry-run artifact only
  npx tsx scripts/review-round.ts store --file logs/review/pr-1735-r2.json --dry-run

  # non-authoritative debug attachment (does not satisfy the review gate)
  npx tsx scripts/review-round.ts store --file logs/review/pr-1735-r2.json --debug

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
    const artifactPath = args.out ?? defaultArtifactPath(artifact.pr, artifact.generatedAt);
    console.log(`Review round artifact: ${artifactPath}`);
    console.log(`Verdict: ${artifact.result.verdict}; missing=${artifact.result.missingCount}; failed=${artifact.result.failedDimensions.length}`);
    console.log(formatDimensionProgress(artifact));
    console.log(formatRecoveryCommands(artifact, artifactPath));
    return;
  }

  if (args.command === 'store') {
    const artifactPath = required(args.file, '--file');
    const artifact = readArtifact(artifactPath);
    if (args.debug) {
      const url = storeDebugArtifact(artifact, artifactPath);
      console.log(`Debug artifact stored (non-authoritative): ${url}`);
      return;
    }
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
  const artifactPath = args.out ?? defaultArtifactPath(artifact.pr, artifact.generatedAt);
  const stored = await storeReviewArtifact(artifact, {
    round: args.round,
    dryRun: args.dryRun,
    rerunGate: args.rerunGate,
  });
  console.log(args.dryRun ? `Dry-run OK: would store round ${stored.round}` : `Stored review round ${stored.round}: ${stored.summaryUrl}`);
  if (stored.gate) console.log(`Review verdict gate: ${stored.gate}`);
  console.log(formatRecoveryCommands(artifact, artifactPath));
}

if (process.argv[1]?.endsWith('review-round.ts') || process.argv[1]?.endsWith('review-round.js')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
