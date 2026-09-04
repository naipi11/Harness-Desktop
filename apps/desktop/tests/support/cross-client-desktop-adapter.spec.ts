/** Exact-process ownership checks for the cross-client Desktop adapter. */

import { EventEmitter } from 'node:events'
import type { Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'

class FakeDesktopProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }
}

class StuckDesktopProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return false
  }
}

describe('cross-client Desktop adapter cleanup', () => {
  it('forces only its exact Electron child to exit after graceful close times out', async () => {
    const { createCrossClientDesktopAdapter } = await import('./cross-client-desktop-adapter.ts')
    const child = new FakeDesktopProcess()
    const adapter = createCrossClientDesktopAdapter({
      requireMainEntry: async () => {},
      launch: async () => ({
        close: async () => {
          await new Promise<void>(() => {})
        },
        firstWindow: async () => ({} as Page),
        process: () => child,
      }),
      gracefulCloseTimeoutMs: 1,
      forceKillTimeoutMs: 1,
    }).adapter

    const handle = await adapter.open({
      home: 'PRIVATE_HOME_VALUE',
      platformHome: 'PRIVATE_PLATFORM_HOME_VALUE',
      workspace: 'PRIVATE_WORKSPACE_VALUE',
    })
    await handle.close()

    expect(child.signals).toEqual(['SIGKILL'])
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('releases the Playwright application after its owned child has already crashed', async () => {
    const { createCrossClientDesktopAdapter } = await import('./cross-client-desktop-adapter.ts')
    const child = new FakeDesktopProcess()
    child.signalCode = 'SIGKILL'
    let applicationCloses = 0
    const adapter = createCrossClientDesktopAdapter({
      requireMainEntry: async () => {},
      launch: async () => ({
        close: async () => { applicationCloses += 1 },
        firstWindow: async () => ({} as Page),
        process: () => child,
      }),
      gracefulCloseTimeoutMs: 1,
      forceKillTimeoutMs: 1,
    }).adapter

    const handle = await adapter.open({
      home: 'PRIVATE_HOME_VALUE',
      platformHome: 'PRIVATE_PLATFORM_HOME_VALUE',
      workspace: 'PRIVATE_WORKSPACE_VALUE',
    })
    await handle.close()

    expect(applicationCloses).toBe(1)
    expect(child.signals).toEqual([])

    await handle.close()
    expect(applicationCloses).toBe(1)
  })

  it('fails instead of claiming cleanup when its exact child rejects SIGKILL', async () => {
    const { createCrossClientDesktopAdapter } = await import('./cross-client-desktop-adapter.ts')
    const child = new StuckDesktopProcess()
    const adapter = createCrossClientDesktopAdapter({
      requireMainEntry: async () => {},
      launch: async () => ({
        close: async () => {},
        firstWindow: async () => ({} as Page),
        process: () => child,
      }),
      gracefulCloseTimeoutMs: 1,
      forceKillTimeoutMs: 1,
    }).adapter

    const handle = await adapter.open({
      home: 'PRIVATE_HOME_VALUE',
      platformHome: 'PRIVATE_PLATFORM_HOME_VALUE',
      workspace: 'PRIVATE_WORKSPACE_VALUE',
    })

    await expect(handle.close()).rejects.toThrow('The built Desktop acceptance adapter failed.')
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('rejects a missing built entry without launching Desktop or exposing fixture roots', async () => {
    const { createCrossClientDesktopAdapter } = await import('./cross-client-desktop-adapter.ts')
    let launched = false
    const adapter = createCrossClientDesktopAdapter({
      requireMainEntry: async () => { throw new Error('PRIVATE_MAIN_ENTRY') },
      launch: async () => {
        launched = true
        throw new Error('unreachable')
      },
      gracefulCloseTimeoutMs: 1,
      forceKillTimeoutMs: 1,
    }).adapter
    const context = {
      home: 'PRIVATE_HOME_VALUE',
      platformHome: 'PRIVATE_PLATFORM_HOME_VALUE',
      workspace: 'PRIVATE_WORKSPACE_VALUE',
    }

    let thrown: unknown
    try {
      await adapter.open(context)
    } catch (error) {
      thrown = error
    }

    expect(launched).toBe(false)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('built Desktop acceptance requires apps/desktop/out/main/index.js; run pnpm run build first')
    expect(JSON.stringify(thrown)).not.toMatch(/PRIVATE_/u)
  })
})
