import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

export const IGNORED_TEST_TMP_RELATIVE_DIR = join('data', 'test-tmp');

export interface IgnoredTestDirOptions {
  /** Repo/project root. Defaults to the current test process cwd. */
  projectRoot?: string;
}

export function ignoredTestTmpRoot(options?: IgnoredTestDirOptions): string {
  return join(options?.projectRoot ?? process.cwd(), IGNORED_TEST_TMP_RELATIVE_DIR);
}

function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
}

/**
 * Create a unique scratch directory under the repo-ignored `data/test-tmp/`.
 *
 * Use this for tests that exercise shared filesystem helpers but do not need
 * OS temp-directory semantics. It keeps CodeQL from tracing generic helper
 * writes back to insecure-temp-file test paths while still isolating each test.
 */
export function makeIgnoredTestDir(prefix: string, options?: IgnoredTestDirOptions): string {
  const base = ignoredTestTmpRoot(options);
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${sanitizePrefix(prefix)}-`));
}
