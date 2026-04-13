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
    },
  },
});
