import { describe, expect, it, vi } from 'vitest'
import { createDesktopBridge } from '../src/preload/bridge.ts'
import {
  desktopChannels,
  type DesktopInvoke,
  type DesktopRecoveryDiagnostic,
  type DesktopStartupResult,
  type FolderSelectionResult,
} from '../src/shared/desktop-api.ts'

const diagnostic: DesktopRecoveryDiagnostic = {
  code: 'runtime-unavailable',
  subject: 'Runtime',
  message: 'The local Harness Runtime is unavailable.',
  correction: 'Retry the operation.',
  diagnosticId: 'diagnostic-bridge-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
}

describe('Desktop preload bridge', () => {
  it('exposes only the versioned six-operation surface and invokes each literal channel', async () => {
    const recoveryResult: DesktopStartupResult = { kind: 'recovery', diagnostic }
    const folderResult: FolderSelectionResult = { kind: 'selected', path: 'C:\\projects\\harness' }
    const invokeMock = vi.fn(async (channel: string): Promise<unknown> => {
      const results: Record<string, unknown> = {
        [desktopChannels.readRecoveryDiagnostic]: diagnostic,
        [desktopChannels.retryDashboard]: recoveryResult,
        [desktopChannels.copyRecoveryDiagnostic]: undefined,
        [desktopChannels.selectFolder]: folderResult,
        [desktopChannels.showNotification]: undefined,
        [desktopChannels.openExternalLink]: undefined,
      }
      return results[channel]
    })
    const invoke = invokeMock as unknown as DesktopInvoke
    const bridge = createDesktopBridge(invoke)

    await expect(bridge.readRecoveryDiagnostic()).resolves.toEqual(diagnostic)
    await expect(bridge.retryDashboard()).resolves.toEqual(recoveryResult)
    await expect(bridge.copyRecoveryDiagnostic()).resolves.toBeUndefined()
    await expect(bridge.selectFolder()).resolves.toEqual(folderResult)
    await expect(bridge.showNotification({ title: 'Harness', body: 'Task finished.' })).resolves.toBeUndefined()
    await expect(bridge.openExternalLink('https://github.com/deepseek-ai')).resolves.toBeUndefined()

    expect(invokeMock.mock.calls).toEqual([
      ['desktop:read-recovery-diagnostic'],
      ['desktop:retry-dashboard'],
      ['desktop:copy-recovery-diagnostic'],
      ['desktop:select-folder'],
      ['desktop:show-notification', { title: 'Harness', body: 'Task finished.' }],
      ['desktop:open-external-link', 'https://github.com/deepseek-ai'],
    ])
    expect(Object.keys(bridge).sort()).toEqual([
      'copyRecoveryDiagnostic',
      'openExternalLink',
      'readRecoveryDiagnostic',
      'retryDashboard',
      'selectFolder',
      'showNotification',
      'version',
    ])
    expect(bridge.version).toBe(1)
    expect('getProductMetadata' in bridge).toBe(false)
    expect('invoke' in bridge).toBe(false)
    expect('runtime' in bridge).toBe(false)
    expect('process' in bridge).toBe(false)
    expect('require' in bridge).toBe(false)
  })

  it('rejects malformed method payloads before invoking Main', async () => {
    const invoke = vi.fn() as unknown as DesktopInvoke
    const bridge = createDesktopBridge(invoke)

    await expect(Reflect.apply(bridge.readRecoveryDiagnostic, bridge, ['unexpected']))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(Reflect.apply(bridge.retryDashboard, bridge, [{}]))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(Reflect.apply(bridge.copyRecoveryDiagnostic, bridge, [true]))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(Reflect.apply(bridge.selectFolder, bridge, ['C:\\secret']))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(Reflect.apply(bridge.showNotification, bridge, [{ title: 'Harness' }]))
      .rejects.toThrow('desktop:invalid-notification')
    await expect(Reflect.apply(bridge.showNotification, bridge, [{ title: 'Harness', body: 'ok', icon: 'secret' }]))
      .rejects.toThrow('desktop:invalid-notification')
    await expect(Reflect.apply(bridge.openExternalLink, bridge, ['http://github.com/deepseek-ai']))
      .rejects.toThrow('desktop:external-link-denied')
    await expect(Reflect.apply(bridge.openExternalLink, bridge, ['https://github.com', 'unexpected']))
      .rejects.toThrow('desktop:invalid-invocation')

    expect(invoke).not.toHaveBeenCalled()
  })
})
