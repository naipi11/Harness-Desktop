import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLocalRuntimePlugin,
  defaultHarnessHome,
  resolveHarnessHome,
  type HarnessHome,
} from '@harness-desktop/dsh-host-local-runtime'
import * as localRuntime from '@harness-desktop/dsh-host-local-runtime'
import { Context } from '@harness-desktop/cordis'
import { ShellEnvRegistry } from '@harness-desktop/dsh-shell-env'
import { LocalAttachmentStore } from '@harness-desktop/dsh-attachment-local'

describe('Harness data-root resolver', () => {
  it('exposes no writer-level data-root resolver', () => {
    expect(localRuntime).not.toHaveProperty('resolveConfiguredHarnessHome')
  })

  it('passes the injected home to managed shell commands as HARNESS_HOME', () => {
    const registry = new ShellEnvRegistry(new Context(), { harnessHome: '/srv/harness' })

    expect(registry.collect({} as never)).toMatchObject({ HARNESS_HOME: '/srv/harness' })
    expect(registry.collect({} as never)).not.toHaveProperty('DSH_HOME')
  })

  it.each([
    {
      name: 'uses LOCALAPPDATA on Windows',
      input: {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
        homeDir: 'C:\\Users\\Ada',
      },
      expected: 'C:\\Users\\Ada\\AppData\\Local\\Harness Desktop',
    },
    {
      name: 'uses the macOS application-support directory',
      input: { platform: 'darwin', env: {}, homeDir: '/Users/ada' },
      expected: '/Users/ada/Library/Application Support/Harness Desktop',
    },
    {
      name: 'uses XDG data on Linux',
      input: { platform: 'linux', env: { XDG_DATA_HOME: '/var/lib/ada-data' }, homeDir: '/home/ada' },
      expected: '/var/lib/ada-data/harness-desktop',
    },
    {
      name: 'uses the Linux freedesktop fallback',
      input: { platform: 'linux', env: {}, homeDir: '/home/ada' },
      expected: '/home/ada/.local/share/harness-desktop',
    },
  ])('$name', ({ input, expected }) => {
    expect(resolveHarnessHome(input)).toEqual({
      path: expected as HarnessHome,
      source: 'platform-default',
      legacyDshHome: undefined,
    })
  })

  it('normalizes a HARNESS_HOME override without using DSH_HOME as a write target', () => {
    const resolution = resolveHarnessHome({
      platform: 'linux',
      env: { HARNESS_HOME: './state', DSH_HOME: '/legacy/dsh' },
      homeDir: '/home/ada',
    })

    expect(resolution.path).toBe(posix.resolve('./state') as HarnessHome)
    expect(resolution.source).toBe('environment')
    expect(resolution.legacyDshHome).toBe('/legacy/dsh')
  })

  it('expands home-relative HARNESS_HOME overrides using the injected home directory', () => {
    expect(resolveHarnessHome({
      platform: 'win32',
      env: { HARNESS_HOME: '~\\state' },
      homeDir: 'C:\\Users\\Ada',
    }).path).toBe(win32.join('C:\\Users\\Ada', 'state') as HarnessHome)
  })

  it('rejects blank HARNESS_HOME overrides', () => {
    expect(() => resolveHarnessHome({
      platform: 'linux',
      env: { HARNESS_HOME: '  ' },
      homeDir: '/home/ada',
    })).toThrow('HARNESS_HOME must not be blank')
  })

  it('constructs an absolute provider once for all writer paths', () => {
    const provider = createLocalRuntimePlugin({
      platform: 'linux',
      env: { HARNESS_HOME: '/srv/harness' },
      homeDir: '/home/ada',
    })

    expect(provider.home).toBe('/srv/harness' as HarnessHome)
    expect(provider.path('settings.yaml')).toBe('/srv/harness/settings.yaml')
  })

  it('mounts a durable writer from the resolved provider, not a caller path', () => {
    const provider = createLocalRuntimePlugin({
      platform: 'linux',
      env: { HARNESS_HOME: '/srv/harness' },
      homeDir: '/home/ada',
    })

    const attachment = new LocalAttachmentStore(new Context(), { harnessHome: provider })
    expect(attachment.root).toBe('/srv/harness/attachments/v1')
  })

  it('derives platform defaults from explicit test inputs', () => {
    expect(defaultHarnessHome('linux', {}, '/home/ada')).toBe('/home/ada/.local/share/harness-desktop' as HarnessHome)
  })
})
