/**
 * structured-data.ts — High-level API for kaizen structured data on PRs and issues.
 *
 * Built on section-editor.ts (low-level sections + attachments). Provides
 * domain-specific functions for reviews, plans, iterations, and connected issues.
 *
 * Naming conventions (attachment names):
 *   review/r{N}/{dimension}  — per-dimension findings for round N
 *   review/r{N}/summary      — overall round N assessment
 *   plan                     — implementation plan
 *   testplan                 — test plan
 *   metadata                 — YAML structured metadata (connected issues, PR number, etc.)
 *   iteration/state          — current iteration/fix-loop state
 */

import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import {
  listAttachments,
  readAttachment,
  writeAttachment,
  addSection,
  replaceSection,
  fetchBody,
  parseSections,
  type AttachmentTarget,
  type SectionTarget,
} from './section-editor.js';
import {
  normalizeReviewFindingData as normalizeReviewFindingDataContract,
  makeReviewFindingMeta,
  extractReviewFindingMeta,
  extractMetaBlock,
  summarizeRound,
  assertsPass,
  type ReviewFinding,
  type ReviewFindingData,
  type ReviewFindingMeta,
  type RoundRow,
  type RoundVerdict,
} from './review-finding-contract.js';

// ── Target helpers ──────────────────────────────────────────────────

export function prTarget(prNum: string, repo: string): AttachmentTarget & SectionTarget {
  return { kind: 'pr', number: prNum, repo };
}

export function issueTarget(issueNum: string, repo: string): AttachmentTarget & SectionTarget {
  return { kind: 'issue', number: issueNum, repo };
}

/**
 * Get the next review round number (latest + 1, or 1 if no reviews exist).
 */
export function nextReviewRound(target: AttachmentTarget): number {
  return latestReviewRound(target) + 1;
}

/**
 * Store multiple dimension findings at once and auto-compose the summary.
 * Saves N API calls vs individual storeReviewFinding + storeReviewSummary.
 */
export function storeReviewBatch(
  target: AttachmentTarget,
  round: number,
  findings: ReviewFindingData[],
  options: StoreReviewSummaryOptions = {},
): { urls: string[]; summaryUrl: string } {
  const urls = findings.map(f => storeReviewFinding(target, round, f));
  const summaryUrl = storeReviewSummary(target, round, undefined, options);
  return { urls, summaryUrl };
}

/**
 * Quick pass — store a dimension as PASS with a simple summary.
 * Shorthand for when all findings are DONE.
 */
export function storeQuickPass(
  target: AttachmentTarget,
  round: number,
  dimension: string,
  summary: string,
  requirements: string[],
): string {
  return storeReviewFinding(target, round, {
    dimension,
    verdict: 'pass',
    summary,
    findings: requirements.map(r => ({ requirement: r, status: 'DONE' as const, detail: 'Verified' })),
  });
}

// ── Plan text extraction ────────────────────────────────────────────

const PLAN_SECTION_RE = /## (?:Implementation )?Plan\b[\s\S]*?(?=\n## |\n```yaml|$)/i;

/** Extract the first plan section from markdown text. */
export function extractPlanText(text: string): string | undefined {
  const match = text.match(PLAN_SECTION_RE);
  return match ? match[0] : undefined;
}

// ── Reviews ─────────────────────────────────────────────────────────

export type { ReviewFinding, ReviewFindingData } from './review-finding-contract.js';

const STATUS_ICON: Record<string, string> = { DONE: '✅', PARTIAL: '⚠️', MISSING: '❌' };

export type GhCheck = {
  name?: string;
  bucket?: string;
  state?: string;
  workflow?: string;
  link?: string;
};

/**
 * Injectable boundary for the CI/head proof (#1070, redo #1225).
 *
 * #1222 root cause: the proof shelled out to real `gh`/`git` from inside the
 * otherwise-pure `storeReviewSummary` storage primitive — non-deterministic,
 * auth-dependent, untestable without hitting the network. We keep the proof at
 * the storage layer (so a PASS summary can't be stored bypassing it — the whole
 * #1070 point) but route every external read through this interface. Production
 * uses `defaultCiRunner`; tests inject a fake and never shell out.
 */
