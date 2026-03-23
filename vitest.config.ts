import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', '.kaizen'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
