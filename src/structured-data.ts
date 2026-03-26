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

// ── Target helpers ──────────────────────────────────────────────────

export function prTarget(prNum: string, repo: string): AttachmentTarget & SectionTarget {
  return { kind: 'pr', number: prNum, repo };
}

export function issueTarget(issueNum: string, repo: string): AttachmentTarget & SectionTarget {
  return { kind: 'issue', number: issueNum, repo };
}

// ── Reviews ─────────────────────────────────────────────────────────

export interface ReviewFinding {
  requirement: string;
  status: 'DONE' | 'PARTIAL' | 'MISSING';
  /** Short label for the table row */
  detail: string;
  /** Full analysis text — file references, code snippets, fix suggestions. Shown below the table for non-DONE findings. */
  analysis?: string;
}

export interface ReviewFindingData {
  dimension: string;
  verdict: 'pass' | 'fail';
  summary: string;
  findings: ReviewFinding[];
  /** Review round number (shown in header) */
  round?: number;
  /** Wall-clock duration in seconds */
  durationSec?: number;
  /** Cost in USD */
  costUsd?: number;
}

const STATUS_ICON: Record<string, string> = { DONE: '✅', PARTIAL: '⚠️', MISSING: '❌' };

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
  const done = finding.findings.filter(f => f.status === 'DONE').length;
  const partial = finding.findings.filter(f => f.status === 'PARTIAL').length;
  const missing = finding.findings.filter(f => f.status === 'MISSING').length;

  const meta = JSON.stringify({
    round, dimension: finding.dimension, verdict: finding.verdict, done, partial, missing,
    ...(finding.durationSec != null ? { duration_sec: finding.durationSec } : {}),
    ...(finding.costUsd != null ? { cost_usd: finding.costUsd } : {}),
  });

  const statsLine = [
    `Round ${round}`,
    finding.durationSec != null ? `${finding.durationSec}s` : null,
    finding.costUsd != null ? `$${finding.costUsd.toFixed(3)}` : null,
  ].filter(Boolean).join(' | ');

  const lines: string[] = [
    `<!-- meta:${meta} -->`,
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
  const nonDone = finding.findings.filter(f => f.status !== 'DONE');
  if (nonDone.length > 0) {
    lines.push('', '---', '');
    for (const f of nonDone) {
      const idx = finding.findings.indexOf(f) + 1;
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
  const match = content.match(/<!-- meta:(\{.*?\}) -->/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
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
  return writeAttachment(target, `review/r${round}/${finding.dimension}`, formatFinding(round, finding));
}

/**
 * Compose a round summary from all stored dimension findings.
 * Reads each dimension's attachment, parses meta, builds a summary table.
 */
export function composeReviewSummary(target: AttachmentTarget, round: number): string {
  const dims = listReviewDimensions(target, round);
  const rows: Array<{ dim: string; verdict: string; done: number; partial: number; missing: number }> = [];

  for (const dim of dims) {
    const content = readReviewFinding(target, round, dim);
    if (!content) continue;
    const meta = parseFindingMeta(content);
    if (meta) {
      rows.push({ dim: meta.dimension, verdict: meta.verdict, done: meta.done, partial: meta.partial, missing: meta.missing });
    }
  }

  const totalPass = rows.filter(r => r.verdict === 'pass').length;
  const totalFail = rows.filter(r => r.verdict === 'fail').length;
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  const totalPartial = rows.reduce((s, r) => s + r.partial, 0);
  const overallVerdict = totalMissing === 0 ? 'PASS' : 'FAIL';
  const summaryMeta = JSON.stringify({ round, verdict: overallVerdict.toLowerCase(), dimensions: rows.length, pass: totalPass, fail: totalFail, total_missing: totalMissing, total_partial: totalPartial });

  const lines: string[] = [
    `<!-- meta:${summaryMeta} -->`,
    `## Review Round ${round} — ${overallVerdict}`,
    '',
    '| Dimension | Verdict | DONE | PARTIAL | MISSING |',
    '|-----------|---------|------|---------|---------|',
  ];

  for (const r of rows) {
    const icon = r.verdict === 'pass' ? '✅' : '❌';
    lines.push(`| ${r.dim} | ${icon} ${r.verdict.toUpperCase()} | ${r.done} | ${r.partial} | ${r.missing} |`);
  }

  lines.push('', `**Overall**: ${totalPass} PASS, ${totalFail} FAIL | ${totalMissing} MISSING, ${totalPartial} PARTIAL across ${rows.length} dimensions`);
  return lines.join('\n');
}

/**
 * Store the round summary. Prefer composeReviewSummary() to auto-generate from findings.
 * Attachment name: review/r{round}/summary
 */
export function storeReviewSummary(
  target: AttachmentTarget,
  round: number,
  summary?: string,
): string {
  const content = summary ?? composeReviewSummary(target, round);
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
 * Retrieve test plan text. Checks attachment first, falls back to body ## Test Plan.
 */
export function retrieveTestPlan(target: AttachmentTarget & SectionTarget): string | null {
  const attachment = readAttachment(target, 'testplan');
  if (attachment) return attachment.content;

  try {
    const body = fetchBody(target);
    const sections = parseSections(body);
    const testPlan = sections.find(s => /^Test Plan/i.test(s.name));
    return testPlan?.content ?? null;
  } catch { return null; }
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
