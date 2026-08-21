import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createInstalledDesktopActivator,
  DesktopNotInstalledError,
  runDesktopInvocation,
  type DesktopDiagnosticId,
  type DesktopIO,
  type InstalledDesktopActivator,
} from '../src/desktop.ts'
import { runCli } from '../src/main.ts'
import type { TerminalIO } from '../src/terminal-client.ts'

function output(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8').on('data', (chunk: string) => { value += chunk })
  return { stream, text: () => value }
}

function diagnosticId(value: string): DesktopDiagnosticId {
  return value as DesktopDiagnosticId
}

function captureIO(): { io: TerminalIO; stderr: () => string; stdout: () => string } {
  const stdout = output()
  const stderr = output()
  return {
    io: {
      stdin: new PassThrough(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      workspace: 'C:\\workspace',
      columns: 80,
      colorDepth: 1,
    },
    stderr: stderr.text,
    stdout: stdout.text,
  }
}

describe('installed Desktop activation', () => {
  it.each(['harness', 'dsh'] as const)(
    'dispatches %s desktop once without connecting to Runtime or opening a browser',
    async (commandName) => {
      const streams = captureIO()
      const activate = vi.fn(async () => 'activated' as const)
      const connect = vi.fn(() => { throw new Error('Desktop must not connect to Runtime') })
      const open = vi.fn(() => { throw new Error('Desktop must not open a browser fallback') })

      const code = await runCli(commandName, ['desktop'], {
        activator: { activate },
        connector: { connect },
        io: streams.io,
        opener: { open },
      })

      expect(code).toBe(0)
      expect(activate).toHaveBeenCalledOnce()
      expect(connect).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(streams.stdout()).toBe('')
      expect(streams.stderr()).toBe('')
    },
  )

  it('prints only the installation route and diagnostic when Desktop is absent', async () => {
    const stderr = output()
    const io: DesktopIO = { stderr: stderr.stream }
    const activator: InstalledDesktopActivator = {
      activate: async () => {
        throw new DesktopNotInstalledError(
          'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.',
          diagnosticId('11111111-1111-4111-8111-111111111111'),
        )
      },
    }

    expect(await runDesktopInvocation(activator, io)).toBe(3)
    expect(stderr.text()).toBe(
      'Harness Desktop is not installed.\n'
      + 'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.\n'
      + 'Diagnostic: 11111111-1111-4111-8111-111111111111\n',
    )
    expect(stderr.text()).not.toMatch(/token|credential|runtime-endpoint|C:\\/i)
  })

  it.each([
    ['win32', { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' }, 'C:\\Users\\person\\AppData\\Local\\Programs\\Harness Desktop\\harness-desktop.exe', []],
    ['darwin', { HOME: '/Users/person' }, 'open', ['/Users/person/Applications/Harness Desktop.app']],
    ['linux', { HOME: '/home/person', XDG_DATA_HOME: '/home/person/.local/share' }, 'gio', ['launch', '/home/person/.local/share/applications/io.github.naipi11.harness-desktop.desktop']],
  ] as const)(
    'resolves and activates only the installed %s application',
    async (platform, env, expectedCommand, expectedArgs) => {
      const launch = vi.fn(async () => {})
      const exists = vi.fn(async (path: string) => path === (platform === 'win32'
        ? expectedCommand
        : expectedArgs.at(-1)))
      const activator = createInstalledDesktopActivator({
        platform,
        env,
        exists,
        launch,
        diagnosticId: () => diagnosticId('22222222-2222-4222-8222-222222222222'),
      })

      await expect(activator.activate()).resolves.toBe('activated')
      expect(launch).toHaveBeenCalledOnce()
      expect(launch).toHaveBeenCalledWith(expectedCommand, expectedArgs)
    },
  )

  it('resolves a machine-wide Windows installation without a per-user Programs segment', async () => {
    const launch = vi.fn(async () => {})
    const installed = 'C:\\Program Files\\Harness Desktop\\harness-desktop.exe'
    const activator = createInstalledDesktopActivator({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: async path => path === installed,
      launch,
      diagnosticId: () => diagnosticId('22222222-2222-4222-8222-222222222222'),
    })

    await expect(activator.activate()).resolves.toBe('activated')
    expect(launch).toHaveBeenCalledWith(installed, [])
  })

  it.each([
    ['win32', 'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.'],
    ['darwin', 'Install Harness Desktop from the macOS universal DMG on GitHub Releases.'],
    ['linux', 'Install Harness Desktop with the Linux Deb package from GitHub Releases.'],
  ] as const)('does not launch a substitute when no %s installation resolves', async (platform, route) => {
    const launch = vi.fn(async () => {})
    const activator = createInstalledDesktopActivator({
      platform,
      env: {},
      exists: vi.fn(async () => false),
      launch,
      diagnosticId: () => diagnosticId('33333333-3333-4333-8333-333333333333'),
    })

    await expect(activator.activate()).rejects.toMatchObject({
      installationRoute: route,
      diagnosticId: '33333333-3333-4333-8333-333333333333',
    })
    expect(launch).not.toHaveBeenCalled()
  })
})
