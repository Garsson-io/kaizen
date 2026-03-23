#!/usr/bin/env npx tsx
/**
 * staleness-audit — Identify stale issues that may be obsolete.
 *
 * Queries GitHub for open issues older than a threshold with no comments,
 * checks if referenced files/functions still exist in the codebase,
 * and produces a report with recommendations (close/keep/investigate).
 *
 * Usage:
 *   npx tsx scripts/staleness-audit.ts [--days 90] [--repo Garsson-io/kaizen] [--json]
 *
 * Can be invoked by the subtraction mode prompt template or /kaizen-audit-issues.
 *
 * See issue #569.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Types

export interface StaleIssue {
  number: number;
  title: string;
  createdAt: string;
  ageDays: number;
  commentCount: number;
  labels: string[];
  /** Files referenced in the issue body that no longer exist */
  missingRefs: string[];
  /** Files referenced that still exist */
  existingRefs: string[];
  /** Whether the issue's area has been heavily changed recently */
  areaChanged: boolean;
  /** Recommendation: close, investigate, or keep */
  recommendation: 'close' | 'investigate' | 'keep';
  /** Reason for the recommendation */
  reason: string;
}

export interface AuditReport {
  repo: string;
  staleDays: number;
  auditDate: string;
  issues: StaleIssue[];
  summary: {
    total: number;
    closeRecommended: number;
    investigateRecommended: number;
    keepRecommended: number;
  };
}

// GitHub helpers

interface GhIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: { name: string }[];
  comments: { totalCount: number };
}

export function fetchStaleIssues(repo: string, staleDays: number): GhIssue[] {
  const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();

  // Fetch issues with body and comment counts
  const cmd = [
    'gh', 'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', '200',
    '--json', 'number,title,body,createdAt,labels,comments',
  ].join(' ');

  try {
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 30_000 });
    const issues: GhIssue[] = JSON.parse(raw);

    return issues.filter((issue) => {
      const created = new Date(issue.createdAt);
      return created.toISOString() < cutoff && issue.comments.totalCount === 0;
    });
  } catch {
    return [];
  }
}

// Reference extraction

