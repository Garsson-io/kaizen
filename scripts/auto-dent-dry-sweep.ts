#!/usr/bin/env npx tsx
/**
 * auto-dent-dry-sweep — deterministic cross-PR/codebase DRY drift context.
 *
 * This is the small, deterministic half of #1164. It does not refactor code
 * itself; it produces concrete candidates that reflection/review can judge.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gh as defaultGh } from '../src/lib/gh-exec.js';
import { writeAttachment } from '../src/section-editor.js';
import { escapeMarkdownTableCell } from './markdown-table.js';

export type MechanismDriftKind =
  | 'display_formatting'
  | 'github_execution'
  | 'progress_comments'
  | 'telemetry_events'
  | 'markdown_tables';

export interface DrySweepFile {
  path: string;
  content: string;
}

export interface MechanismEvidence {
  path: string;
  line: number;
  symbol: string;
  detail: string;
}

export interface RecentMergedPr {
  number: number;
  title: string;
  mergedAt: string;
  changedFiles: string[];
  url: string;
}

export interface MechanismDriftCandidate {
  kind: MechanismDriftKind;
  summary: string;
  evidence: MechanismEvidence[];
  files: string[];
  recentPrs: RecentMergedPr[];
  suggestedUnificationTarget: string;
  confidence: number;
}

export interface DrySweepReport {
  generatedAt: string;
  repo?: string;
  recentPrLimit: number;
  candidates: MechanismDriftCandidate[];
}

interface EvidenceRule {
  symbol: string;
  detail: string;
  re: RegExp;
  sharedTarget?: boolean;
}

interface FamilyRule {
  kind: MechanismDriftKind;
  summary: string;
  suggestedUnificationTarget: string;
  confidence: number;
  evidenceRules: EvidenceRule[];
  requireSharedAndCompeting?: boolean;
}

const FAMILY_RULES: FamilyRule[] = [
  {
    kind: 'github_execution',
    summary: 'GitHub CLI execution has multiple wrappers or shell-string paths',
    suggestedUnificationTarget: 'src/lib/gh-exec.ts gh(args) / ghResult(args)',
    confidence: 85,
    requireSharedAndCompeting: true,
    evidenceRules: [
      { symbol: 'gh(args)', detail: 'argv-based shared GitHub CLI helper', re: /\bgh(?:Result)?\s*\(\s*\[/, sharedTarget: true },
      { symbol: 'ghExec', detail: 'command-string GitHub CLI compatibility adapter', re: /\bghExec\s*\(/ },
      { symbol: 'shellExec', detail: 'local shell-style command execution helper', re: /\bshellExec\s*\(/ },
      { symbol: 'execSync(gh ...)', detail: 'direct gh command through execSync string', re: /\bexecSync\s*\(\s*`?gh\s+(?:issue|pr|api)\b/ },
    ],
  },
  {
    kind: 'progress_comments',
    summary: 'Progress/comment persistence uses direct comments alongside marker attachments',
    suggestedUnificationTarget: 'src/section-editor.ts writeAttachment marker-comment attachments',
    confidence: 85,
    requireSharedAndCompeting: true,
    evidenceRules: [
      { symbol: 'writeAttachment', detail: 'shared marker-comment attachment primitive', re: /\bwriteAttachment\s*\(/, sharedTarget: true },
      { symbol: 'gh issue comment', detail: 'direct issue comment write', re: /gh\s+issue\s+comment\b/ },
      { symbol: 'gh pr comment', detail: 'direct PR comment write', re: /gh\s+pr\s+comment\b/ },
      { symbol: 'addSection', detail: 'body-section persistence path', re: /\baddSection\s*\(/ },
    ],
  },
  {
    kind: 'telemetry_events',
    summary: 'Telemetry event envelopes have parallel schema definitions',
    suggestedUnificationTarget: 'a shared event envelope contract for auto-dent and interactive telemetry',
    confidence: 75,
    evidenceRules: [
      { symbol: 'EventEnvelope', detail: 'auto-dent event envelope shape', re: /\b(?:interface|type)\s+EventEnvelope\b/ },
      { symbol: 'SessionEventEnvelope', detail: 'interactive session event envelope shape', re: /\b(?:interface|type)\s+SessionEventEnvelope\b/ },
      { symbol: 'events.jsonl', detail: 'JSONL telemetry event stream', re: /\bevents\.jsonl\b/ },
    ],
  },
  {
    kind: 'display_formatting',
    summary: 'Display/truncation helpers exist in several adjacent presentation paths',
    suggestedUnificationTarget: 'scripts/auto-dent-display.ts and src/analysis/util.ts display helpers',
    confidence: 70,
    evidenceRules: [
      { symbol: 'truncateDisplay', detail: 'shared auto-dent display truncation helper', re: /\bfunction\s+truncateDisplay\s*\(/, sharedTarget: true },
      { symbol: 'truncateAfterPrefix', detail: 'prefix-preserving transcript truncation helper', re: /\bfunction\s+truncateAfterPrefix\s*\(/ },
      { symbol: 'truncateMiddle', detail: 'middle truncation helper for large attachments', re: /\bfunction\s+truncateMiddle\s*\(/ },
      { symbol: 'formatToolUse', detail: 'tool-use display formatter', re: /\bfunction\s+formatToolUse\s*\(/ },
    ],
  },
  {
    kind: 'markdown_tables',
    summary: 'Markdown table escaping has adjacent local and shared implementations',
    suggestedUnificationTarget: 'scripts/markdown-table.ts escapeMarkdownTableCell',
    confidence: 70,
    requireSharedAndCompeting: true,
    evidenceRules: [
      { symbol: 'escapeMarkdownTableCell', detail: 'shared markdown table escaping helper', re: /\bescapeMarkdownTableCell\s*\(/, sharedTarget: true },
      { symbol: 'manual markdown table join', detail: 'manual table row escaping/joining path', re: /\.join\(' \| '\)|\.replace\(\/\^\// },
    ],
  },
];

const SKIP_DIRS = new Set([
  '.git',
  '.claude',
  'node_modules',
  'dist',
  'coverage',
  'logs',
  '.vitest-results',
]);

const SCAN_ROOTS = ['scripts', 'src'];
const SCAN_EXTENSIONS = new Set(['.ts', '.sh']);

function lineFor(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extension(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i) : '';
}

function isProductionScanFile(path: string): boolean {
  return !(
    path.endsWith('.test.ts') ||
    path.endsWith('.e2e.test.ts') ||
    path.includes('/test-utils') ||
    path.includes('/e2e-test-utils')
  );
}

function uniqueByLocation(evidence: MechanismEvidence[]): MechanismEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const key = `${e.path}:${e.line}:${e.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceForRule(file: DrySweepFile, rule: EvidenceRule): MechanismEvidence[] {
  const evidence: MechanismEvidence[] = [];
  const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
  for (const match of file.content.matchAll(re)) {
    evidence.push({
      path: file.path,
      line: lineFor(file.content, match.index ?? 0),
      symbol: rule.symbol,
      detail: rule.detail,
    });
  }
  return evidence;
}

function relatedRecentPrs(files: string[], prs: RecentMergedPr[]): RecentMergedPr[] {
  const fileSet = new Set(files);
  return prs.filter(pr => pr.changedFiles.some(f => fileSet.has(f)));
}

export function collectMechanismDriftCandidates(
  files: DrySweepFile[],
  recentPrs: RecentMergedPr[] = [],
): MechanismDriftCandidate[] {
  const candidates: MechanismDriftCandidate[] = [];

  for (const family of FAMILY_RULES) {
    const evidenceByRule = family.evidenceRules.map(rule => ({
      rule,
      evidence: uniqueByLocation(files.flatMap(file => evidenceForRule(file, rule))),
    }));
    const evidence = uniqueByLocation([
      ...evidenceByRule.filter(r => !r.rule.sharedTarget).flatMap(r => r.evidence),
      ...evidenceByRule.filter(r => r.rule.sharedTarget).flatMap(r => r.evidence),
    ]);
    const touchedFiles = [...new Set(evidence.map(e => e.path))].sort();
    if (evidence.length < 2 || touchedFiles.length < 2) continue;

    if (family.requireSharedAndCompeting) {
      const hasSharedTarget = evidenceByRule.some(r => r.rule.sharedTarget && r.evidence.length > 0);
      const competingRules = evidenceByRule.filter(r => !r.rule.sharedTarget && r.evidence.length > 0);
      const hasCompetingPath = competingRules.length > 0;
      const hasMultipleCompetingPaths = competingRules.length >= 2;
      if ((!hasSharedTarget || !hasCompetingPath) && !hasMultipleCompetingPaths) continue;
    }

    candidates.push({
      kind: family.kind,
      summary: family.summary,
      evidence,
      files: touchedFiles,
      recentPrs: relatedRecentPrs(touchedFiles, recentPrs),
      suggestedUnificationTarget: family.suggestedUnificationTarget,
      confidence: family.confidence,
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence || a.kind.localeCompare(b.kind));
}

export interface FetchRecentPrDeps {
  gh?: (args: string[], timeoutMs?: number) => string;
}

interface GhPrPayload {
  number?: number;
  title?: string;
  mergedAt?: string;
  files?: Array<{ path?: string } | string>;
  url?: string;
}

export function fetchRecentMergedPrs(
  repo: string,
  limit: number,
  deps: FetchRecentPrDeps = {},
): RecentMergedPr[] {
  const runGh = deps.gh ?? defaultGh;
  try {
    const raw = runGh([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'merged',
      '--limit',
      String(limit),
      '--json',
      'number,title,mergedAt,files,url',
    ]);
    const parsed = JSON.parse(raw) as GhPrPayload[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((pr) => {
      if (typeof pr.number !== 'number') return [];
      const changedFiles = Array.isArray(pr.files)
        ? pr.files.flatMap(f => typeof f === 'string' ? [f] : (f.path ? [f.path] : []))
        : [];
      return [{
        number: pr.number,
        title: pr.title ?? '',
        mergedAt: pr.mergedAt ?? '',
        changedFiles,
        url: pr.url ?? '',
      }];
    });
  } catch {
    return [];
  }
}

function readFilesFromDir(root: string, dir: string): DrySweepFile[] {
  if (!existsSync(dir)) return [];
  const files: DrySweepFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readFilesFromDir(root, fullPath));
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(extension(entry.name))) {
      const path = relative(root, fullPath).replace(/\\/g, '/');
      if (isProductionScanFile(path)) {
        files.push({
          path,
          content: readFileSync(fullPath, 'utf8'),
        });
      }
    }
  }
  return files;
}

export function readDrySweepFiles(root: string): DrySweepFile[] {
  return SCAN_ROOTS.flatMap(scanRoot => readFilesFromDir(root, join(root, scanRoot)));
}

export interface BuildDrySweepReportInput extends FetchRecentPrDeps {
  files?: DrySweepFile[];
  root?: string;
  repo?: string;
  recentPrLimit?: number;
  now?: Date;
}

export function buildDrySweepReport(input: BuildDrySweepReportInput = {}): DrySweepReport {
  const recentPrLimit = input.recentPrLimit ?? 20;
  const files = input.files ?? readDrySweepFiles(input.root ?? process.cwd());
  const recentPrs = input.repo ? fetchRecentMergedPrs(input.repo, recentPrLimit, { gh: input.gh }) : [];
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    repo: input.repo,
    recentPrLimit,
    candidates: collectMechanismDriftCandidates(files, recentPrs),
  };
}

export function summarizeDrySweepReport(report: DrySweepReport, maxCandidates = 3): string {
  if (report.candidates.length === 0) {
    return 'DRY sweep found no current cross-PR mechanism drift candidates.';
  }
  const top = report.candidates.slice(0, maxCandidates).map((c) => {
    const prs = c.recentPrs.length > 0
      ? `; recent PRs ${c.recentPrs.slice(0, 3).map(pr => `#${pr.number}`).join(', ')}`
      : '';
    return `${c.kind}: ${c.summary} (${c.files.length} files, ${c.confidence}% confidence${prs})`;
  });
  return `DRY sweep found ${report.candidates.length} candidate(s): ${top.join(' | ')}`;
}

export function formatDrySweepReport(report: DrySweepReport): string {
  const lines: string[] = [
    '# DRY Sweep',
    '',
    `Generated: ${report.generatedAt}`,
    report.repo ? `Repo: ${report.repo}` : 'Repo: local-only',
    `Recent PR limit: ${report.recentPrLimit}`,
    `Candidates: ${report.candidates.length}`,
    '',
  ];

  if (report.candidates.length === 0) {
    lines.push('No cross-PR mechanism drift candidates found.');
    return lines.join('\n');
  }

  lines.push('| Kind | Confidence | Files | Recent PRs | Suggested target |');
  lines.push('|------|------------|-------|------------|------------------|');
  for (const candidate of report.candidates) {
    lines.push([
      candidate.kind,
      `${candidate.confidence}%`,
      candidate.files.join(', '),
      candidate.recentPrs.map(pr => `#${pr.number}`).join(', ') || '-',
      candidate.suggestedUnificationTarget,
    ].map(value => escapeMarkdownTableCell(value)).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  for (const candidate of report.candidates) {
    lines.push('', `## ${candidate.kind}`, '', candidate.summary, '', `Suggested target: ${candidate.suggestedUnificationTarget}`, '');
    lines.push('Evidence:');
    for (const evidence of candidate.evidence.slice(0, 12)) {
      lines.push(`- ${evidence.path}:${evidence.line} ${evidence.symbol} — ${evidence.detail}`);
    }
    if (candidate.recentPrs.length > 0) {
      lines.push('', 'Recent PR overlap:');
      for (const pr of candidate.recentPrs.slice(0, 8)) {
        lines.push(`- #${pr.number} ${pr.title} (${pr.mergedAt})`);
      }
    }
  }

  return lines.join('\n');
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function getRepoRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

function main(): void {
  const args = process.argv.slice(2);
  const root = resolve(argValue(args, '--root') ?? getRepoRoot());
  const repo = argValue(args, '--repo');
  const limit = Number(argValue(args, '--limit') ?? '20');
  const report = buildDrySweepReport({ root, repo, recentPrLimit: Number.isFinite(limit) ? limit : 20 });

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDrySweepReport(report));
  }

  const postIssue = argValue(args, '--post');
  if (postIssue) {
    if (!repo) {
      console.error('Error: --post requires --repo');
      process.exit(1);
    }
    const url = writeAttachment(
      { kind: 'issue', number: postIssue.replace(/^#/, ''), repo },
      'auto-dent/dry-sweep',
      formatDrySweepReport(report),
    );
    console.error(`Posted dry-sweep attachment: ${url}`);
  }
}

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-dry-sweep.ts') ||
  process.argv[1]?.endsWith('auto-dent-dry-sweep.js');

if (isDirectRun) {
  main();
}
