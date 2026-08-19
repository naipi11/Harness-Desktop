import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectLegacyImport,
  importLegacyDshHome,
  recordLegacyImportDecision,
  type HarnessHome,
  type HarnessHomeResolution,
  type LegacyImportFs,
} from '@harness-desktop/dsh-host-local-runtime/legacy-import'

/** One non-secret legacy data root; .credentials.yaml is never a candidate. */
const ROOTS = ['sessions', 'settings.yaml', 'projects'] as const

/**
 * Test-only sentinel that must never reach the target or diagnostics.
 * Generated at test runtime so no secret-like literal is committed.
 */
const SENTINEL = `sk-legacy-sentinel-${randomUUID()}`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Seed a legacy DSH_HOME with supported non-secret roots plus a credential document. */
async function seedLegacy(source: string): Promise<void> {
  await mkdir(join(source, 'sessions'), { recursive: true })
  await writeFile(join(source, 'sessions', 'one.jsonl'), '{"session":1}\n')
  await writeFile(join(source, 'settings.yaml'), 'theme: dark\n')
  await mkdir(join(source, 'projects'), { recursive: true })
  await writeFile(join(source, 'projects', 'note.txt'), 'project metadata\n')
  await writeFile(join(source, '.credentials.yaml'), SENTINEL + ': value\n')
}

function resolution(path: string, legacyDshHome: string | undefined): HarnessHomeResolution {
  return { path: path as HarnessHome, source: 'environment', legacyDshHome }
}

/** Recursively collect every file path under one root, for sentinel scans. */
async function allFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) {
      out.push(entry.parentPath === undefined ? join(root, entry.name) : join(entry.parentPath, entry.name))
    }
  }
  return out
}

async function assertNoSentinel(root: string): Promise<void> {
  for (const file of await allFiles(root)) {
    expect(await readFile(file, 'utf8')).not.toContain(SENTINEL)
  }
}

describe('importLegacyDshHome', () => {
  it('copies only supported non-secret roots into an empty target, preserving the source', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)

    const result = await importLegacyDshHome({ source, target: target as HarnessHome })

    expect(result).toEqual({
      kind: 'imported',
      copied: [...ROOTS],
      source,
      target: target as HarnessHome,
    })
    expect(await allFiles(source)).toEqual(
      expect.arrayContaining([
        join(source, 'sessions', 'one.jsonl'),
        join(source, 'settings.yaml'),
        join(source, 'projects', 'note.txt'),
        join(source, '.credentials.yaml'),
      ]),
    )
    await assertNoSentinel(target)
  })

  it('returns target-not-empty without touching either root when the target holds anything else', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const before = join(target, 'existing.txt')
    await writeFile(before, 'keep me\n')

    const result = await importLegacyDshHome({ source, target: target as HarnessHome })

    expect(result).toEqual({ kind: 'target-not-empty', target: target as HarnessHome })
    expect(await readFile(before, 'utf8')).toBe('keep me\n')
    expect(await allFiles(source)).toContain(join(source, 'sessions', 'one.jsonl'))
  })

  it('returns failed with retained roots and preserves both roots after an atomic-move failure', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const fsp = await import('node:fs/promises')
    const fs: LegacyImportFs = {
      ...fsp,
      rename: async (from, to) => {
        if (typeof from === 'string' && from.includes('settings.yaml')
          && typeof to === 'string' && !to.includes('.harness-legacy-import-')) {
          throw new Error('injected rename failure')
        }
        await fsp.rename(from, to)
      },
    }

    const result = await importLegacyDshHome({ source, target: target as HarnessHome, fs })

    expect(result).toMatchObject({
      kind: 'failed',
      retained: ['sessions'],
      source,
      target: target as HarnessHome,
    })
    expect(result.kind === 'failed' && typeof result.diagnosticId).toBe('string')
    expect(await allFiles(target)).toContain(join(target, 'sessions', 'one.jsonl'))
    expect(await allFiles(source)).toContain(join(source, '.credentials.yaml'))
    const siblings = (await readdir(dirname(target))).filter(name => name.startsWith('.harness-legacy-import-'))
    expect(siblings).toEqual([])
  })

  it('continues an accepted import from the retained roots on retry', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)

    const result = await importLegacyDshHome({ source, target: target as HarnessHome, retained: ['sessions'] })

    expect(result).toEqual({
      kind: 'imported',
      copied: ['settings.yaml', 'projects'],
      source,
      target: target as HarnessHome,
    })
    await assertNoSentinel(target)
  })

  it('reports not-found when the source is absent or holds only credential material', async () => {
    const absent = await tempDir('dsh-legacy-import-absent-')
    const target = await tempDir('dsh-legacy-import-target-')
    expect(await importLegacyDshHome({ source: join(absent, 'missing'), target: target as HarnessHome }))
      .toEqual({ kind: 'not-found' })

    const onlyCredentials = await tempDir('dsh-legacy-import-only-credentials-')
    await writeFile(join(onlyCredentials, '.credentials.yaml'), SENTINEL + ': value\n')
    expect(await importLegacyDshHome({ source: onlyCredentials, target: target as HarnessHome }))
      .toEqual({ kind: 'not-found' })
  })
})

describe('detectLegacyImport and recordLegacyImportDecision', () => {
  it('walks a pending decision through decline, accept, collision, and retry without secrets', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const resolved = resolution(target, source)

    await expect(detectLegacyImport(resolved)).resolves.toEqual({
      kind: 'decision-required',
      sourceLabel: 'DSH_HOME',
      retryable: false,
    })

    await recordLegacyImportDecision({ decision: 'declined', resolution: resolved })
    await expect(detectLegacyImport(resolved)).resolves.toEqual({ kind: 'declined' })

    await recordLegacyImportDecision({ decision: 'accepted', resolution: resolved })
    await expect(detectLegacyImport(resolved)).resolves.toMatchObject({
      kind: 'imported',
      copied: [...ROOTS],
    })
    const stateText = await readFile(join(target, 'legacy-migration.json'), 'utf8')
    expect(stateText).not.toContain(SENTINEL)
    expect(stateText).not.toContain(source)
    await assertNoSentinel(target)

    await writeFile(join(target, 'collision.txt'), 'blocking\n')
    await recordLegacyImportDecision({ decision: 'accepted', resolution: resolved })
    await expect(detectLegacyImport(resolved)).resolves.toMatchObject({
      kind: 'target-not-empty',
      retryable: true,
    })
    const collisionState = await readFile(join(target, 'legacy-migration.json'), 'utf8')
    expect(collisionState).not.toContain(SENTINEL)
    expect(collisionState).not.toContain(source)

    await rm(join(target, 'collision.txt'))
    await recordLegacyImportDecision({ decision: 'accepted', resolution: resolved })
    // The retry is idempotent: roots already moved before the collision are
    // retained, so a fixed collision reports imported without re-copying them.
    await expect(detectLegacyImport(resolved)).resolves.toMatchObject({
      kind: 'imported',
      copied: [],
    })
  })

  it('reports not-needed when no legacy home exists', async () => {
    const target = await tempDir('dsh-legacy-import-target-')
    await expect(detectLegacyImport(resolution(target, undefined))).resolves.toEqual({ kind: 'not-needed' })
  })
})
