import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestCheckpoint } from './e2e-test-utils.js';

describe('findLatestCheckpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kaizen-e2e-utils-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent directory', () => {
    expect(findLatestCheckpoint('/dev/null/impossible', 'test-')).toBeNull();
  });

  it('returns null for empty directory', () => {
    expect(findLatestCheckpoint(tmpDir, 'test-')).toBeNull();
  });

  it('returns null when no files match prefix', () => {
    writeFileSync(join(tmpDir, 'other-1234.txt'), 'data');
    expect(findLatestCheckpoint(tmpDir, 'test-')).toBeNull();
  });

  it('returns the most recent file by lexicographic sort', () => {
    writeFileSync(join(tmpDir, 'test-100.txt'), 'old');
    writeFileSync(join(tmpDir, 'test-200.txt'), 'mid');
    writeFileSync(join(tmpDir, 'test-300.txt'), 'new');
    expect(findLatestCheckpoint(tmpDir, 'test-')).toBe(join(tmpDir, 'test-300.txt'));
  });

  it('ignores non-.txt files', () => {
    writeFileSync(join(tmpDir, 'test-999.json'), 'not txt');
    writeFileSync(join(tmpDir, 'test-100.txt'), 'only match');
    expect(findLatestCheckpoint(tmpDir, 'test-')).toBe(join(tmpDir, 'test-100.txt'));
  });
});
