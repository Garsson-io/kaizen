/**
 * e2e-test-utils.ts — Shared helpers for E2E test files.
 *
 * Extracted from review-battery.e2e.test.ts and review-fix.e2e.test.ts
 * to eliminate duplication (issue #880).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the most recent checkpoint file matching a prefix in the results directory.
 * Files are named: <prefix><timestamp>.txt — sorted lexicographically (most recent last).
 * Returns the full path or null if none found.
 */
export function findLatestCheckpoint(resultsDir: string, prefix: string): string | null {
  if (!existsSync(resultsDir)) return null;
  const files = readdirSync(resultsDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.txt'))
    .sort()
    .reverse();
  return files.length > 0 ? join(resultsDir, files[0]) : null;
}
