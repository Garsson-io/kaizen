import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IGNORED_TEST_TMP_RELATIVE_DIR,
  ignoredTestTmpRoot,
  makeIgnoredTestDir,
} from './test-dirs.js';

function makeProjectRoot(prefix: string): string {
  const base = join(process.cwd(), 'data', 'test-tmp-roots');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

describe('ignored test directories', () => {
  it('creates scratch directories under data/test-tmp for a project root', () => {
    const projectRoot = makeProjectRoot('placement');

    try {
      const dir = makeIgnoredTestDir('json-lines', { projectRoot });

      expect(existsSync(dir)).toBe(true);
      expect(relative(projectRoot, dir)).toMatch(/^data[/\\]test-tmp[/\\]json-lines-/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a unique directory on each call', () => {
    const projectRoot = makeProjectRoot('unique');

    try {
      const first = makeIgnoredTestDir('case', { projectRoot });
      const second = makeIgnoredTestDir('case', { projectRoot });

      expect(first).not.toBe(second);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('sanitizes prefixes so callers cannot add path segments', () => {
    const projectRoot = makeProjectRoot('sanitize');

    try {
      const dir = makeIgnoredTestDir('../bad prefix', { projectRoot });
      const relativePath = relative(ignoredTestTmpRoot({ projectRoot }), dir);

      expect(relativePath).toMatch(/^bad-prefix-/);
      expect(relativePath).not.toContain('/');
      expect(relativePath).not.toContain('\\');
      expect(IGNORED_TEST_TMP_RELATIVE_DIR).toBe(join('data', 'test-tmp'));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
