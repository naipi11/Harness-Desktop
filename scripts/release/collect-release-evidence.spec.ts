import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { collectReleaseEvidence } from './collect-release-evidence.ts'
import { verifyProducedUpdateManifests } from './verify-produced-update-manifests.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-release-evidence-'))
  roots.push(root)
  await mkdir(join(root, 'dist', 'ci-update-snapshots', 'artifacts'), { recursive: true })
  await mkdir(join(root, 'dist', 'ci-update-snapshots', 'manifests', 'ready'), { recursive: true })
  return root
}

function environment(overrides: Readonly<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_SHA: 'A'.repeat(40),
    DSH_RELEASE_MATRIX_LABEL: 'windows-nsis',
    DSH_RELEASE_CLI_FORMAT: 'zip',
    DSH_RELEASE_CHECK_NODE_RUNTIME: 'success',
    DSH_RELEASE_CHECK_DESKTOP_ARTIFACTS: 'success',
    DSH_RELEASE_CHECK_DESKTOP_UPDATER: 'success',
    DSH_RELEASE_CHECK_PACKED_CLI: 'success',
    DSH_RELEASE_CHECK_CLI_ARCHIVES: 'success',
    DSH_RELEASE_CHECK_UPDATE_MANIFESTS: 'success',
    DSH_RELEASE_CHECK_PRODUCED_UPDATE_MANIFESTS: 'success',
    DSH_RELEASE_CHECK_CLI_UPDATER: 'success',
    DSH_RELEASE_CHECK_INSTALLED_DESKTOP: 'success',
    DSH_RELEASE_CHECK_NATIVE_UPDATE_ROLLBACK: 'success',
    DSH_UPDATE_SNAPSHOT_ROOT: 'dist/ci-update-snapshots',
    ...overrides,
  }
}

