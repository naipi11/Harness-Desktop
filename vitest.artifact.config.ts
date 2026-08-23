import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/boot/app-boot/tests/**/*.artifact.ts',
      'packages/host/local-runtime/tests/**/*.artifact.ts',
      'packages/test-support/cross-client-runtime/tests/**/*.artifact.ts',
    ],
    pool: 'forks',
    testTimeout: 70_000,
  },
})
