import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Branded } from '@harness-desktop/dsh-brand'
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

interface BuilderIdentityConfig {
  readonly executableName: string
  readonly productName: string
}

const desktopManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../desktop/package.json', import.meta.url)), 'utf8'),
) as { readonly name: string }
const builderModule: unknown = await import(
  pathToFileURL(fileURLToPath(new URL('../../desktop/electron-builder.config.mjs', import.meta.url))).href,
)
const builderConfig = (builderModule as { readonly default: BuilderIdentityConfig }).default
const builderPackageRoot = desktopManifest.name.replaceAll('/', '')
const builderExecutable = builderConfig.executableName

function output(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8').on('data', (chunk: string) => { value += chunk })
  return { stream, text: () => value }
}

function diagnosticId(value: string): DesktopDiagnosticId {
  return value as Branded<'DesktopDiagnosticId'>
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
    ['win32', { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' }, win32.join('C:\\Users\\person\\AppData\\Local', 'Programs', builderConfig.productName, `${builderExecutable}.exe`), []],
    ['darwin', { HOME: '/Users/person' }, 'open', [posix.join('/Users/person/Applications', `${builderConfig.productName}.app`)]],
    ['linux', { HOME: '/home/person', XDG_DATA_HOME: '/home/person/.local/share' }, 'gio', ['launch', '/home/person/.local/share/applications/io.github.naipi11.harness-desktop.desktop']],
  ] as const)(
    'resolves and activates only the installed %s application',
    async (platform, env, expectedCommand, expectedArgs) => {
      const launch = vi.fn(async () => platform === 'win32'
        ? { kind: 'spawned' as const }
        : { kind: 'exited' as const, exitCode: 0 })
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
      expect(launch).toHaveBeenCalledWith(expectedCommand, expectedArgs, platform !== 'win32')
    },
  )

  it('resolves a machine-wide Windows installation without a per-user Programs segment', async () => {
    const launch = vi.fn(async () => ({ kind: 'spawned' as const }))
    const installed = win32.join('C:\\Program Files', builderConfig.productName, `${builderExecutable}.exe`)
    const activator = createInstalledDesktopActivator({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: async path => path === installed,
      launch,
      diagnosticId: () => diagnosticId('22222222-2222-4222-8222-222222222222'),
    })

    await expect(activator.activate()).resolves.toBe('activated')
    expect(launch).toHaveBeenCalledWith(installed, [], false)
  })

  it.each([
    [
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' },
      win32.join('C:\\Users\\person\\AppData\\Local', 'Programs', builderPackageRoot, `${builderExecutable}.exe`),
      win32.join('C:\\Users\\person\\AppData\\Local', 'Programs', builderPackageRoot, `${builderExecutable}.exe`),
      [],
      { kind: 'spawned' as const },
    ],
    [
      'darwin',
      { HOME: '/Users/person' },
      posix.join('/Users/person/Applications', `${builderExecutable}.app`),
      'open',
      [posix.join('/Users/person/Applications', `${builderExecutable}.app`)],
      { kind: 'exited' as const, exitCode: 0 },
    ],
  ] as const)(
    'activates the electron-builder-derived %s artifact candidate',
    async (platform, env, installed, expectedCommand, expectedArgs, result) => {
      const launch = vi.fn(async () => result)
      const activator = createInstalledDesktopActivator({
        platform,
        env,
        exists: async path => path === installed,
        launch,
        diagnosticId: () => diagnosticId('44444444-4444-4444-8444-444444444444'),
      })

      await expect(activator.activate()).resolves.toBe('activated')
      expect(launch).toHaveBeenCalledWith(expectedCommand, expectedArgs, platform !== 'win32')
    },
  )

  it('rejects a resolved macOS helper whose process exits nonzero', async () => {
    const installed = posix.join('/Users/person/Applications', `${builderExecutable}.app`)
    const activator = createInstalledDesktopActivator({
      platform: 'darwin',
      env: { HOME: '/Users/person' },
      exists: async path => path === installed,
      launch: async () => ({ kind: 'exited', exitCode: 7 }),
      diagnosticId: () => diagnosticId('55555555-5555-4555-8555-555555555555'),
    })

    await expect(activator.activate()).rejects.toMatchObject({
      diagnosticId: '55555555-5555-4555-8555-555555555555',
    })
  })

  it.each([
    ['win32', 'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.'],
    ['darwin', 'Install Harness Desktop from the macOS universal DMG on GitHub Releases.'],
    ['linux', 'Install Harness Desktop with the Linux Deb package from GitHub Releases.'],
  ] as const)('does not launch a substitute when no %s installation resolves', async (platform, route) => {
    const launch = vi.fn(async () => ({ kind: 'spawned' as const }))
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
