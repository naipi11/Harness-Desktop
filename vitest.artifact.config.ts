import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/boot/app-boot/tests/**/*.artifact.ts',
      'packages/host/local-runtime/tests/**/*.artifact.ts',
      'packages/test-support/cross-client-runtime/tests/**/*.artifact.ts',
      'apps/cli/tests/**/*.artifact.ts',
    ],
    pool: 'forks',
    // App lanes include a fresh built Runtime boot plus a separately bounded client process.
    testTimeout: 120_000,
  },
})
