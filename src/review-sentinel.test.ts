import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReviewSentinelRecord,
  expectedPrReviewDimensions,
  serializeReviewSentinel,
  validateReviewSentinel,
  reviewSentinelPath,
  reviewSentinelStateKey,
  writeReviewSentinelFile,
} from './review-sentinel.js';
import { prUrlToStateKey } from './hooks/state-utils.js';

const PR_URL = 'https://github.com/Garsson-io/kaizen/pull/997';

describe('review sentinel path SSOT (#1481 anti-drift)', () => {
  it('derives the same state key as the legacy prUrlToStateKey (behavior-preserving)', () => {
    for (const url of [
      'https://github.com/Garsson-io/kaizen/pull/55',
      'https://github.com/Garsson-io/kaizen/pull/997',
      'https://github.com/owner/repo-name/pull/12345',
    ]) {
      expect(reviewSentinelStateKey(url)).toBe(prUrlToStateKey(url));
    }
  });

  it('writer and reader resolve to one identical path', () => {
    expect(reviewSentinelPath('/state', PR_URL, 3)).toBe(
      `/state/${prUrlToStateKey(PR_URL)}.reviewed-r3`,
    );
    // round may be passed as string or number — both must agree.
    expect(reviewSentinelPath('/state', PR_URL, '3')).toBe(reviewSentinelPath('/state', PR_URL, 3));
  });

  it('throws on an invalid PR URL', () => {
    expect(() => reviewSentinelStateKey('not-a-url')).toThrow('invalid PR URL');
  });
});

describe('review sentinel contract', () => {
  it('uses the shared YAML frontmatter parser for expected review dimensions', () => {
    const source = readFileSync('src/review-sentinel.ts', 'utf8');

    expect(source).not.toContain('content.match(/^---\\n');
    expect(source).not.toContain('YAML.parse(match[1])');
  });

  it('validates a complete structured sentinel', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 12,
      totalDone: 12,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.record?.dimensionsReviewed).toEqual(expectedPrReviewDimensions());
  });

  it('rejects tampered sentinel content', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 12,
      totalDone: 12,
    });
    const tampered = { ...record, totalMissing: 1 };

    const result = validateReviewSentinel(JSON.stringify(tampered), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('integrity_mismatch');
  });

  it('rejects sentinels missing expected review dimensions', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: ['correctness'],
      findingCount: 1,
      totalDone: 1,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing_expected_dimensions');
  });

  it('rejects a sentinel with findingCount=0 (no stored findings)', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 0,
      totalDone: 0,
      totalPartial: 0,
      totalMissing: 0,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_findingCount');
  });

  it('rejects a sentinel whose stored findings still include MISSING items', () => {
    const record = buildReviewSentinelRecord({
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 12,
      totalDone: 11,
      totalMissing: 1,
    });

    const result = validateReviewSentinel(serializeReviewSentinel(record), {
      prUrl: PR_URL,
      round: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('review_findings_missing:1');
  });

  it('throws for malformed PR URLs before building a sentinel', () => {
    expect(() =>
      buildReviewSentinelRecord({
        prUrl: 'https://github.com/Garsson-io/kaizen/pull/not-a-number',
        round: 1,
      }),
    ).toThrow('invalid PR URL');
  });

  it('writes new sentinel dirs and files owner-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-sentinel-mode-'));
    const stateDir = join(root, 'state');
    const path = writeReviewSentinelFile({
      stateDir,
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 1,
      totalDone: 1,
    });

    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('repairs existing sentinel file permissions', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'review-sentinel-repair-'));
    const path = reviewSentinelPath(stateDir, PR_URL, 1);
    writeFileSync(path, 'old\n', { mode: 0o644 });
    chmodSync(path, 0o644);

    writeReviewSentinelFile({
      stateDir,
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 1,
      totalDone: 1,
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects preexisting sentinel symlinks without overwriting the target', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'review-sentinel-symlink-'));
    const target = join(stateDir, 'target');
    writeFileSync(target, 'do not overwrite\n');
    const path = reviewSentinelPath(stateDir, PR_URL, 1);
    symlinkSync(target, path);

    expect(() => writeReviewSentinelFile({
      stateDir,
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 1,
      totalDone: 1,
    })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('do not overwrite\n');
    expect(readlinkSync(path)).toBe(target);
  });

  it('rejects symlinked state directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-sentinel-dir-symlink-'));
    const realDir = join(root, 'real');
    const linkedDir = join(root, 'linked');
    writeFileSync(realDir, 'not a dir');
    symlinkSync(realDir, linkedDir);

    expect(existsSync(linkedDir)).toBe(true);
    expect(() => writeReviewSentinelFile({
      stateDir: linkedDir,
      prUrl: PR_URL,
      round: 1,
      dimensionsReviewed: expectedPrReviewDimensions(),
      findingCount: 1,
      totalDone: 1,
    })).toThrow('unsafe review sentinel state dir');
  });
});