export interface CiProofRunner {
  /** SHA the review was performed against (explicit `expectedHeadSha`, else local HEAD). */
  reviewedHead(expectedHeadSha: string | undefined): string;
  /** Current head SHA of the PR per the forge. */
  prHead(target: AttachmentTarget): string;
  /** CI checks for the PR's current head. */
  prChecks(target: AttachmentTarget): GhCheck[];
}

export type CiProofStatus =
  | 'pass'           // current-head CI is green
  | 'pending'        // CI is still running — WAIT, do not treat as a review FAIL (#1221)
  | 'failing'        // a check is failing/cancelled — a real block
  | 'no_checks'      // CI has not produced any checks yet (also a wait candidate)
  | 'stale_head'     // reviewed SHA != PR head — re-review required
  | 'skipped_non_pr'; // target is an issue, not a PR — CI proof N/A (#1222.1)

export interface CiProofResult {
  status: CiProofStatus;
  detail?: string;
  reviewedHead?: string;
  currentHead?: string;
}

export type StoreReviewSummaryOptions = {
  /**
   * The commit SHA that was reviewed. If omitted, the current local HEAD is used.
   * Passing this explicitly lets review tooling prove CI belongs to the same
   * commit it reviewed even if the local worktree has moved.
   */
  expectedHeadSha?: string;
  /**
   * CI-proof boundary. Defaults to the real `gh`/`git` runner. Tests and
   * non-network callers inject a fake so storage stays deterministic (#1222).
   */
  ciRunner?: CiProofRunner;
};

/** Thrown when CI is still pending — callers should WAIT, not count a fix round (#1221). */
export class ReviewCiPendingError extends Error {
  constructor(public readonly result: CiProofResult) {
    super(result.detail ?? 'store-review-summary: CI is still pending for the reviewed head');
    this.name = 'ReviewCiPendingError';
  }
}

/** Thrown when CI is genuinely not green (failing / stale head) — a real block. */
export class ReviewCiNotPassedError extends Error {
  constructor(public readonly result: CiProofResult) {
    super(result.detail ?? 'store-review-summary: CI is not green for the reviewed head');
    this.name = 'ReviewCiNotPassedError';
  }
}

function spawnText(command: string, args: string[], failureContext: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`${failureContext}: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? '').trim();
  if ((result.status ?? 0) !== 0 && !stdout) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`${failureContext}: ${stderr || `${command} exited ${result.status}`}`);
  }
  return stdout;
}

/** Real `gh`/`git`-backed CI-proof runner used in production. */
export const defaultCiRunner: CiProofRunner = {
  reviewedHead(expectedHeadSha) {
    const explicit = expectedHeadSha?.trim();
    if (explicit) return explicit;
    return spawnText(
      'git',
      ['rev-parse', 'HEAD'],
      'store-review-summary: #1070 unable to determine reviewed HEAD; pass --head-sha explicitly',
    );
  },
  prHead(target) {
    return spawnText(
      'gh',
      ['pr', 'view', String(target.number), '--repo', target.repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
      'store-review-summary: #1070 unable to read current PR head',
    );
  },
  prChecks(target) {
    const stdout = spawnText(
      'gh',
      ['pr', 'checks', String(target.number), '--repo', target.repo, '--json', 'name,bucket,state,workflow,link'],
      'store-review-summary: #1070 unable to read PR checks',
    );
    try {
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error('JSON was not an array');
      return parsed as GhCheck[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`store-review-summary: #1070 unable to parse PR checks JSON (${msg})`);
    }
  },
};

function formatCheck(check: GhCheck): string {
  const workflow = check.workflow ? `${check.workflow} / ` : '';
  const name = check.name ?? '(unnamed check)';
  const bucket = check.bucket ?? 'unknown';
  const state = check.state ? ` (${check.state})` : '';
  return `${workflow}${name}: ${bucket}${state}`;
}

