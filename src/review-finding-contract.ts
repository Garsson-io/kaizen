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

/**
 * Round-level verdict — three-state, distinct from the per-dimension rule.
 *
 * The per-dimension rule (`deriveVerdictFromFindings`) treats any PARTIAL as fail. At the
 * *round* level we surface PARTIAL loudly but do not auto-block on it: a PARTIAL is a real
 * gap the author/admin can choose to carry forward (#1067), whereas a MISSING is a blocking
 * gap. So:
 *   - any MISSING  → FAIL
 *   - PARTIAL but no MISSING → PASS_WITH_PARTIALS  (passes, but never silently)
 *   - else → PASS
 */
export type RoundVerdict = 'PASS' | 'PASS_WITH_PARTIALS' | 'FAIL';

export interface RoundRow extends FindingStats {
  dim: string;
  // The per-dimension stored verdict string (informational only — the round rollup is derived
  // from done/partial/missing counts, never from this field).
  verdict: string;
}

export interface RoundRollup {
  verdict: RoundVerdict;
  dimensions: number;
  passDims: number;
  failDims: number;
  partialDims: number;
  totalDone: number;
  totalPartial: number;
  totalMissing: number;
}

export function deriveRoundVerdict(rows: Array<FindingStats>): RoundVerdict {
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  const totalPartial = rows.reduce((s, r) => s + r.partial, 0);
  if (totalMissing > 0) return 'FAIL';
  if (totalPartial > 0) return 'PASS_WITH_PARTIALS';
  return 'PASS';
}

/**
 * Single source of truth for the round-level rollup that `composeReviewSummary` and the
 * `storeReviewSummary` contradiction-guard both consume. Derives every count + the verdict
 * from the per-dimension rows — never from caller-supplied free text.
 */
export function summarizeRound(rows: Array<RoundRow>): RoundRollup {
  const totalDone = rows.reduce((s, r) => s + r.done, 0);
  const totalPartial = rows.reduce((s, r) => s + r.partial, 0);
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  return {
    verdict: deriveRoundVerdict(rows),
    dimensions: rows.length,
    passDims: rows.filter(r => r.missing === 0 && r.partial === 0).length,
    failDims: rows.filter(r => r.missing > 0).length,
    partialDims: rows.filter(r => r.missing === 0 && r.partial > 0).length,
    totalDone,
    totalPartial,
    totalMissing,
  };
}

/**
 * Does a caller-supplied free-text summary overtly assert the round PASSED?
 *
 * Used as a fail-closed guard: a hand-written "REVIEW PASSED" note alongside findings that
 * derive FAIL is exactly the #1019 fabrication. We only flag an OVERT pass claim — conservative
 * by design so genuine commentary ("fixed 3 lint nits") is never rejected. The derived verdict
 * is authoritative regardless; this guard only stops a *misleading* note from riding along.
 */
export function assertsPass(text: string): boolean {
  const t = text.toLowerCase();
  // "review passed", "all dimensions pass", "✅ pass", "passes review", "lgtm", "all green"
  return /\b(review\s+passed|all\s+(dimensions?|checks?|dims?)\s+pass(ed)?|passes?\s+review|verdict[:\s]+pass|lgtm|all\s+green)\b/.test(t)
    || /✅\s*pass/.test(t);
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

/**
 * Strict validator for review finding payloads — used at the CLI boundary
 * so callers get an actionable error instead of the normalizer silently
 * producing a fail-with-empty-findings sentinel (see #1039).
 *
 * Rules:
 *  - Input must be a plain object
 *  - `dimension` (string, non-empty) — may be supplied via --dimension if absent
 *  - `verdict` (string, maps to 'pass' | 'fail' after normalizeVerdict)
 *  - `summary` (string, non-empty)
 *  - `findings` (array; may be empty only when verdict === 'pass')
 *  - Each finding row: `requirement` (string), `status` (valid), `detail` (string)
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` with a caller-
 * facing message describing exactly which field is wrong.
 */
export function validateReviewFindingPayload(
  input: unknown,
  opts?: { defaultDimension?: string },
): { ok: true } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'payload must be a JSON object with {dimension, verdict, summary, findings[]}' };
  }
  const raw = input as Record<string, unknown>;

  const dimension = firstString(raw, ['dimension'], opts?.defaultDimension ?? '');
  if (!dimension) {
    return { ok: false, error: 'payload is missing required field `dimension` (pass --dimension on the CLI if not in the JSON)' };
  }

  const verdict = normalizeVerdict(raw.verdict ?? raw.status ?? raw.result);
  if (!verdict) {
    return { ok: false, error: `payload has invalid or missing \`verdict\` (got ${JSON.stringify(raw.verdict ?? raw.status ?? raw.result)}, expected "pass" | "fail")` };
  }

  const summary = firstString(raw, ['summary', 'text', 'message'], '');
  if (!summary) {
    return { ok: false, error: 'payload is missing required field `summary` (a one-line description of the verdict)' };
  }

  if (raw.findings !== undefined && !Array.isArray(raw.findings)) {
    return { ok: false, error: `payload field \`findings\` must be an array (got ${typeof raw.findings})` };
  }
  const findings = Array.isArray(raw.findings) ? raw.findings : [];

  if (verdict === 'fail' && findings.length === 0) {
    return { ok: false, error: 'verdict=fail with empty findings[] is not allowed — a failing verdict must list at least one requirement with status PARTIAL or MISSING. See #1039.' };
  }

  for (let i = 0; i < findings.length; i++) {
    const item = findings[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `findings[${i}] must be an object with {requirement, status, detail}` };
    }
    const row = item as Record<string, unknown>;
    const requirement = firstString(row, ['requirement', 'title', 'item'], '');
    if (!requirement) {
      return { ok: false, error: `findings[${i}] is missing required field \`requirement\`` };
    }
    if (row.status === undefined && row.verdict === undefined) {
      return { ok: false, error: `findings[${i}] is missing required field \`status\` (DONE | PARTIAL | MISSING)` };
    }
  }

  return { ok: true };
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

/**
 * Single meta-block accessor for `<!-- meta:{...} -->` comments (I29).
 *
 * Every consumer of a stored kaizen meta block (per-dimension findings AND round
 * summaries) goes through this one non-greedy, suffix-anchored regex + JSON.parse,
 * so we never grow a second bespoke parser. The lazy `\{.*?\}` plus the literal
 * ` -->` terminator stops at the meta block's own close — it cannot over-match a
 * later `}` elsewhere in the body the way a greedy `\{.*\}` would (#1222 / I29).
 */
export function extractMetaBlock(content: string): Record<string, unknown> | null {
  const match = content.match(/<!-- meta:(\{.*?\}) -->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractReviewFindingMeta(content: string): ReviewFindingMeta | null {
  const raw = extractMetaBlock(content);
  if (!raw) return null;
  return parseReviewFindingMeta(raw);
}
