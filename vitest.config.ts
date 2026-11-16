import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Isolate every test from the developer's real ~/.heimdall and ~/.gate.
    // Tests that need a home config create their own temp HEIMDALL_HOME and override this.
    env: {
      HEIMDALL_HOME: path.join(os.tmpdir(), `heimdall-home-vitest-${process.pid}`),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
