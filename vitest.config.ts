import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/types/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
    setupFiles: ['./tests/fixtures/setup.ts'],
  },
  resolve: {
    alias: {
      '@': '/Users/fabian/ai-router/src',
    },
  },
});
