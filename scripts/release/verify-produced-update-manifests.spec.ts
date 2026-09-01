import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { snapshotArtifact, verifyProducedUpdateManifests } from './verify-produced-update-manifests.ts'

describe('snapshotArtifact', () => {
  it('keeps the exact pre-sign bytes when the caller path mutates later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-produced-snapshot-'))
    const source = join(root, 'candidate.zip')
    const snapshot = join(root, 'snapshot.zip')
    try {
      await writeFile(source, 'bytes selected for signing')
      await snapshotArtifact(source, snapshot)
      await writeFile(source, 'mutated after snapshot')

      await expect(readFile(snapshot, 'utf8')).resolves.toBe('bytes selected for signing')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('keeps separate explicit snapshot roots immutable across repeated verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-produced-repeated-'))
    const first = join(root, 'dist', 'ci-update-snapshots-review-a')
    const second = join(root, 'dist', 'ci-update-snapshots-review-b')
    const prior = process.env.DSH_UPDATE_SNAPSHOT_ROOT
    try {
      await mkdir(join(root, 'apps', 'desktop', 'release'), { recursive: true })
      await mkdir(join(root, 'dist', 'cli-standalone'), { recursive: true })
      await writeFile(
        join(root, 'apps', 'desktop', 'release', 'Harness Desktop Setup 1.0.1.exe'),
        zipSync({ 'Harness Desktop.exe': strToU8('desktop installer') }),
      )
      const cli = join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.zip')
      await writeFile(cli, zipSync({ 'payload/current/main.js': strToU8('export {}\n') }))
      await writeFile(join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.sha256'), 'fixture checksum\n')

      process.env.DSH_UPDATE_SNAPSHOT_ROOT = 'dist/ignored-by-explicit-option'
      await verifyProducedUpdateManifests({
        repositoryRoot: root,
        snapshotRoot: 'dist/ci-update-snapshots-review-a',
      })
      const firstBindings = await readFile(join(first, 'bindings.json'), 'utf8')
      await expect(verifyProducedUpdateManifests({
        repositoryRoot: root,
        snapshotRoot: 'dist/ci-update-snapshots-review-a',
      })).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(readFile(join(first, 'bindings.json'), 'utf8')).resolves.toBe(firstBindings)
      process.env.DSH_UPDATE_SNAPSHOT_ROOT = 'dist/ci-update-snapshots-review-b'
      await verifyProducedUpdateManifests({ repositoryRoot: root })

      await expect(readFile(join(first, 'bindings.json'), 'utf8')).resolves.toBe(firstBindings)
      await expect(readFile(join(second, 'bindings.json'), 'utf8')).resolves.toContain('cli/win32/x64/zip')
    } finally {
      if (prior === undefined) delete process.env.DSH_UPDATE_SNAPSHOT_ROOT
      else process.env.DSH_UPDATE_SNAPSHOT_ROOT = prior
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('allocates a fresh local snapshot root for every default verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-produced-default-repeat-'))
    const prior = process.env.DSH_UPDATE_SNAPSHOT_ROOT
    try {
      await mkdir(join(root, 'apps', 'desktop', 'release'), { recursive: true })
      await mkdir(join(root, 'dist', 'cli-standalone'), { recursive: true })
      await writeFile(
        join(root, 'apps', 'desktop', 'release', 'Harness Desktop Setup 1.0.1.exe'),
        zipSync({ 'Harness Desktop.exe': strToU8('desktop installer') }),
      )
      const cli = join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.zip')
      await writeFile(cli, zipSync({ 'payload/current/main.js': strToU8('export {}\n') }))
      await writeFile(join(root, 'dist', 'cli-standalone', 'harness-cli-1.0.1-win32-x64.sha256'), 'fixture checksum\n')
      delete process.env.DSH_UPDATE_SNAPSHOT_ROOT

      await verifyProducedUpdateManifests({ repositoryRoot: root })
      const firstRoot = (await readdir(join(root, 'dist'), { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('update-snapshots-'))
        .map(entry => join(root, 'dist', entry.name))
      expect(firstRoot).toHaveLength(1)
      const firstBindings = await readFile(join(firstRoot[0]!, 'bindings.json'), 'utf8')

      await verifyProducedUpdateManifests({ repositoryRoot: root })
      const roots = (await readdir(join(root, 'dist'), { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('update-snapshots-'))
        .map(entry => join(root, 'dist', entry.name))
      expect(roots).toHaveLength(2)
      await expect(readFile(join(firstRoot[0]!, 'bindings.json'), 'utf8')).resolves.toBe(firstBindings)
      await expect(readFile(join(roots.find(candidate => candidate !== firstRoot[0])!, 'bindings.json'), 'utf8'))
        .resolves.toContain('cli/win32/x64/zip')
    } finally {
      if (prior === undefined) delete process.env.DSH_UPDATE_SNAPSHOT_ROOT
      else process.env.DSH_UPDATE_SNAPSHOT_ROOT = prior
      await rm(root, { recursive: true, force: true })
    }
  })
})
