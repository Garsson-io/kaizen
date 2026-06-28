/** Truncate a string to maxLen, adding "..." if trimmed. */
export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

/**
 * Truncate after a visible prefix, then append "...".
 *
 * This preserves the transcript-analysis evidence contract (#1351): callers
 * choose how many source characters remain visible before the ellipsis.
 */
export function truncateAfterPrefix(s: string, prefixLen: number): string {
  return s.length > prefixLen ? s.slice(0, prefixLen) + '...' : s;
}

/** Check if a file path is a test file (path-segment aware, not substring). */
export function isTestFile(path: string): boolean {
  return (
    path.includes('.test.') ||
    path.includes('.spec.') ||
    path.includes('__tests__/') ||
    path.includes('/test/') ||
    path.includes('/tests/')
  );
}