/**
 * Pure CI-proof evaluation given a runner. Returns a structured verdict instead
 * of throwing so callers can distinguish "wait" (pending / no_checks) from
 * "block" (failing / stale_head) — the #1221 deadlock fix. Non-PR targets are
 * skipped, never errored (#1222.1).
 */
export function evaluateCiProof(
  target: AttachmentTarget,
  options: StoreReviewSummaryOptions = {},
  runner: CiProofRunner = options.ciRunner ?? defaultCiRunner,
): CiProofResult {
  if (target.kind !== 'pr') {
    return { status: 'skipped_non_pr', detail: 'CI proof is N/A for non-PR (issue) targets' };
  }

  const reviewedHead = runner.reviewedHead(options.expectedHeadSha);
  const currentHead = runner.prHead(target);
  if (currentHead !== reviewedHead) {
    return {
      status: 'stale_head',
      reviewedHead,
      currentHead,
      detail:
        `reviewed ${reviewedHead}, but PR #${target.number} is currently ${currentHead}. ` +
        `Re-review the current head before storing a pass summary.`,
    };
  }

  const checks = runner.prChecks(target);
  if (checks.length === 0) {
    return {
      status: 'no_checks',
      currentHead,
      detail: `CI has not produced checks for ${currentHead} yet`,
    };
  }

  const pending = checks.filter(c => c.bucket === 'pending');
  const failing = checks.filter(c => c.bucket !== 'pass' && c.bucket !== 'skipping' && c.bucket !== 'pending');
  if (failing.length > 0) {
    return {
      status: 'failing',
      currentHead,
      detail: `CI is not green for ${currentHead}: ${failing.map(formatCheck).join('; ')}`,
    };
  }
  if (pending.length > 0) {
    return {
      status: 'pending',
      currentHead,
      detail: `CI is still pending for ${currentHead}: ${pending.map(formatCheck).join('; ')}`,
    };
  }
  return { status: 'pass', currentHead };
}

/**
 * Assert CI proof for storing a PASS summary. `pass`/`skipped_non_pr` ⇒ ok.
 * `pending`/`no_checks` ⇒ ReviewCiPendingError (caller should wait, #1221).
 * `failing`/`stale_head` ⇒ ReviewCiNotPassedError (a real block).
 */
function assertReviewSummaryCiPassed(target: AttachmentTarget, options: StoreReviewSummaryOptions): void {
  const result = evaluateCiProof(target, options);
  switch (result.status) {
    case 'pass':
    case 'skipped_non_pr':
      return;
    case 'pending':
    case 'no_checks':
      throw new ReviewCiPendingError(result);
    default:
      throw new ReviewCiNotPassedError(result);
  }
}

export type WaitForCiOptions = StoreReviewSummaryOptions & {
  timeoutMs?: number;
  pollMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Poll CI until it reaches a terminal status (anything but `pending`/`no_checks`)
 * or the timeout elapses. Never throws on pending — returns the last result so the
 * caller decides. This is the wait-not-fail step #1221 calls for: "CI pending" is a
 * wait, not a review FAIL.
 */
export async function waitForCiTerminal(
  target: AttachmentTarget,
  options: WaitForCiOptions = {},
): Promise<CiProofResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = options.pollMs ?? 10 * 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  let result = evaluateCiProof(target, options);
  while ((result.status === 'pending' || result.status === 'no_checks') && Date.now() < deadline) {
    await sleep(pollMs);
    result = evaluateCiProof(target, options);
  }
  return result;
}

function extractSummaryRoundVerdict(summary: string): RoundVerdict | null {
  const meta = extractMetaBlock(summary) as { round_verdict?: RoundVerdict; verdict?: string } | null;
  if (!meta) return null;
  if (meta.round_verdict === 'PASS' || meta.round_verdict === 'PASS_WITH_PARTIALS' || meta.round_verdict === 'FAIL') {
    return meta.round_verdict;
  }
  if (meta.verdict === 'fail') return 'FAIL';
  if (meta.verdict === 'pass') return 'PASS';
  return null;
}

