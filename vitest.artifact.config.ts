import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/boot/app-boot/tests/**/*.artifact.ts'],
    pool: 'forks',
    testTimeout: 70_000,
  },
})
