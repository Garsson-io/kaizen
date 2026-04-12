/**
 * review-finding-contract.ts — Canonical contract for review findings.
 *
 * Single source of truth for:
 * - finding status normalization
 * - verdict derivation
 * - finding stats
 * - review finding metadata shape
 */

export type FindingStatus = 'DONE' | 'PARTIAL' | 'MISSING';

export interface ReviewFinding {
  requirement: string;
  status: FindingStatus;
  detail: string;
  analysis?: string;
}

export interface ReviewFindingData {
  dimension: string;
  verdict: 'pass' | 'fail';
  summary: string;
  findings: ReviewFinding[];
  round?: number;
  durationSec?: number;
  costUsd?: number;
}

export interface FindingStats {
  done: number;
  partial: number;
  missing: number;
}

export interface ReviewFindingMeta extends FindingStats {
  round: number;
  dimension: string;
  verdict: 'pass' | 'fail';
  duration_sec?: number;
  cost_usd?: number;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(raw: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

export function normalizeFindingStatus(value: unknown): FindingStatus {
  const raw = asString(value).toUpperCase().trim();
  if (raw === 'DONE' || raw === 'PASS' || raw === 'PASSED' || raw === 'OK' || raw === 'SUCCESS' || raw === 'COMPLETE' || raw === 'ADDRESSED') return 'DONE';
  if (raw === 'PARTIAL' || raw === 'PARTIALLY' || raw === 'IN_PROGRESS' || raw === 'WARNING' || raw === 'WARN') return 'PARTIAL';
  return 'MISSING';
}

export function summarizeFindingStatuses(findings: Array<{ status: FindingStatus }>): FindingStats {
  const stats: FindingStats = { done: 0, partial: 0, missing: 0 };
  for (const f of findings) {
    if (f.status === 'DONE') stats.done += 1;
    else if (f.status === 'PARTIAL') stats.partial += 1;
    else stats.missing += 1;
  }
  return stats;
}

export function deriveVerdictFromFindings(findings: Array<{ status: FindingStatus }>): 'pass' | 'fail' {
  const stats = summarizeFindingStatuses(findings);
  return stats.partial > 0 || stats.missing > 0 ? 'fail' : 'pass';
}

function normalizeVerdict(value: unknown): 'pass' | 'fail' | undefined {
  const raw = asString(value).toLowerCase().trim();
  if (raw === 'pass' || raw === 'passed' || raw === 'ok' || raw === 'success') return 'pass';
  if (raw === 'fail' || raw === 'failed' || raw === 'error') return 'fail';
  return undefined;
}

/**
 * Defensive coercion for CLI/API payloads. Supports legacy shapes (status-only,
 * missing findings) so storage/formatting never throw.
 */
export function normalizeReviewFindingData(
  input: unknown,
  opts?: { defaultDimension?: string },
): ReviewFindingData {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: ReviewFinding[] = rawFindings.map((item, i) => {
    const row = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
    const analysis = asString(row.analysis).trim();
    return {
      requirement: firstString(row, ['requirement', 'title', 'item'], `Finding ${i + 1}`),
      status: normalizeFindingStatus(row.status ?? row.verdict),
      detail: firstString(row, ['detail', 'summary', 'description'], ''),
      ...(analysis ? { analysis } : {}),
    };
  });

  const verdictFromInput = normalizeVerdict(raw.verdict ?? raw.status ?? raw.result);
  const derivedVerdict = deriveVerdictFromFindings(findings);
  const verdict = verdictFromInput ?? (findings.length > 0 ? derivedVerdict : 'fail');
  const summary = firstString(raw, ['summary', 'text', 'message'], verdict === 'pass' ? 'No issues found.' : 'Findings require follow-up.');

  return {
    dimension: firstString(raw, ['dimension'], opts?.defaultDimension ?? 'unknown'),
    verdict,
    summary,
    findings,
    round: asNumber(raw.round),
    durationSec: asNumber(raw.durationSec ?? raw.duration_sec),
    costUsd: asNumber(raw.costUsd ?? raw.cost_usd),
  };
}

export function makeReviewFindingMeta(round: number, finding: ReviewFindingData): ReviewFindingMeta {
  const stats = summarizeFindingStatuses(finding.findings);
  return {
    round,
    dimension: finding.dimension,
    verdict: finding.verdict,
    done: stats.done,
    partial: stats.partial,
    missing: stats.missing,
    ...(finding.durationSec != null ? { duration_sec: finding.durationSec } : {}),
    ...(finding.costUsd != null ? { cost_usd: finding.costUsd } : {}),
  };
}

export function parseReviewFindingMeta(value: unknown): ReviewFindingMeta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const round = asNumber(raw.round);
  const dimension = asString(raw.dimension);
  const verdict = normalizeVerdict(raw.verdict);
  const done = asNumber(raw.done);
  const partial = asNumber(raw.partial);
  const missing = asNumber(raw.missing);
  if (round == null || !dimension || !verdict || done == null || partial == null || missing == null) return null;
  return {
    round,
    dimension,
    verdict,
    done,
    partial,
    missing,
    ...(asNumber(raw.duration_sec) != null ? { duration_sec: asNumber(raw.duration_sec)! } : {}),
    ...(asNumber(raw.cost_usd) != null ? { cost_usd: asNumber(raw.cost_usd)! } : {}),
  };
}

export function extractReviewFindingMeta(content: string): ReviewFindingMeta | null {
  const match = content.match(/<!-- meta:(\{.*?\}) -->/);
  if (!match) return null;
  try {
    return parseReviewFindingMeta(JSON.parse(match[1]));
  } catch {
    return null;
  }
}
