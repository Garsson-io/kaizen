#!/usr/bin/env npx tsx
/**
 * backlog-health — Aggregate metric for the health of the issue backlog.
 *
 * Advances epic #953 (Issue Metabolism) from L0 ("no tracking, no awareness")
 * to L1 ("metrics exist but require manual inspection"). Where
 * `staleness-audit.ts` triages individual issues and `stale-pr-triage.ts`
 * triages PRs, this computes the standing health of the whole backlog across
 * the axes #953 defines:
 *
 *   - Creation/closure ratio over a trailing window (healthy < 2:1 sustained)
 *   - Age distribution (open issues with no activity > 30 / > 60 / > 90 days)
 *   - Horizon coverage (distribution across horizon/* labels + concentration)
 *
 * The core functions are pure (data in, metrics out) so the math is
 * unit-testable without GitHub. The verdict is bound to the process exit code
 * (pathological → exit 1) so it is a signal, not a decorative number (#1227).
 *
 * Usage:
 *   npx tsx scripts/backlog-health.ts [--repo Garsson-io/kaizen] [--window 30] [--json]
 *
 * Referenced by /kaizen-audit-issues. Refs #951, #728. Closes #1493.
 */

import { gh } from '../src/lib/gh-exec.js';

// Types

export interface OpenIssue {
  number: number;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

export interface ClosedIssue {
  number: number;
  closedAt: string;
}

export interface CreatedIssue {
  number: number;
  createdAt: string;
}

export interface AgeDistribution {
  total: number;
  /** open issues with no activity for > 30 days */
  stale30: number;
  /** > 60 days (subset of stale30) */
  stale60: number;
  /** > 90 days (subset of stale60) */
  stale90: number;
}

export interface HorizonCoverage {
  byHorizon: Record<string, number>;
  noHorizon: number;
  distinctHorizons: number;
}

export interface CreationClosureRatio {
  created: number;
  closed: number;
  ratio: number;
}

export type HealthVerdict = 'healthy' | 'warning' | 'pathological';

export interface BacklogHealthReport {
  repo?: string;
  windowDays: number;
  totalOpen: number;
  ratio: CreationClosureRatio;
  age: AgeDistribution;
  horizon: HorizonCoverage;
  generatedAt: string;
}

// Pure core

const DAY_MS = 86400_000;

function inactivityDays(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

function isHorizonLabel(label: string): boolean {
  return label.startsWith('horizon/') || label.startsWith('horizon:');
}

/**
 * Bucket open issues by how long they have gone without activity (`updatedAt`).
 * Buckets are nested: an issue inactive > 90d counts in stale30, stale60, and
 * stale90 — so each bucket reads as "at least this stale".
 */
export function computeAgeDistribution(issues: OpenIssue[], now: Date): AgeDistribution {
  const dist: AgeDistribution = { total: issues.length, stale30: 0, stale60: 0, stale90: 0 };
  for (const issue of issues) {
    const age = inactivityDays(issue.updatedAt, now);
    if (age > 30) dist.stale30++;
    if (age > 60) dist.stale60++;
    if (age > 90) dist.stale90++;
  }
  return dist;
}

/** Distribution of open issues across horizon labels, plus the unlabeled count. */
export function computeHorizonCoverage(issues: OpenIssue[]): HorizonCoverage {
  const byHorizon: Record<string, number> = {};
  let noHorizon = 0;
  for (const issue of issues) {
    const horizons = issue.labels.filter(isHorizonLabel);
    if (horizons.length === 0) {
      noHorizon++;
      continue;
    }
    for (const h of horizons) {
      byHorizon[h] = (byHorizon[h] ?? 0) + 1;
    }
  }
  return { byHorizon, noHorizon, distinctHorizons: Object.keys(byHorizon).length };
}

/** created / closed over the window, guarding divide-by-zero (closed floored at 1). */
export function computeCreationClosureRatio(created: number, closed: number): CreationClosureRatio {
  return { created, closed, ratio: created / Math.max(closed, 1) };
}

/**
 * Assemble every axis into a single report for a window ending at `now`.
 *
 * `created` is the set of issues *created* in the window across ALL states —
 * not derived from `open` — so an issue created and closed inside the window
 * still counts toward the creation rate (otherwise the ratio is biased low on
 * the numerator and the backlog looks healthier than it is).
 */
export function buildBacklogHealthReport(
  open: OpenIssue[],
  created: CreatedIssue[],
  closed: ClosedIssue[],
  now: Date,
  windowDays: number,
  repo?: string,
): BacklogHealthReport {
  const createdInWindow = created.filter((i) => inactivityDays(i.createdAt, now) <= windowDays).length;
  const closedInWindow = closed.filter((i) => inactivityDays(i.closedAt, now) <= windowDays).length;
  return {
    repo,
    windowDays,
    totalOpen: open.length,
    ratio: computeCreationClosureRatio(createdInWindow, closedInWindow),
    age: computeAgeDistribution(open, now),
    horizon: computeHorizonCoverage(open),
    generatedAt: now.toISOString(),
  };
}

// Thresholds (documented so the verdict is auditable, not magic)
const RATIO_PATHOLOGICAL = 2.0; // #953: healthy < 2:1 sustained
const RATIO_WARNING = 1.3;
const STALE90_SHARE_PATHOLOGICAL = 0.25;
const STALE90_SHARE_WARNING = 0.1;
const HORIZON_CONCENTRATION_WARNING = 0.5;
const HORIZON_CONCENTRATION_MIN_LABELED = 4; // ignore concentration on tiny backlogs

function stale90Share(age: AgeDistribution): number {
  return age.total > 0 ? age.stale90 / age.total : 0;
}

function horizonConcentration(horizon: HorizonCoverage): number {
  const labeled = Object.values(horizon.byHorizon).reduce((a, b) => a + b, 0);
  if (labeled < HORIZON_CONCENTRATION_MIN_LABELED) return 0;
  const max = Math.max(0, ...Object.values(horizon.byHorizon));
  return max / labeled;
}

/** Classify a report into a single health verdict. Pathological wins over warning. */
export function classifyBacklogHealth(report: BacklogHealthReport): HealthVerdict {
  const share90 = stale90Share(report.age);
  if (report.ratio.ratio >= RATIO_PATHOLOGICAL || share90 >= STALE90_SHARE_PATHOLOGICAL) {
    return 'pathological';
  }
  if (
    report.ratio.ratio >= RATIO_WARNING ||
    share90 >= STALE90_SHARE_WARNING ||
    horizonConcentration(report.horizon) >= HORIZON_CONCENTRATION_WARNING
  ) {
    return 'warning';
  }
  return 'healthy';
}

// GitHub fetch layer (thin; reuses the shared argv-based gh helper)

interface GhOpenIssue {
  number: number;
  createdAt: string;
  updatedAt: string;
  labels: { name: string }[];
}

const FETCH_LIMIT = 500;

/** UTC `YYYY-MM-DD` `windowDays` before `now`, for gh `--search` date filters. */
function windowSince(windowDays: number, now: Date): string {
  return new Date(now.getTime() - windowDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Warn (loudly, on stderr) when a fetch hit the limit — the result is
 * truncated and any count derived from it is a floor, not the truth. Silent
 * caps read as "we measured everything" when we did not.
 */
function warnIfTruncated(label: string, count: number): void {
  if (count >= FETCH_LIMIT) {
    console.error(
      `WARNING: ${label} hit the ${FETCH_LIMIT}-issue fetch cap — counts are truncated (floor, not exact). Narrow --window or paginate.`,
    );
  }
}

export function fetchOpenIssues(repo: string): OpenIssue[] {
  const raw = gh(
    ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(FETCH_LIMIT),
      '--json', 'number,createdAt,updatedAt,labels'],
    60_000,
  );
  const issues: GhOpenIssue[] = JSON.parse(raw);
  warnIfTruncated('open issues', issues.length);
  return issues.map((i) => ({
    number: i.number,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    labels: i.labels.map((l) => l.name),
  }));
}

export function fetchCreatedInWindow(repo: string, windowDays: number, now: Date): CreatedIssue[] {
  const since = windowSince(windowDays, now);
  const raw = gh(
    ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(FETCH_LIMIT),
      '--search', `created:>=${since}`, '--json', 'number,createdAt'],
    60_000,
  );
  const issues: CreatedIssue[] = JSON.parse(raw);
  warnIfTruncated('created-in-window issues', issues.length);
  return issues.map((i) => ({ number: i.number, createdAt: i.createdAt }));
}

export function fetchClosedInWindow(repo: string, windowDays: number, now: Date): ClosedIssue[] {
  const since = windowSince(windowDays, now);
  const raw = gh(
    ['issue', 'list', '--repo', repo, '--state', 'closed', '--limit', String(FETCH_LIMIT),
      '--search', `closed:>=${since}`, '--json', 'number,closedAt'],
    60_000,
  );
  const issues: ClosedIssue[] = JSON.parse(raw);
  warnIfTruncated('closed-in-window issues', issues.length);
  return issues.map((i) => ({ number: i.number, closedAt: i.closedAt }));
}

// Reporting

export function formatReport(report: BacklogHealthReport, verdict: HealthVerdict): string {
  const lines: string[] = [];
  lines.push(`Backlog health — ${report.repo ?? '(repo)'} — ${verdict.toUpperCase()}`);
  lines.push(`  generated: ${report.generatedAt}  window: ${report.windowDays}d`);
  lines.push(`  open issues: ${report.totalOpen}`);
  lines.push(
    `  creation/closure (window): created ${report.ratio.created} / closed ${report.ratio.closed} = ${report.ratio.ratio.toFixed(2)}:1`,
  );
  lines.push(
    `  inactivity: >30d ${report.age.stale30}  >60d ${report.age.stale60}  >90d ${report.age.stale90}`,
  );
  const horizons = Object.entries(report.horizon.byHorizon)
    .sort((a, b) => b[1] - a[1])
    .map(([h, n]) => `${h}=${n}`)
    .join('  ');
  lines.push(`  horizons (${report.horizon.distinctHorizons} distinct, ${report.horizon.noHorizon} unlabeled): ${horizons || '(none)'}`);
  return lines.join('\n');
}

// CLI

interface CliArgs {
  repo: string;
  window: number;
  json: boolean;
}

/** Parse argv, validating every value. Throws on a missing/invalid flag value. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repo: 'Garsson-io/kaizen', window: 30, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--repo requires an owner/repo value');
      args.repo = v;
    } else if (a === '--window') {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n <= 0) {
        throw new Error(`--window requires a positive number (got ${v ?? 'nothing'})`);
      }
      args.window = n;
    } else if (a === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`backlog-health: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const open = fetchOpenIssues(args.repo);
  const created = fetchCreatedInWindow(args.repo, args.window, now);
  const closed = fetchClosedInWindow(args.repo, args.window, now);
  const report = buildBacklogHealthReport(open, created, closed, now, args.window, args.repo);
  const verdict = classifyBacklogHealth(report);

  if (args.json) {
    console.log(JSON.stringify({ ...report, verdict }, null, 2));
  } else {
    console.log(formatReport(report, verdict));
  }

  // Bind the verdict to a signal so it is not decorative (#1227).
  if (verdict === 'pathological') process.exitCode = 1;
}

// Only run when invoked directly, not when imported by tests.
const invokedDirectly = process.argv[1]?.endsWith('backlog-health.ts');
if (invokedDirectly) main();
