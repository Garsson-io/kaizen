/**
 * plan-store.ts — Mechanistic plan/metadata storage against GitHub issues.
 *
 * Stores and retrieves plan text and YAML structured metadata as GitHub
 * issue comments. No local filesystem — issues are the canonical store.
 * Cross-session, cross-worktree, discoverable by any agent.
 *
 * Storage format: a comment with a marker header and fenced content:
 *   <!-- kaizen:plan -->
 *   ## Plan
 *   ...plan text...
 *
 *   <!-- kaizen:metadata -->
 *   ```yaml
 *   deep_dive:
 *     connected_issues: [...]
 *   ```
 *
 * Part of kaizen issue #902, #905.
 */

import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// Marker comments used to identify kaizen-managed content in issue comments
export const PLAN_MARKER = '<!-- kaizen:plan -->';
export const METADATA_MARKER = '<!-- kaizen:metadata -->';
export const TESTPLAN_MARKER = '<!-- kaizen:testplan -->';

export interface PlanStoreOptions {
  /** GitHub issue number */
  issueNum: string;
  /** GitHub repo (owner/repo) */
  repo: string;
}

export interface StoredPlan {
  /** The plan text (markdown) */
  planText: string;
  /** Which comment contains it (for updates) */
  commentUrl?: string;
}

export interface StoredMetadata {
  /** Parsed YAML metadata */
  data: Record<string, unknown>;
  /** Which comment contains it */
  commentUrl?: string;
}

/** Run a gh CLI command and return stdout. Throws on failure. */
function gh(args: string[]): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout?.trim() ?? '';
}

/**
 * Store plan text as a comment on a GitHub issue.
 * If a plan comment already exists (has PLAN_MARKER), updates it.
 * Otherwise creates a new comment.
 */
export function storePlan(opts: PlanStoreOptions, planText: string): string {
  const body = `${PLAN_MARKER}\n${planText}`;
  const existing = findMarkerComment(opts, PLAN_MARKER);
  if (existing) {
    gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--edit-last', '--body', body]);
    return existing.url;
  }
  const url = gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--body', body]);
  return url;
}

/**
 * Store test plan text as a comment on a GitHub issue.
 */
export function storeTestPlan(opts: PlanStoreOptions, testPlanText: string): string {
  const body = `${TESTPLAN_MARKER}\n${testPlanText}`;
  const existing = findMarkerComment(opts, TESTPLAN_MARKER);
  if (existing) {
    gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--edit-last', '--body', body]);
    return existing.url;
  }
  const url = gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--body', body]);
  return url;
}

/**
 * Store YAML structured metadata as a comment on a GitHub issue.
 */
export function storeMetadata(opts: PlanStoreOptions, data: Record<string, unknown>): string {
  const yamlStr = YAML.stringify(data);
  const body = `${METADATA_MARKER}\n\`\`\`yaml\n${yamlStr}\`\`\``;
  const existing = findMarkerComment(opts, METADATA_MARKER);
  if (existing) {
    gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--edit-last', '--body', body]);
    return existing.url;
  }
  const url = gh(['issue', 'comment', opts.issueNum, '--repo', opts.repo, '--body', body]);
  return url;
}

/**
 * Retrieve plan text from a GitHub issue (body or comments).
 * Checks: (1) issue body for ## Plan section, (2) comments with PLAN_MARKER.
 * Returns null if no plan found.
 */
export function retrievePlan(opts: PlanStoreOptions): StoredPlan | null {
  // Check comments first (structured storage takes priority)
  const markerComment = findMarkerComment(opts, PLAN_MARKER);
  if (markerComment) {
    const text = markerComment.body.replace(PLAN_MARKER, '').trim();
    return { planText: text, commentUrl: markerComment.url };
  }

  // Fall back to issue body (may have plan inline)
  const issueBody = gh(['issue', 'view', opts.issueNum, '--repo', opts.repo, '--json', 'body', '--jq', '.body']);
  const planMatch = issueBody.match(/## (?:Implementation )?Plan\b[\s\S]*?(?=\n## |\n```yaml|$)/i);
  if (planMatch) {
    return { planText: planMatch[0] };
  }

  return null;
}

/**
 * Retrieve test plan text from a GitHub issue.
 */
export function retrieveTestPlan(opts: PlanStoreOptions): StoredPlan | null {
  const markerComment = findMarkerComment(opts, TESTPLAN_MARKER);
  if (markerComment) {
    const text = markerComment.body.replace(TESTPLAN_MARKER, '').trim();
    return { planText: text, commentUrl: markerComment.url };
  }

  // Fall back to issue body
  const issueBody = gh(['issue', 'view', opts.issueNum, '--repo', opts.repo, '--json', 'body', '--jq', '.body']);
  const testPlanMatch = issueBody.match(/## Test Plan\b[\s\S]*?(?=\n## |$)/i);
  if (testPlanMatch) {
    return { planText: testPlanMatch[0] };
  }

  return null;
}

/**
 * Retrieve YAML structured metadata from a GitHub issue.
 */
export function retrieveMetadata(opts: PlanStoreOptions): StoredMetadata | null {
  // Check comments with marker
  const markerComment = findMarkerComment(opts, METADATA_MARKER);
  if (markerComment) {
    const yamlMatch = markerComment.body.match(/```yaml\n([\s\S]*?)```/);
    if (yamlMatch) {
      try {
        const data = YAML.parse(yamlMatch[1]) as Record<string, unknown>;
        return { data, commentUrl: markerComment.url };
      } catch { /* fall through */ }
    }
  }

  // Fall back to issue body (may have YAML metadata inline)
  const issueBody = gh(['issue', 'view', opts.issueNum, '--repo', opts.repo, '--json', 'body', '--jq', '.body']);
  const yamlMatch = issueBody.match(/```yaml\n([\s\S]*?)```/);
  if (yamlMatch) {
    try {
      const data = YAML.parse(yamlMatch[1]) as Record<string, unknown>;
      return { data };
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Query connected issues from stored metadata.
 * Returns issue numbers with their roles from the deep_dive.connected_issues YAML.
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

// Internal: find a comment containing a specific marker
interface MarkerComment {
  url: string;
  body: string;
}

function findMarkerComment(opts: PlanStoreOptions, marker: string): MarkerComment | null {
  try {
    const raw = gh([
      'issue', 'view', opts.issueNum, '--repo', opts.repo,
      '--json', 'comments',
      '--jq', '.comments[] | {url: .url, body: .body}',
    ]);
    if (!raw) return null;

    // gh --jq outputs one JSON object per line
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const comment = JSON.parse(line) as { url: string; body: string };
        if (comment.body.includes(marker)) {
          return comment;
        }
      } catch { continue; }
    }
  } catch { /* gh command failed */ }
  return null;
}
