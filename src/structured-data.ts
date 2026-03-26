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

export interface ReviewFindingData {
  dimension: string;
  verdict: 'pass' | 'fail';
  summary: string;
  findings: Array<{ requirement: string; status: string; detail: string }>;
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
  const content = `**${finding.dimension}**: ${finding.verdict.toUpperCase()}\n\n> ${finding.summary}\n\n` +
    finding.findings.map(f => {
      const icon = f.status === 'DONE' ? '[x]' : f.status === 'PARTIAL' ? '[-]' : '[ ]';
      return `- ${icon} **${f.requirement}**: ${f.status} — ${f.detail}`;
    }).join('\n');
  return writeAttachment(target, `review/r${round}/${finding.dimension}`, content);
}

/**
 * Store the overall round summary (main agent's assessment).
 * Attachment name: review/r{round}/summary
 */
export function storeReviewSummary(
  target: AttachmentTarget,
  round: number,
  summary: string,
): string {
  return writeAttachment(target, `review/r${round}/summary`, summary);
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
