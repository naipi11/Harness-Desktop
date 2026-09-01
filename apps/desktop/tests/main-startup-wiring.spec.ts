/** Electron Main startup ownership wiring contract. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  desktopMainStartupWiringProblems,
  nativeRecoveryBlockedStartupProblems,
  removeCompleteStartupWiring,
  removeOwnedStartupWiring,
} from './support/main-startup-wiring.ts'

const mainEntry = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))

describe('Desktop Main startup wiring', () => {
  it('owns initial and existing-owner retry settlement through the shipped Main entry', async () => {
    const source = await readFile(mainEntry, 'utf8')

    expect(desktopMainStartupWiringProblems(source)).toEqual([])
  })

  it('shows fixed recovery guidance once before either recovery-blocked startup path exits', async () => {
    const source = await readFile(mainEntry, 'utf8')

    expect(nativeRecoveryBlockedStartupProblems(source)).toEqual([])
  })

  it.each(['open', 'retryAfterUserAction'] as const)(
    'rejects Main wiring that bypasses complete settlement ownership for controller.%s()',
    async (method) => {
      const source = await readFile(mainEntry, 'utf8')
      const mutated = removeOwnedStartupWiring(source, method)

      expect(desktopMainStartupWiringProblems(mutated)).toContain(
        method === 'open'
          ? 'startDesktopWindow must own complete controller.open settlement'
          : 'retryDesktopWindow must own complete existing-owner retry settlement',
      )
    },
  )

  it.each(['open', 'retryAfterUserAction'] as const)(
    'rejects Main wiring that bypasses completeDesktopWindowStartup for controller.%s()',
    async (method) => {
      const source = await readFile(mainEntry, 'utf8')
      const mutated = removeCompleteStartupWiring(source, method)

      expect(desktopMainStartupWiringProblems(mutated)).toContain(
        method === 'open'
          ? 'startDesktopWindow must own complete controller.open settlement'
          : 'retryDesktopWindow must own complete existing-owner retry settlement',
      )
    },
  )
})
