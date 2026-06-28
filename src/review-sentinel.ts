import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { readYamlFrontmatter } from './lib/frontmatter.js';
import { parseGithubPrUrl } from './lib/github-pr.js';
import { resolveProjectRoot } from './lib/resolve-project-root.js';

export const REVIEW_SENTINEL_SCHEMA_VERSION = 1;

/**
 * The single source of truth for where a review sentinel lives on disk.
 * Both the writer (`cli-structured-data.ts` / `pr-review-loop.writeReviewSentinel`)
 * and the reader (`pr-review-loop.defaultCheckReviewSentinel`) derive the path
 * here, so the path format can never drift between them — drift between a writer
 * and a reader is exactly the failure class behind #1481.
 */
export function reviewSentinelStateKey(prUrl: string): string {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) {
    throw new Error(`invalid PR URL for review sentinel: ${prUrl}`);
  }
  return `${parsed.repo.replace('/', '_')}_${parsed.number}`;
}

export function reviewSentinelPath(stateDir: string, prUrl: string, round: string | number): string {
  return join(stateDir, `${reviewSentinelStateKey(prUrl)}.reviewed-r${round}`);
}

export const DEFAULT_PR_REVIEW_DIMENSIONS = [
  'correctness',
  'dry',
  'improvement-lifecycle',
  'plan-fidelity',
  'pr-description',
  'requirements',
  'scope-fidelity',
  'security',
  'skill-changes',
  'test-plan',
  'test-quality',
  'tooling-fitness',
] as const;

export interface ReviewSentinelRecord {
  schemaVersion: 1;
  prUrl: string;
  repo: string;
  prNumber: number;
  round: number;
  reviewedAt: string;
  dimensionsReviewed: string[];
  dimensionCount: number;
  findingCount: number;
  totalDone: number;
  totalPartial: number;
  totalMissing: number;
  integrity: string;
}

export interface ReviewSentinelInput {
  prUrl: string;
  round: string | number;
  reviewedAt?: string;
  dimensionsReviewed?: string[];
  findingCount?: number;
  totalDone?: number;
  totalPartial?: number;
  totalMissing?: number;
}

export interface WriteReviewSentinelInput extends ReviewSentinelInput {
  stateDir: string;
}

export interface ReviewSentinelValidation {
  ok: boolean;
  reason: string;
  record?: ReviewSentinelRecord;
}

type ReviewSentinelUnsigned = Omit<ReviewSentinelRecord, 'integrity'>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(unsigned: ReviewSentinelUnsigned): string {
  return `sha256:${createHash('sha256').update(stableStringify(unsigned)).digest('hex')}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))].sort();
}

export function expectedPrReviewDimensions(): string[] {
  try {
    const promptsDir = resolve(resolveProjectRoot(process.cwd()), 'prompts');
    const files = fs.readdirSync(promptsDir).filter(f => /^review-.*\.md$/.test(f));
    const dimensions = files.flatMap(file => {
      const content = fs.readFileSync(resolve(promptsDir, file), 'utf8');
      const frontmatter = readYamlFrontmatter<{ name?: string; applies_to?: string }>(content);
      if (!frontmatter?.name) return [];
      if (frontmatter.applies_to !== 'pr' && frontmatter.applies_to !== 'both') return [];
      return [frontmatter.name];
    });
    const parsed = uniqueSorted(dimensions);
    return parsed.length > 0 ? parsed : [...DEFAULT_PR_REVIEW_DIMENSIONS];
  } catch {
    return [...DEFAULT_PR_REVIEW_DIMENSIONS];
  }
}

export function buildReviewSentinelRecord(input: ReviewSentinelInput): ReviewSentinelRecord {
  const parsed = parseGithubPrUrl(input.prUrl);
  if (!parsed) {
    throw new Error(`invalid PR URL for review sentinel: ${input.prUrl}`);
  }

  const dimensionsReviewed = uniqueSorted(input.dimensionsReviewed ?? expectedPrReviewDimensions());
  const unsigned: ReviewSentinelUnsigned = {
    schemaVersion: REVIEW_SENTINEL_SCHEMA_VERSION,
    prUrl: input.prUrl,
    repo: parsed.repo,
    prNumber: parsed.number,
    round: Number(input.round),
    reviewedAt: input.reviewedAt ?? new Date().toISOString(),
    dimensionsReviewed,
    dimensionCount: dimensionsReviewed.length,
    findingCount: input.findingCount ?? 0,
    totalDone: input.totalDone ?? 0,
    totalPartial: input.totalPartial ?? 0,
    totalMissing: input.totalMissing ?? 0,
  };

  return { ...unsigned, integrity: digest(unsigned) };
}

export function serializeReviewSentinel(record: ReviewSentinelRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function writeReviewSentinelFile(input: WriteReviewSentinelInput): string {
  if (fs.existsSync(input.stateDir)) {
    const stateDirStat = fs.lstatSync(input.stateDir);
    if (stateDirStat.isSymbolicLink() || !stateDirStat.isDirectory()) {
      throw new Error(`unsafe review sentinel state dir: ${input.stateDir}`);
    }
  }
  fs.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(input.stateDir, 0o700);
  const record = buildReviewSentinelRecord(input);
  const path = reviewSentinelPath(input.stateDir, input.prUrl, input.round);
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, serializeReviewSentinel(record));
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(path, 0o600);
  return path;
}

export function validateReviewSentinel(
  content: string,
  expected: { prUrl: string; round: string | number },
): ReviewSentinelValidation {
  if (!content.trim()) {
    return { ok: false, reason: 'empty_sentinel' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'not_object' };
  }

  const record = parsed as Partial<ReviewSentinelRecord>;
  if (record.schemaVersion !== REVIEW_SENTINEL_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported_schema' };
  }
  if (record.prUrl !== expected.prUrl) {
    return { ok: false, reason: 'pr_url_mismatch' };
  }
  if (record.round !== Number(expected.round)) {
    return { ok: false, reason: 'round_mismatch' };
  }
  if (!record.reviewedAt || Number.isNaN(Date.parse(record.reviewedAt))) {
    return { ok: false, reason: 'invalid_reviewed_at' };
  }
  if (!Array.isArray(record.dimensionsReviewed)) {
    return { ok: false, reason: 'missing_dimensions' };
  }
  if (record.dimensionCount !== record.dimensionsReviewed.length) {
    return { ok: false, reason: 'dimension_count_mismatch' };
  }
  if (new Set(record.dimensionsReviewed).size !== record.dimensionsReviewed.length) {
    return { ok: false, reason: 'duplicate_dimensions' };
  }

  const expectedDimensions = expectedPrReviewDimensions();
  const reviewed = new Set(record.dimensionsReviewed);
  const missing = expectedDimensions.filter(dim => !reviewed.has(dim));
  if (missing.length > 0) {
    return { ok: false, reason: `missing_expected_dimensions:${missing.join(',')}` };
  }

  for (const key of ['findingCount', 'totalDone', 'totalPartial', 'totalMissing'] as const) {
    const min = key === 'findingCount' ? 1 : 0;
    if (!Number.isInteger(record[key]) || record[key]! < min) {
      return { ok: false, reason: `invalid_${key}` };
    }
  }

  const { integrity, ...unsigned } = record as ReviewSentinelRecord;
  if (integrity !== digest(unsigned)) {
    return { ok: false, reason: 'integrity_mismatch' };
  }
  if ((record.totalMissing ?? 0) > 0) {
    return { ok: false, reason: `review_findings_missing:${record.totalMissing}` };
  }

  return { ok: true, reason: 'valid', record: record as ReviewSentinelRecord };
}
