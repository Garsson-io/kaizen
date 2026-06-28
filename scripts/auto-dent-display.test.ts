import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  truncateAtWordBoundary,
  truncateDisplay,
} from './auto-dent-display.js';

describe('auto-dent display text helpers (#1348)', () => {
  it('collapses arbitrary free text to one display line', () => {
    expect(collapseWhitespace(' line one\n\tline two   line three ')).toBe(
      'line one line two line three',
    );
  });

  it('truncates after whitespace collapse with a visible one-character ellipsis', () => {
    expect(truncateDisplay('abc\n  def ghi', 8)).toBe('abc def…');
  });

  it('leaves already short display text unchanged', () => {
    expect(truncateDisplay('short text', 20)).toBe('short text');
  });

  it('supports the existing word-boundary title contract', () => {
    expect(truncateAtWordBoundary('improve hooks, testing, and more stuff here', 25)).toBe(
      'improve hooks, testing...',
    );
    expect(truncateAtWordBoundary('abcdefghijklmnopqrstuvwxyz', 10)).toBe(
      'abcdefghij...',
    );
  });
});

describe('auto-dent display ownership invariant (#1348)', () => {
  it('keeps migrated Auto-dent files from reintroducing private generic truncators', () => {
    const migratedFiles = [
      'scripts/auto-dent-stream.ts',
      'scripts/auto-dent-analyze.ts',
      'scripts/auto-dent-run.ts',
    ];

    for (const file of migratedFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} should use scripts/auto-dent-display.ts`).not.toMatch(
        /function\s+truncate(?:Input|AtWord)?\s*\(/,
      );
    }
  });
});
