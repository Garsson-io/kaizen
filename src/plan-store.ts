/**
 * plan-store.ts — Plan/metadata storage on GitHub issues.
 *
 * Thin layer on top of section-editor.ts attachments. Provides domain-specific
 * functions (storePlan, retrievePlan, queryConnectedIssues) that delegate to
 * the general-purpose attachment system.
 *
 * Part of kaizen issue #902, #905.
 */

import YAML from 'yaml';
import {
  readAttachment,
  writeAttachment,
  fetchBody,
  parseSections,
  type AttachmentTarget,
  type SectionTarget,
} from './section-editor.js';

// Plan section regex — used as fallback when no attachment exists
const PLAN_SECTION_RE = /## (?:Implementation )?Plan\b[\s\S]*?(?=\n## |\n```yaml|$)/i;

/** Extract the first plan section from markdown text. */
export function extractPlanText(text: string): string | undefined {
  const match = text.match(PLAN_SECTION_RE);
  return match ? match[0] : undefined;
}

// Re-export constants for backward compatibility
export const PLAN_MARKER = '<!-- kaizen:plan -->';
export const METADATA_MARKER = '<!-- kaizen:metadata -->';
export const TESTPLAN_MARKER = '<!-- kaizen:testplan -->';

export interface PlanStoreOptions {
  issueNum: string;
  repo: string;
}

export interface StoredPlan {
  planText: string;
  commentUrl?: string;
}

export interface StoredMetadata {
  data: Record<string, unknown>;
  commentUrl?: string;
}

/** Convert PlanStoreOptions to AttachmentTarget. */
function toAttachmentTarget(opts: PlanStoreOptions): AttachmentTarget {
  return { kind: 'issue', number: opts.issueNum, repo: opts.repo };
}

/** Convert PlanStoreOptions to SectionTarget (for reading issue body). */
function toSectionTarget(opts: PlanStoreOptions): SectionTarget {
  return { kind: 'issue', number: opts.issueNum, repo: opts.repo };
}

/**
 * Store plan text as an attachment on a GitHub issue.
 */
export function storePlan(opts: PlanStoreOptions, planText: string): string {
  return writeAttachment(toAttachmentTarget(opts), 'plan', planText);
}

/**
 * Store test plan text as an attachment on a GitHub issue.
 */
export function storeTestPlan(opts: PlanStoreOptions, testPlanText: string): string {
  return writeAttachment(toAttachmentTarget(opts), 'testplan', testPlanText);
}

/**
 * Store YAML structured metadata as an attachment on a GitHub issue.
 */
export function storeMetadata(opts: PlanStoreOptions, data: Record<string, unknown>): string {
  const yamlStr = YAML.stringify(data);
  return writeAttachment(toAttachmentTarget(opts), 'metadata', `\`\`\`yaml\n${yamlStr}\`\`\``);
}

/**
 * Retrieve plan text from a GitHub issue.
 * Checks: (1) attachment with marker, (2) issue body ## Plan section.
 */
export function retrievePlan(opts: PlanStoreOptions): StoredPlan | null {
  // Check attachment first (structured storage takes priority)
  const attachment = readAttachment(toAttachmentTarget(opts), 'plan');
  if (attachment) {
    return { planText: attachment.content, commentUrl: attachment.url };
  }

  // Fall back to issue body
  try {
    const body = fetchBody(toSectionTarget(opts));
    const plan = extractPlanText(body);
    if (plan) return { planText: plan };
  } catch { /* best effort */ }

  return null;
}

/**
 * Retrieve test plan text from a GitHub issue.
 */
export function retrieveTestPlan(opts: PlanStoreOptions): StoredPlan | null {
  const attachment = readAttachment(toAttachmentTarget(opts), 'testplan');
  if (attachment) {
    return { planText: attachment.content, commentUrl: attachment.url };
  }

  // Fall back to issue body ## Test Plan section
  try {
    const body = fetchBody(toSectionTarget(opts));
    const sections = parseSections(body);
    const testPlan = sections.find(s => /^Test Plan/i.test(s.name));
    if (testPlan) return { planText: testPlan.content };
  } catch { /* best effort */ }

  return null;
}

/**
 * Retrieve YAML structured metadata from a GitHub issue.
 */
export function retrieveMetadata(opts: PlanStoreOptions): StoredMetadata | null {
  const attachment = readAttachment(toAttachmentTarget(opts), 'metadata');
  if (attachment) {
    const yamlMatch = attachment.content.match(/```yaml\n([\s\S]*?)```/);
    if (yamlMatch) {
      try {
        return { data: YAML.parse(yamlMatch[1]) as Record<string, unknown>, commentUrl: attachment.url };
      } catch { /* fall through */ }
    }
  }

  // Fall back to issue body
  try {
    const body = fetchBody(toSectionTarget(opts));
    const yamlMatch = body.match(/```yaml\n([\s\S]*?)```/);
    if (yamlMatch) {
      try {
        return { data: YAML.parse(yamlMatch[1]) as Record<string, unknown> };
      } catch { /* fall through */ }
    }
  } catch { /* best effort */ }

  return null;
}

/**
 * Query connected issues from stored metadata.
 */
export function queryConnectedIssues(
  opts: PlanStoreOptions,
): Array<{ number: number; role: string; title: string }> {
  const meta = retrieveMetadata(opts);
  if (!meta) return [];

  const deepDive = meta.data.deep_dive as Record<string, unknown> | undefined;
  if (!deepDive) return [];

  const connected = deepDive.connected_issues as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(connected)) return [];

  return connected.map(item => ({
    number: Number(item.number),
    role: String(item.role ?? 'unknown'),
    title: String(item.title ?? ''),
  }));
}

/**
 * Query the PR number from stored metadata.
 */
export function queryPrNumber(opts: PlanStoreOptions): number | null {
  const meta = retrieveMetadata(opts);
  if (!meta) return null;
  const deepDive = meta.data.deep_dive as Record<string, unknown> | undefined;
  return deepDive?.pr ? Number(deepDive.pr) : null;
}
