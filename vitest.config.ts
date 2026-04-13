import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', '.kaizen', '.claude/worktrees'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'cobertura', 'json-summary'],
      reportsDirectory: 'artifacts/coverage',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'scripts/**/*.test.ts',
        'src/e2e/**',
        'dist/**',
        'node_modules/**',
      ],
      // Regression gate. Baseline (2026-04-13) was 71.66 lines / 70.68
      // statements / 77.52 functions / 66.91 branches. Thresholds sit ~2pp
      // below baseline to allow day-to-day noise without silent slippage —
      // a real drop must be either accompanied by a matching threshold bump
      // (with justification) or reversed before merge. Raise these over
      // time; never quietly lower them.
      thresholds: {
        lines: 69,
        statements: 68,
        functions: 75,
        branches: 64,
      },
    },
  },
});
