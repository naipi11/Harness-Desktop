import { posix, resolve, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLocalRuntimePlugin,
  defaultHarnessHome,
  resolveConfiguredHarnessHome,
  resolveHarnessHome,
  type HarnessHome,
} from '@harness-desktop/dsh-host-local-runtime'

describe('Harness data-root resolver', () => {
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

  it('resolves an explicit writer configuration through HARNESS_HOME policy', () => {
    const previous = process.env.HARNESS_HOME
    try {
      process.env.HARNESS_HOME = '/ambient/harness'
      expect(resolveConfiguredHarnessHome('/configured/harness')).toBe(resolve('/configured/harness') as HarnessHome)
    } finally {
      if (previous === undefined) delete process.env.HARNESS_HOME
      else process.env.HARNESS_HOME = previous
    }
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

  it('derives platform defaults from explicit test inputs', () => {
    expect(defaultHarnessHome('linux', {}, '/home/ada')).toBe('/home/ada/.local/share/harness-desktop' as HarnessHome)
  })
})
