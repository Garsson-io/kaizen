/** Truncate a string to maxLen, adding "..." if trimmed. */
export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
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
