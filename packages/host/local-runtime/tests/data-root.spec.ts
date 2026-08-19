import { posix, resolve, win32 } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

/** Read one source-owned repository file without depending on the test process cwd. */
function readRepositoryFile(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8')
}

describe('Harness data-root resolver', () => {
  it('exposes no writer-level data-root resolver', () => {
    expect(localRuntime).not.toHaveProperty('resolveConfiguredHarnessHome')
  })

  it('passes the injected home to managed shell commands as HARNESS_HOME', () => {
    const registry = new ShellEnvRegistry(new Context(), { harnessHome: '/srv/harness' })

    expect(registry.collect({} as never)).toMatchObject({ HARNESS_HOME: '/srv/harness' })
    expect(registry.collect({} as never)).not.toHaveProperty('DSH_HOME')
  })

  it('leaves DSH_HOME policy only in the marked legacy-import reader', () => {
    const sources = [
      'apps/cli/src/profile-boot.ts',
      'apps/cli/src/web-daemon.ts',
      'packages/attachment/attachment-local/src/index.ts',
      'packages/boot/app-boot/src/index.ts',
      'packages/boot/app-boot/src/profile.ts',
      'packages/context/agent-instructions/src/config.ts',
      'packages/credentials/credentials-local/src/index.ts',
      'packages/examples/agent-spine-demo/src/index.ts',
      'packages/identity/anonymous-user-id/src/index.ts',
      'packages/preset/agent-presets/src/index.ts',
      'packages/settings/settings-file/src/index.ts',
      'packages/shell/shell-env/src/index.ts',
      'packages/skill/skill-filesystem/src/index.ts',
    ]
    for (const source of sources) {
      const text = readRepositoryFile(source)
      expect(text).not.toMatch(/resolveDshHome|dshHomePath|resolveConfiguredHarnessHome|DSH_HOME/)
    }

    expect(readRepositoryFile('packages/host/local-runtime/src/data-root.ts')).toContain('legacyDshHome: env.DSH_HOME')
  })

  it('mounts every base durable writer from the injected Harness home', () => {
    const composition = readRepositoryFile('packages/bundle/base/cordis.patch.yml')
    for (const id of [
      'settings',
      'credentials',
      'attachment-local',
      'shell-env',
      'agent-instructions',
      'skill-filesystem',
    ]) {
      expect(composition).toMatch(new RegExp(`id: ${id}\\s+name: [^\\n]+\\s+config:\\s+.*harnessHome: !!js harnessHome`, 's'))
    }
    expect(composition).toMatch(/id: session-persistence-jsonl\s+name: [^\n]+\s+config:\s+root: !!js harnessHomePath\('sessions'\)/s)
  })

  it('forwards the resolved home to every agent-spine durable writer', () => {
    const source = readRepositoryFile('packages/examples/agent-spine-demo/src/index.ts')

    expect(source).toContain('ctx.plugin(SkillFileSystem, Object.assign({}, config.skills?.filesystem, { harnessHome }))')
    expect(source).toContain('ctx.plugin(bashEnv, { harnessHome })')
    expect(source).toContain('ctx.plugin(workspaceContext, Object.assign({}, config.workspaceContext, { harnessHome }))')
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

  it('derives platform defaults from explicit test inputs', () => {
    expect(defaultHarnessHome('linux', {}, '/home/ada')).toBe('/home/ada/.local/share/harness-desktop' as HarnessHome)
  })
})