describe('collectReleaseEvidence', () => {
  it('writes a redacted, deterministic inventory with sorted artifact hashes', async () => {
    const root = await fixture()
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'z-installer.exe'), 'desktop bytes')
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'manifests', 'ready', 'manifest.json'), '{"policy":"policy-secret"}')
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'a-cli.zip'), 'cli bytes')
    await utimes(join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'z-installer.exe'), new Date(1), new Date(2))
    const env = environment({ TOP_SECRET: 'must-not-appear', GITHUB_SHA: 'B'.repeat(40) })

    const first = await collectReleaseEvidence({
      repositoryRoot: root,
      environment: env,
      runnerPlatform: 'win32',
      runnerArch: 'x64',
    })
    const output = join(root, 'dist', 'release-logs', 'release-evidence.json')
    const firstBytes = await readFile(output, 'utf8')
    await expect(collectReleaseEvidence({
      repositoryRoot: root,
      environment: env,
      runnerPlatform: 'win32',
      runnerArch: 'x64',
    })).rejects.toThrow('final output already exists')
    await rm(output)
    const second = await collectReleaseEvidence({
      repositoryRoot: root,
      environment: env,
      runnerPlatform: 'win32',
      runnerArch: 'x64',
    })

    expect(second).toEqual(first)
    expect(await readFile(output, 'utf8')).toBe(firstBytes)
    expect(first).toEqual({
      schemaVersion: 2,
      runner: { platform: 'win32', arch: 'x64' },
      commit: 'b'.repeat(40),
      matrixLabel: 'windows-nsis',
      cliFormat: 'zip',
      checks: {
        nodeRuntime: 'success',
        desktopArtifacts: 'success',
        desktopUpdater: 'success',
        packedCli: 'success',
        cliArchives: 'success',
        updateManifests: 'success',
        producedUpdateManifests: 'success',
        cliUpdater: 'success',
        installedDesktop: 'success',
        nativeUpdateRollback: 'success',
      },
      artifacts: [
        {
          basename: 'a-cli.zip',
          size: 9,
          sha256: createHash('sha256').update('cli bytes').digest('hex'),
        },
        {
          basename: 'manifest.json',
          size: 26,
          sha256: createHash('sha256').update('{"policy":"policy-secret"}').digest('hex'),
        },
        {
          basename: 'z-installer.exe',
          size: 13,
          sha256: createHash('sha256').update('desktop bytes').digest('hex'),
        },
      ],
      manifestBindings: [],
    })
    expect(firstBytes).not.toContain(root)
    expect(firstBytes).not.toContain('TOP_SECRET')
    expect(firstBytes).not.toContain('must-not-appear')
    expect(firstBytes).not.toContain('policy-secret')
  })

  it('reads artifacts and bindings from the explicitly configured snapshot root', async () => {
    const root = await fixture()
    const configured = join(root, 'dist', 'ci-update-snapshots-review')
    await mkdir(join(configured, 'artifacts'), { recursive: true })
    await mkdir(join(configured, 'manifests', 'ready'), { recursive: true })
    await writeFile(join(configured, 'artifacts', 'candidate.zip'), 'configured artifact')
    await writeFile(join(configured, 'manifests', 'ready', 'stable-cli.json'), 'configured manifest')
    await writeFile(join(configured, 'bindings.json'), `${JSON.stringify([{
      target: 'cli/win32/x64/zip',
      artifact: {
        basename: 'candidate.zip',
        sha256: createHash('sha256').update('configured artifact').digest('hex'),
      },
      manifest: {
        basename: 'stable-cli.json',
        sha256: createHash('sha256').update('configured manifest').digest('hex'),
      },
    }])}\n`)

    const evidence = await collectReleaseEvidence({
      repositoryRoot: root,
      snapshotRoot: 'dist/ci-update-snapshots-review',
      environment: environment({ DSH_UPDATE_SNAPSHOT_ROOT: 'dist/ignored-by-explicit-option' }),
      runnerPlatform: 'win32',
      runnerArch: 'x64',
    })

    expect(evidence.artifacts.map(artifact => artifact.basename)).toEqual(['candidate.zip', 'stable-cli.json'])
    expect(evidence.manifestBindings).toHaveLength(1)
  })

  it('requires an explicit snapshot root instead of reading the fixed CI path locally', async () => {
    const root = await fixture()
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'stale-installer.exe'), 'stale artifact')

    await expect(collectReleaseEvidence({
      repositoryRoot: root,
      environment: environment({ DSH_UPDATE_SNAPSHOT_ROOT: undefined }),
    })).rejects.toThrow('release evidence: DSH_UPDATE_SNAPSHOT_ROOT is required')
    await expect(readFile(join(root, 'dist', 'release-logs', 'release-evidence.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'win32')('rejects stale fixed evidence after default verification reserves a fresh root', async () => {
    const root = await fixture()
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'stale-installer.exe'), 'stale artifact')
    await mkdir(join(root, 'apps', 'desktop', 'release'), { recursive: true })
    await mkdir(join(root, 'dist', 'cli-standalone'), { recursive: true })
    await writeFile(
      join(root, 'apps', 'desktop', 'release', 'Harness Desktop Setup 1.0.1.exe'),
      zipSync({ 'Harness Desktop.exe': strToU8('fresh desktop installer') }),
    )
    await writeFile(
      join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.zip'),
      zipSync({ 'payload/current/main.js': strToU8('export {}\n') }),
    )
    await writeFile(
      join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.sha256'),
      'fresh checksum\n',
    )
    const localEnvironment = environment({ DSH_UPDATE_SNAPSHOT_ROOT: undefined })

    await verifyProducedUpdateManifests({ repositoryRoot: root, environment: localEnvironment })
    const freshRoots = (await readdir(join(root, 'dist'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('update-snapshots-'))
    expect(freshRoots).toHaveLength(1)

    await expect(collectReleaseEvidence({
      repositoryRoot: root,
      environment: localEnvironment,
      runnerPlatform: 'win32',
      runnerArch: 'x64',
    })).rejects.toThrow('release evidence: DSH_UPDATE_SNAPSHOT_ROOT is required')
    await expect(readFile(join(root, 'dist', 'release-logs', 'release-evidence.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes failure evidence when artifact roots are absent and omits an invalid commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-release-evidence-empty-'))
    roots.push(root)

    const evidence = await collectReleaseEvidence({
      repositoryRoot: root,
      environment: environment({
        GITHUB_SHA: 'not-a-commit',
        DSH_RELEASE_CHECK_DESKTOP_ARTIFACTS: 'failure',
        DSH_RELEASE_CHECK_CLI_UPDATER: undefined,
      }),
      runnerPlatform: 'linux',
      runnerArch: 'arm64',
    })

    expect(evidence).not.toHaveProperty('commit')
    expect(evidence.artifacts).toEqual([])
    expect(evidence.manifestBindings).toEqual([])
    expect(evidence.checks.desktopArtifacts).toBe('failure')
    expect(evidence.checks.cliUpdater).toBe('not-run')
    expect(await readFile(join(root, 'dist', 'release-logs', 'release-evidence.json'), 'utf8')).toContain('"artifacts": []')
  })

  it('rejects invalid safe environment values before writing evidence', async () => {
    const root = await fixture()

    await expect(collectReleaseEvidence({
      repositoryRoot: root,
      environment: environment({ DSH_RELEASE_CLI_FORMAT: 'exe' }),
    })).rejects.toThrow('DSH_RELEASE_CLI_FORMAT is invalid')
    await expect(collectReleaseEvidence({
      repositoryRoot: root,
      environment: environment({ DSH_RELEASE_CHECK_CLI_ARCHIVES: 'unknown' }),
    })).rejects.toThrow('DSH_RELEASE_CHECK_CLI_ARCHIVES is invalid')
  })

  it('never overwrites a prior regular evidence document', async () => {
    const root = await fixture()
    const outputDirectory = join(root, 'dist', 'release-logs')
    await mkdir(outputDirectory)
    const output = join(outputDirectory, 'release-evidence.json')
    await writeFile(output, 'prior evidence\n')

    await expect(collectReleaseEvidence({ repositoryRoot: root, environment: environment() }))
      .rejects.toThrow('final output already exists')
    await expect(readFile(output, 'utf8')).resolves.toBe('prior evidence\n')
  })

  it('rejects an artifact mutated after its manifest binding was written', async () => {
    const root = await fixture()
    const artifact = join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'candidate.zip')
    const manifest = join(root, 'dist', 'ci-update-snapshots', 'manifests', 'ready', 'stable-cli.json')
    await writeFile(artifact, 'signed artifact')
    await writeFile(manifest, 'signed manifest')
    await writeFile(join(root, 'dist', 'ci-update-snapshots', 'bindings.json'), `${JSON.stringify([{
      target: 'cli/win32/x64/zip',
      artifact: { basename: 'candidate.zip', sha256: createHash('sha256').update('signed artifact').digest('hex') },
      manifest: { basename: 'stable-cli.json', sha256: createHash('sha256').update('signed manifest').digest('hex') },
    }])}\n`)
    await writeFile(artifact, 'mutated after bind')

    await expect(collectReleaseEvidence({ repositoryRoot: root, environment: environment() }))
      .rejects.toThrow('manifest binding does not match immutable snapshots')
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links in artifact roots', async () => {
    const root = await fixture()
    const outside = join(root, 'outside.bin')
    await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'dist', 'ci-update-snapshots', 'artifacts', 'escape.bin'))

    await expect(collectReleaseEvidence({ repositoryRoot: root, environment: environment() }))
      .rejects.toThrow('symbolic links and reparse points are forbidden')
  })
})
