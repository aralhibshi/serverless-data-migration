import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The pipeline logs structured JSON; only show it for failing tests.
    silent: 'passed-only',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: { statements: 95, branches: 85, functions: 95, lines: 95 },
    },
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/globalSetup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
