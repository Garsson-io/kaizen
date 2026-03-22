import { describe, it, expect } from 'vitest';
import { truncate, isTestFile } from './util.js';

describe('truncate', () => {
  it('returns string unchanged when under maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns string unchanged when exactly maxLen', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });

  it('truncates and adds ... when over maxLen', () => {
    expect(truncate('123456', 5)).toBe('12...');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('isTestFile', () => {
  it('identifies .test.ts files', () => {
    expect(isTestFile('src/analysis/diff-checks.test.ts')).toBe(true);
  });

  it('identifies .spec.ts files', () => {
    expect(isTestFile('src/hooks/review.spec.ts')).toBe(true);
  });

  it('identifies __tests__/ directory files', () => {
    expect(isTestFile('src/__tests__/integration.ts')).toBe(true);
  });

  it('identifies /tests/ directory files', () => {
    expect(isTestFile('.claude/hooks/tests/test-hook.sh')).toBe(true);
  });

  it('does NOT flag files with "test" as substring in name', () => {
    // "contest.ts", "attestation.ts", "latest.ts" should NOT be test files
    expect(isTestFile('src/contest.ts')).toBe(false);
    expect(isTestFile('src/attestation-builder.ts')).toBe(false);
    expect(isTestFile('src/latest.ts')).toBe(false);
  });

  it('does NOT flag regular source files', () => {
    expect(isTestFile('src/analysis/diff-checks.ts')).toBe(false);
    expect(isTestFile('src/hooks/pr-review-loop.ts')).toBe(false);
  });
});