/** Extract file paths referenced in issue body (e.g., src/foo.ts, scripts/bar.sh) */
export function extractFileRefs(body: string): string[] {
  if (!body) return [];

  const refs = new Set<string>();

  // Match paths like src/foo.ts, scripts/bar.sh, .claude/hooks/something.sh
  const pathPattern = /(?:^|\s|`)((?:src|scripts|\.claude|docs|prompts|tests?)\/[\w\-./]+\.\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(body)) !== null) {
    refs.add(match[1]);
  }

  return [...refs];
}

/** Extract function/class names referenced in issue body */
export function extractCodeRefs(body: string): string[] {
  if (!body) return [];

  const refs = new Set<string>();

  // Match function names in backticks like `functionName` or `ClassName`
  const codePattern = /`(\w{3,}(?:\.\w+)?)`/g;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(body)) !== null) {
    const name = match[1];
    // Filter out common words and short strings
    if (!isCommonWord(name) && /[a-z]/.test(name) && /[A-Z]/.test(name)) {
      refs.add(name);
    }
  }

  return [...refs];
}

const COMMON_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
  'object', 'Error', 'Promise', 'Array', 'Record', 'void',
]);

function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word);
}

// Codebase checks

export function fileExists(filePath: string, repoRoot: string): boolean {
  return existsSync(resolve(repoRoot, filePath));
}

/** Check if a code reference (function/class name) exists in the codebase */
export function codeRefExists(name: string, repoRoot: string): boolean {
  try {
    const result = execSync(
      `grep -rl "${name}" --include="*.ts" --include="*.sh" --include="*.md" src/ scripts/ .claude/ 2>/dev/null | head -1`,
      { encoding: 'utf8', cwd: repoRoot, timeout: 10_000 },
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if files in an area have been heavily changed since the issue was created */
export function areaChangedSince(labels: string[], createdAt: string, repoRoot: string): boolean {
  // Map labels to directory patterns
  const areaPaths: Record<string, string> = {
    'area/hooks': '.claude/hooks/ src/hooks/',
    'area/skills': '.claude/kaizen/skills/',
    'area/testing': 'src/ scripts/',
    'area/worktree': 'src/claude-wt.ts src/worktree-du.ts',
    'area/deploy': 'scripts/',
    'area/container': 'Dockerfile docker-compose.yml',
    'area/cases': 'src/lib/',
    'auto-dent': 'scripts/auto-dent*',
    'overnight-dent': 'scripts/auto-dent*',
  };

  for (const label of labels) {
    const paths = areaPaths[label];
    if (!paths) continue;

    try {
      const count = execSync(
        `git log --since="${createdAt}" --oneline -- ${paths} 2>/dev/null | wc -l`,
        { encoding: 'utf8', cwd: repoRoot, timeout: 10_000 },
      ).trim();
      if (parseInt(count, 10) > 20) return true;
    } catch {
      // continue
    }
  }

  return false;
}

// Analysis

export function analyzeIssue(issue: GhIssue, repoRoot: string): StaleIssue {
  const ageDays = Math.floor(
    (Date.now() - new Date(issue.createdAt).getTime()) / 86400_000,
  );
  const labels = issue.labels.map((l) => l.name);

  // Check file references
  const fileRefs = extractFileRefs(issue.body);
  const missingRefs: string[] = [];
  const existingRefs: string[] = [];
  for (const ref of fileRefs) {
    if (fileExists(ref, repoRoot)) {
      existingRefs.push(ref);
    } else {
      missingRefs.push(ref);
    }
  }

  // Check code references
  const codeRefs = extractCodeRefs(issue.body);
  for (const ref of codeRefs) {
    if (!codeRefExists(ref, repoRoot)) {
      missingRefs.push(ref);
    }
  }

  // Check area changes
  const areaChanged = areaChangedSince(labels, issue.createdAt, repoRoot);

  // Determine recommendation
  const { recommendation, reason } = recommend(
    ageDays,
    missingRefs,
    existingRefs,
    areaChanged,
    labels,
  );

  return {
    number: issue.number,
    title: issue.title,
    createdAt: issue.createdAt,
    ageDays,
    commentCount: issue.comments.totalCount,
    labels,
    missingRefs,
    existingRefs,
    areaChanged,
    recommendation,
    reason,
  };
}

export function recommend(
  ageDays: number,
  missingRefs: string[],
  existingRefs: string[],
  areaChanged: boolean,
  labels: string[],
): { recommendation: 'close' | 'investigate' | 'keep'; reason: string } {
  // Strong signal: most referenced files/code no longer exist
  if (missingRefs.length > 0 && existingRefs.length === 0 && missingRefs.length >= 2) {
    return {
      recommendation: 'close',
      reason: `${missingRefs.length} referenced files/symbols no longer exist in codebase`,
    };
  }

  // Medium signal: area heavily reworked + old issue
  if (areaChanged && ageDays > 120) {
    return {
      recommendation: 'investigate',
      reason: `area heavily reworked since issue was filed ${ageDays} days ago`,
    };
  }

  // Some missing refs but not all
  if (missingRefs.length > 0 && existingRefs.length > 0) {
    return {
      recommendation: 'investigate',
      reason: `${missingRefs.length} of ${missingRefs.length + existingRefs.length} referenced files/symbols are missing`,
    };
  }

  // Aspirational/epic issues are expected to be long-lived
  if (labels.some((l) => l === 'epic' || l === 'aspirational' || l === 'prd' || l.startsWith('horizon'))) {
    return {
      recommendation: 'keep',
      reason: 'epic/aspirational/prd/horizon issues are long-lived by design',
    };
  }

  // Very old with no references to check — investigate
  if (ageDays > 180) {
    return {
      recommendation: 'investigate',
      reason: `${ageDays} days old with no comments — may be obsolete`,
    };
  }

  return {
    recommendation: 'keep',
    reason: 'no strong staleness signals detected',
  };
}

// Report generation

export function generateReport(
  repo: string,
  staleDays: number,
  issues: StaleIssue[],
): AuditReport {
  const sorted = [...issues].sort((a, b) => {
    const order = { close: 0, investigate: 1, keep: 2 };
    return order[a.recommendation] - order[b.recommendation] || b.ageDays - a.ageDays;
  });

  return {
    repo,
    staleDays,
    auditDate: new Date().toISOString().split('T')[0],
    issues: sorted,
    summary: {
      total: sorted.length,
      closeRecommended: sorted.filter((i) => i.recommendation === 'close').length,
      investigateRecommended: sorted.filter((i) => i.recommendation === 'investigate').length,
      keepRecommended: sorted.filter((i) => i.recommendation === 'keep').length,
    },
  };
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Staleness Audit — ${report.repo}`);
  lines.push(`Date: ${report.auditDate} | Threshold: ${report.staleDays} days | Found: ${report.summary.total} stale issues`);
  lines.push('');

  lines.push(`## Summary`);
  lines.push(`- Close recommended: ${report.summary.closeRecommended}`);
  lines.push(`- Investigate recommended: ${report.summary.investigateRecommended}`);
  lines.push(`- Keep recommended: ${report.summary.keepRecommended}`);
  lines.push('');

  for (const issue of report.issues) {
    const icon = { close: 'X', investigate: '?', keep: '-' }[issue.recommendation];
    lines.push(
      `[${icon}] #${issue.number} — ${issue.title} (${issue.ageDays}d)`,
    );
    lines.push(`    Recommendation: ${issue.recommendation} — ${issue.reason}`);
    if (issue.missingRefs.length > 0) {
      lines.push(`    Missing refs: ${issue.missingRefs.join(', ')}`);
    }
    if (issue.areaChanged) {
      lines.push(`    Area heavily changed since filing`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// CLI

function getRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function main() {
  const args = process.argv.slice(2);

  let staleDays = 90;
  let repo = '';
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      staleDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  if (!repo) {
    try {
      const kaizenConfig = JSON.parse(
        execSync('cat kaizen.config.json', { encoding: 'utf8' }),
      );
      repo = kaizenConfig.kaizen?.repo || kaizenConfig.host?.repo || '';
    } catch {
      // fall through
    }
  }

  if (!repo) {
    console.error('Usage: staleness-audit.ts --repo <owner/repo> [--days N] [--json]');
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  console.error(`Scanning ${repo} for issues older than ${staleDays} days with no comments...`);

  const staleIssues = fetchStaleIssues(repo, staleDays);
  console.error(`Found ${staleIssues.length} candidate issues`);

  const analyzed = staleIssues.map((issue) => analyzeIssue(issue, repoRoot));
  const report = generateReport(repo, staleDays, analyzed);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}

// Only run main when executed directly (not imported for testing)
const isMain = process.argv[1]?.endsWith('staleness-audit.ts') ||
  process.argv[1]?.includes('staleness-audit');
if (isMain) {
  main();
}