/**
 * Defensive coercion for CLI/API payloads. Supports legacy shapes (status-only,
 * missing findings) so storage/formatting never throw.
 */
export function normalizeReviewFindingData(input: unknown): ReviewFindingData {
  return normalizeReviewFindingDataContract(input);
}

/**
 * Format a dimension's findings as a structured attachment.
 *
 * Format:
 *   <!-- meta:{"round":5,"dimension":"correctness","verdict":"pass","done":3,"partial":0,"missing":0} -->
 *   ### correctness — PASS
 *   > One-line summary
 *   | # | Status | Requirement | Detail |
 *   |---|--------|-------------|--------|
 *   | 1 | ✅ DONE | ... | ... |
 */
function formatFinding(round: number, finding: ReviewFindingData): string {
  const meta = makeReviewFindingMeta(round, finding);
  const { done, partial, missing } = meta;

  const statsLine = [
    `Round ${round}`,
    finding.durationSec != null ? `${finding.durationSec}s` : null,
    finding.costUsd != null ? `$${finding.costUsd.toFixed(3)}` : null,
  ].filter(Boolean).join(' | ');

  const lines: string[] = [
    `<!-- meta:${JSON.stringify(meta)} -->`,
    `### ${finding.dimension} — ${finding.verdict.toUpperCase()}`,
    `*${statsLine}*`,
    '',
    `> ${finding.summary}`,
    '',
    '| # | Status | Requirement |',
    '|---|--------|-------------|',
  ];

  finding.findings.forEach((f, i) => {
    const icon = STATUS_ICON[f.status] ?? '❓';
    lines.push(`| ${i + 1} | ${icon} ${f.status} | ${f.requirement} |`);
  });

  lines.push('', `**${finding.findings.length} findings**: ${done} DONE, ${partial} PARTIAL, ${missing} MISSING`);

  // Expanded details for non-DONE findings
  const nonDone = finding.findings
    .map((f, index) => ({ finding: f, index }))
    .filter(({ finding: f }) => f.status !== 'DONE');
  if (nonDone.length > 0) {
    lines.push('', '---', '');
    for (const { finding: f, index } of nonDone) {
      const idx = index + 1;
      const icon = STATUS_ICON[f.status] ?? '❓';
      lines.push(`#### ${idx}. ${icon} ${f.requirement}`, '');
      lines.push(f.detail);
      if (f.analysis) {
        lines.push('', f.analysis);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Parse the machine-readable meta from a stored finding attachment.
 */
export function parseFindingMeta(content: string): { round: number; dimension: string; verdict: string; done: number; partial: number; missing: number } | null {
  const meta = extractReviewFindingMeta(content);
  if (!meta) return null;
  const { round, dimension, verdict, done, partial, missing } = meta as ReviewFindingMeta;
  return { round, dimension, verdict, done, partial, missing };
}

/**
 * Store a single dimension's review findings for a specific round.
 * Attachment name: review/r{round}/{dimension}
 */
export function storeReviewFinding(
  target: AttachmentTarget,
  round: number,
  finding: ReviewFindingData,
): string {
  const normalized = normalizeReviewFindingData(finding);
  return writeAttachment(target, `review/r${round}/${normalized.dimension}`, formatFinding(round, normalized));
}

/**
 * Compose a round summary from all stored dimension findings.
 * Reads each dimension's attachment, parses meta, builds a summary table.
 */
export function composeReviewSummary(target: AttachmentTarget, round: number): string {
  const dims = listReviewDimensions(target, round);
  const rows: RoundRow[] = [];

  for (const dim of dims) {
    const content = readReviewFinding(target, round, dim);
    if (!content) continue;
    const meta = parseFindingMeta(content);
    if (meta) {
      rows.push({ dim: meta.dimension, verdict: meta.verdict, done: meta.done, partial: meta.partial, missing: meta.missing });
    }
  }

  const roll = summarizeRound(rows);
  // Header verdict mirrors the three-state rule; the `verdict` field in meta stays pass|fail so
  // downstream consumers (gates, parsers) keep a binary signal — PASS_WITH_PARTIALS maps to pass.
  const headerVerdict = roll.verdict === 'FAIL' ? 'FAIL'
    : roll.verdict === 'PASS_WITH_PARTIALS' ? `PASS — ${roll.totalPartial} PARTIAL`
    : 'PASS';
  const metaVerdict = roll.verdict === 'FAIL' ? 'fail' : 'pass';
  const summaryMeta = JSON.stringify({ round, verdict: metaVerdict, round_verdict: roll.verdict, dimensions: roll.dimensions, pass: roll.passDims, fail: roll.failDims, partial: roll.partialDims, total_done: roll.totalDone, total_missing: roll.totalMissing, total_partial: roll.totalPartial });

  const lines: string[] = [
    `<!-- meta:${summaryMeta} -->`,
    `## Review Round ${round} — ${headerVerdict}`,
    '',
    '| Dimension | Verdict | DONE | PARTIAL | MISSING |',
    '|-----------|---------|------|---------|---------|',
  ];

  for (const r of rows) {
    const icon = r.missing > 0 ? '❌' : r.partial > 0 ? '⚠️' : '✅';
    const label = r.missing > 0 ? 'FAIL' : r.partial > 0 ? 'PARTIAL' : 'PASS';
    lines.push(`| ${r.dim} | ${icon} ${label} | ${r.done} | ${r.partial} | ${r.missing} |`);
  }

  lines.push('', `**Overall**: ${roll.passDims} PASS, ${roll.partialDims} PARTIAL, ${roll.failDims} FAIL | ${roll.totalMissing} MISSING, ${roll.totalPartial} PARTIAL findings across ${roll.dimensions} dimensions`);
  return lines.join('\n');
}

/**
 * Compute the authoritative round verdict from stored findings — never from caller text.
 * Exposed so the storeReviewSummary guard and external callers share one derivation.
 */
export function deriveStoredRoundVerdict(target: AttachmentTarget, round: number): RoundVerdict {
  const rows: RoundRow[] = [];
  for (const dim of listReviewDimensions(target, round)) {
    const content = readReviewFinding(target, round, dim);
    if (!content) continue;
    const meta = parseFindingMeta(content);
    if (meta) rows.push({ dim: meta.dimension, verdict: meta.verdict, done: meta.done, partial: meta.partial, missing: meta.missing });
  }
  return summarizeRound(rows).verdict;
}

/**
 * Store the round summary.
 *
 * The authoritative verdict block is ALWAYS derived from the stored per-dimension findings via
 * composeReviewSummary() — a caller can never substitute a hand-written verdict for it (#1019).
 * An optional `note` is appended below as clearly-labelled, non-authoritative commentary.
 *
 * Fail-closed guard: if the note overtly asserts the round PASSED while the derived verdict is
 * FAIL, throw — the agent must fix the findings or escalate, not narrate a passing verdict on
 * top of failing data (the exact #1019 bypass). The derived block stays authoritative either way.
 *
 * Attachment name: review/r{round}/summary
 */
export function storeReviewSummary(
  target: AttachmentTarget,
  round: number,
  note?: string,
  options: StoreReviewSummaryOptions = {},
): string {
  const derived = composeReviewSummary(target, round);
  const roundVerdict = extractSummaryRoundVerdict(derived) ?? deriveStoredRoundVerdict(target, round);
  if (roundVerdict !== 'FAIL') {
    assertReviewSummaryCiPassed(target, options);
  }

  let content = derived;

  const trimmed = note?.trim();
  if (trimmed) {
    if (roundVerdict === 'FAIL' && assertsPass(trimmed)) {
      throw new Error(
        `store-review-summary: refusing to store a note that asserts the round PASSED while the ` +
        `stored findings derive FAIL (MISSING findings present). This is the #1019 fabrication ` +
        `pattern. Either fix the findings (re-run the dimension), or escalate to a human reviewer ` +
        `— do not narrate a passing verdict over failing data. Note was: ${JSON.stringify(trimmed)}`,
      );
    }
    content = `${derived}\n\n### Reviewer notes (non-authoritative — verdict above is derived from findings)\n\n${trimmed}`;
  }

  return writeAttachment(target, `review/r${round}/summary`, content);
}

/**
 * List all review rounds that have data.
 * Returns sorted round numbers: [1, 2, 3, ...]
 */
export function listReviewRounds(target: AttachmentTarget): number[] {
  const names = listAttachments(target, 'review/r');
  const rounds = new Set<number>();
  for (const name of names) {
    const match = name.match(/^review\/r(\d+)\//);
    if (match) rounds.add(parseInt(match[1], 10));
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * List dimension names that have findings for a specific round.
 */
export function listReviewDimensions(target: AttachmentTarget, round: number): string[] {
  const names = listAttachments(target, `review/r${round}/`);
  return names
    .map(n => n.replace(`review/r${round}/`, ''))
    .filter(n => n !== 'summary');
}

/**
 * Read findings for a specific dimension in a specific round.
 */
export function readReviewFinding(target: AttachmentTarget, round: number, dimension: string): string | null {
  const attachment = readAttachment(target, `review/r${round}/${dimension}`);
  return attachment?.content ?? null;
}

/**
 * Read the round summary.
 */
export function readReviewSummary(target: AttachmentTarget, round: number): string | null {
  const attachment = readAttachment(target, `review/r${round}/summary`);
  return attachment?.content ?? null;
}

/**
 * Get the latest review round number, or 0 if no reviews exist.
 */
export function latestReviewRound(target: AttachmentTarget): number {
  const rounds = listReviewRounds(target);
  return rounds.length > 0 ? rounds[rounds.length - 1] : 0;
}

// ── Plans ───────────────────────────────────────────────────────────

/**
 * Store an implementation plan on an issue.
 */
export function storePlan(target: AttachmentTarget, planText: string): string {
  return writeAttachment(target, 'plan', planText);
}

/**
 * Store a test plan on an issue.
 */
export function storeTestPlan(target: AttachmentTarget, testPlanText: string): string {
  return writeAttachment(target, 'testplan', testPlanText);
}

/**
 * Retrieve plan text. Checks attachment first, falls back to issue body ## Plan section.
 */
export function retrievePlan(target: AttachmentTarget & SectionTarget): string | null {
  const attachment = readAttachment(target, 'plan');
  if (attachment) return attachment.content;

  try {
    const body = fetchBody(target);
    const planRe = /## (?:Implementation )?Plan\b[\s\S]*?(?=\n## |\n```yaml|$)/i;
    const match = body.match(planRe);
    return match ? match[0] : null;
  } catch { return null; }
}

/**
 * Retrieve test plan text. Lookup order:
 *   1. Dedicated `testplan` attachment
 *   2. `## Test Plan` (or `## Seam Map & Test Plan`) section inside the `plan` attachment
 *   3. `## Test Plan` section inside the issue body
 *
 * A single `store-plan` call with a plan that contains the section is
 * enough — review dimensions retrieve the test plan via this function.
 */
export function retrieveTestPlan(target: AttachmentTarget & SectionTarget): string | null {
  const dedicated = readAttachment(target, 'testplan');
  if (dedicated) return dedicated.content;

  // Fall back to the plan attachment's Test Plan section
  const planAttachment = readAttachment(target, 'plan');
  if (planAttachment) {
    const section = findTestPlanSection(planAttachment.content);
    if (section) return section;
  }

  try {
    const body = fetchBody(target);
    const section = findTestPlanSection(body);
    if (section) return section;
  } catch { /* fall through */ }

  return null;
}

/** Extract a ## Test Plan section from markdown text. */
function findTestPlanSection(markdown: string): string | null {
  const sections = parseSections(markdown);
  const testPlan = sections.find(s => /^(Test Plan|Seam Map.*Test Plan)/i.test(s.name));
  return testPlan?.content ?? null;
}

// ── Metadata (connected issues, PR number) ──────────────────────────

export interface ConnectedIssue {
  number: number;
  role: 'primary' | 'duplicate' | 'follow-up' | 'related' | string;
  title: string;
}

/**
 * Store YAML metadata as an attachment.
 */
export function storeMetadata(target: AttachmentTarget, data: Record<string, unknown>): string {
  return writeAttachment(target, 'metadata', `\`\`\`yaml\n${YAML.stringify(data)}\`\`\``);
}

/**
 * Retrieve parsed YAML metadata. Checks attachment first, falls back to body ```yaml block.
 */
export function retrieveMetadata(target: AttachmentTarget & SectionTarget): Record<string, unknown> | null {
  const sources = [
    () => readAttachment(target, 'metadata')?.content,
    () => { try { return fetchBody(target); } catch { return null; } },
  ];
  for (const src of sources) {
    const text = src();
    if (!text) continue;
    const match = text.match(/```yaml\n([\s\S]*?)```/);
    if (match) {
      try { return YAML.parse(match[1]) as Record<string, unknown>; } catch { continue; }
    }
  }
  return null;
}

/**
 * Store connected issues in metadata.
 */
export function storeConnectedIssues(target: AttachmentTarget & SectionTarget, issues: ConnectedIssue[], extra?: Record<string, unknown>): string {
  const existing = retrieveMetadata(target) ?? {};
  const deepDive = (existing.deep_dive as Record<string, unknown>) ?? {};
  deepDive.connected_issues = issues;
  if (extra) Object.assign(deepDive, extra);
  existing.deep_dive = deepDive;
  return storeMetadata(target, existing);
}

/**
 * Query connected issues from metadata.
 */
export function queryConnectedIssues(target: AttachmentTarget & SectionTarget): ConnectedIssue[] {
  const meta = retrieveMetadata(target);
  if (!meta) return [];
  const deepDive = meta.deep_dive as Record<string, unknown> | undefined;
  const connected = deepDive?.connected_issues as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(connected)) return [];
  return connected.map(item => ({
    number: Number(item.number),
    role: String(item.role ?? 'unknown'),
    title: String(item.title ?? ''),
  }));
}

/**
 * Query PR number from metadata.
 */
export function queryPrNumber(target: AttachmentTarget & SectionTarget): number | null {
  const meta = retrieveMetadata(target);
  if (!meta) return null;
  const deepDive = meta.deep_dive as Record<string, unknown> | undefined;
  return deepDive?.pr ? Number(deepDive.pr) : null;
}

// ── PR Body Sections ────────────────────────────────────────────────

/**
 * Update or add a named section in the PR body.
 * Common sections: "Validation", "Known limitations", "Review Status"
 */
export function updatePrSection(target: SectionTarget, sectionName: string, content: string): void {
  addSection(target, sectionName, content);
}

/**
 * Read a named section from the PR body without fetching the whole body.
 */
export { readSection } from './section-editor.js';

// ── Iteration State ─────────────────────────────────────────────────

/**
 * Store fix-loop or review iteration state on an issue/PR.
 * Survives session restarts — unlike /tmp state files.
 */
export function storeIterationState(target: AttachmentTarget, state: Record<string, unknown>): string {
  return writeAttachment(target, 'iteration/state', `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);
}

/**
 * Retrieve iteration state.
 */
export function retrieveIterationState(target: AttachmentTarget): Record<string, unknown> | null {
  const attachment = readAttachment(target, 'iteration/state');
  if (!attachment) return null;
  const match = attachment.content.match(/```json\n([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
