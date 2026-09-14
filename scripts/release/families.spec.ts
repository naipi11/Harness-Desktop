/** Release family discovery, publish order, tag naming, and the bump judgements. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { releaseFamily, type ReleaseMember } from './families.ts'
import { compareVersions, nextVendorVersion, reachesPayload } from './bump.ts'

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

function writeManifest(root: string, directory: string, name: string): void {
  const path = join(root, directory, 'package.json')
  mkdirSync(join(root, directory), { recursive: true })
  writeFileSync(path, JSON.stringify({ name, version: '0.0.1' }))
}

describe('release families', () => {
  it('validates package scopes per family while preserving root exclusion', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-family-'))
    try {
      writeManifest(root, 'packages/core/first-party', '@stackstackstack/dsh-core')
      expect(releaseFamily('dsh').members(root).map(entry => entry.name)).toEqual(['@stackstackstack/dsh-core'])

      rmSync(join(root, 'packages'), { recursive: true, force: true })
      writeManifest(root, 'vendor/cordis', '@deepseek-ai/cordis')
      expect(releaseFamily('vendor').members(root).map(entry => entry.name)).toEqual(['@deepseek-ai/cordis'])

      rmSync(join(root, 'vendor'), { recursive: true, force: true })
      writeManifest(root, 'vendor/cordis', '@stackstackstack/dsh-core')
      expect(() => { releaseFamily('vendor').members(root) }).toThrow(/must name a @deepseek-ai/)

      rmSync(join(root, 'vendor'), { recursive: true, force: true })
      writeManifest(root, 'vendor/cordis', '@deepseek-ai/cordis')
      expect(() => { releaseFamily('dsh').members(root) }).toThrow(/matched no manifests/)

      rmSync(join(root, 'vendor'), { recursive: true, force: true })
      writeManifest(root, 'vendor/cordis', '@stackstackstack/dsh-root')
      expect(() => { releaseFamily('vendor').members(root) }).toThrow(/selected the workspace root/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names one tag for the whole dsh family and one per vendored package', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')
    const cli = member('apps/cli', '@stackstackstack/dsh')
    const cordis = { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' }

    expect(dsh.tagFor(cli)).toBe('dsh-v0.0.1')
    expect(vendor.tagFor(cordis)).toBe('vendor-cordis-v4.0.1')
    // The prefix is constructed, not recovered from a tag: a version with a
    // hyphen would defeat any suffix-stripping.
    expect(vendor.tagPrefixFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v')
    expect(vendor.tagFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v4.0.0-rc.7')
  })

  it('rejects a family whose members disagree on the shared version', () => {
    const dsh = releaseFamily('dsh')
    const members = [member('apps/cli', '@stackstackstack/dsh'), { ...member('apps/web', '@stackstackstack/dsh-web-frontend'), version: '0.0.2' }]

    expect(() => { dsh.verifyVersions(members) }).toThrow(/must share one version/)
    expect(() => { dsh.verifyVersions([members[0]!]) }).not.toThrow()
  })

  it('accepts independent vendored versions and rejects an unpublishable one', () => {
    const vendor = releaseFamily('vendor')
    const members = [
      { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' },
      { ...member('vendor/cosmokit', '@deepseek-ai/cosmokit'), version: '1.8.2' },
    ]

    expect(() => { vendor.verifyVersions(members) }).not.toThrow()
    expect(() => { vendor.verifyVersions([{ ...members[0]!, version: 'latest' }]) }).toThrow(/unpublishable version/)
  })

  it('publishes a dependency before its consumer, and orders ties by name', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/consumer', '@stackstackstack/dsh-consumer', { dependencies: { '@stackstackstack/dsh-library': 'workspace:^' } }),
      member('packages/a/library', '@stackstackstack/dsh-library'),
      member('packages/a/zebra', '@stackstackstack/dsh-zebra'),
    ]

    expect(dsh.publishOrder(members).map(entry => entry.name)).toEqual([
      '@stackstackstack/dsh-library',
      '@stackstackstack/dsh-consumer',
      '@stackstackstack/dsh-zebra',
    ])
  })

  it('reports a runtime dependency cycle instead of emitting an arbitrary order', () => {
    const dsh = releaseFamily('dsh')
    const members = [
      member('packages/a/left', '@stackstackstack/dsh-left', { dependencies: { '@stackstackstack/dsh-right': 'workspace:^' } }),
      member('packages/a/right', '@stackstackstack/dsh-right', { dependencies: { '@stackstackstack/dsh-left': 'workspace:^' } }),
    ]

    expect(() => { dsh.publishOrder(members) }).toThrow(/dependency cycle/)
  })

  it('applies the harness payload policy to dsh and keeps upstream payloads for vendored packages', () => {
    const dsh = releaseFamily('dsh')
    const vendor = releaseFamily('vendor')
    const harness = member('packages/a/library', '@stackstackstack/dsh-library')
    const vendored = member('vendor/cordis', '@deepseek-ai/cordis')

    expect(() => { dsh.validatePayload(harness, ['package/lib/index.js', 'package/src/index.ts']) })
      .toThrow(/publishes source file/)
    expect(() => { vendor.validatePayload(vendored, ['package/lib/index.js', 'package/src/index.ts']) }).not.toThrow()
    expect(() => { vendor.validatePayload(vendored, []) }).toThrow(/empty tarball/)
  })

  it('drives the installed entry only for the family that publishes one', () => {
    expect(releaseFamily('dsh').installedEntry).toEqual({ packageName: '@stackstackstack/dsh', binPath: 'lib/bin.js' })
    expect(releaseFamily('vendor').installedEntry).toBeUndefined()
  })

  it('rejects an unknown family identifier', () => {
    expect(() => { releaseFamily('native') }).toThrow(/unknown release family/)
  })
})

describe('vendored version baseline', () => {
  it('drops an upstream prerelease segment and increments the patch', () => {
    expect(nextVendorVersion('4.0.0-rc.7', undefined)).toBe('4.0.1')
    expect(nextVendorVersion('1.0.0-rc.5', undefined)).toBe('1.0.1')
    expect(nextVendorVersion('1.8.1', undefined)).toBe('1.8.2')
  })

  it('increments from the last published version when a re-sync restored a lower one', () => {
    // Upstream moved rc.7 -> rc.8 after this repository published 4.0.1;
    // incrementing the manifest alone would name 4.0.1 a second time.
    expect(nextVendorVersion('4.0.0-rc.8', '4.0.1')).toBe('4.0.2')
    expect(nextVendorVersion('4.1.0', '4.0.1')).toBe('4.1.1')
  })

  it('appends a rehearsal prerelease without consuming its release numbers', () => {
    // A rehearsal burns 4.0.1-rc.1 and leaves 4.0.1 free, so the stable release
    // that follows takes those same numbers instead of skipping to 4.0.2.
    expect(nextVendorVersion('4.0.0-rc.7', undefined, 'rc.1')).toBe('4.0.1-rc.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1', 'rc.2')).toBe('4.0.1-rc.2')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1')).toBe('4.0.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1')).toBe('4.0.2')
  })
})

describe('version precedence', () => {
  it('ranks a release above the prerelease it follows', () => {
    // git --sort=v:refname disagrees, placing 4.0.1-rc.1 above 4.0.1, which is
    // why the newest published version is chosen here rather than by git.
    expect(compareVersions('4.0.1', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('compares numeric prerelease fields numerically', () => {
    expect(compareVersions('4.0.1-rc.10', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.2', '4.0.1-rc.10')).toBeLessThan(0)
  })

  it('ranks a numeric field below an alphanumeric one, and a shorter list below a longer', () => {
    expect(compareVersions('4.0.1-1', '4.0.1-alpha')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.2', '4.0.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1-rc.1')).toBe(0)
  })
})

describe('payload change judgement', () => {
  const sourceShipping = member('vendor/cosmokit', '@deepseek-ai/cosmokit', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'src'],
  })
  const buildOutputOnly = member('vendor/cordis', '@deepseek-ai/cordis', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'bin.js'],
  })

  it('counts the manifest and the files npm always publishes', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/package.json')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.md')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/src/index.ts')).toBe(true)
  })

  it('counts build inputs for a package whose payload is build output', () => {
    // cordis publishes lib/ only, and lib/ is not tracked: without this, a real
    // source change reads as "nothing changed" and the next publish fails on a
    // version whose bytes moved.
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/src/context.ts')).toBe(true)
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/tsconfig.json')).toBe(true)
  })

  it('ignores paths no tarball carries', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/tests/unit.spec.ts')).toBe(false)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/CHANGELOG.md')).toBe(false)
    // The README pattern is deliberately loose: over-reporting a change costs one
    // unnecessary patch bump, while under-reporting fails the next publish on a
    // version whose bytes moved.
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.i18n.yaml')).toBe(true)
    expect(reachesPayload(member('packages/a/library', '@stackstackstack/dsh-library', { files: ['lib/index.js'] }),
      'packages/a/library/tests/library.spec.ts')).toBe(false)
  })
})
