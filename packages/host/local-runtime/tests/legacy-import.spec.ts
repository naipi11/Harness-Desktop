import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@harness-desktop/dsh-atomic-write'
import {
  detectLegacyImport,
  importLegacyDshHome,
  LEGACY_MIGRATION_FILENAME,
  recordLegacyImportDecision,
  type HarnessHome,
  type HarnessHomeResolution,
  type LegacyImportFs,
} from '@harness-desktop/dsh-host-local-runtime/legacy-import'

vi.mock('@harness-desktop/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@harness-desktop/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

describe('durable legacy migration record validation', () => {
  it.each([
    { kind: 'declined', accessToken: 'private-token' },
    { kind: 'imported', copied: ['C:\\Users\\person\\secret-token.txt'] },
    { kind: 'failed', retained: [], retryable: true, diagnosticId: 'not-a-runtime-diagnostic-id' },
  ])('rejects corrupt or secret-bearing state without reflecting its value: %#', async (state) => {
    const target = await tempDir('harness-legacy-corrupt-target-')
    const legacy = await tempDir('harness-legacy-corrupt-source-')
    await writeFile(join(target, LEGACY_MIGRATION_FILENAME), JSON.stringify(state) + '\n')

    const error = await detectLegacyImport(resolution(target, legacy))
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('legacy-migration.json')
    expect(String(error)).not.toMatch(/private-token|C:\\Users|secret-token|not-a-runtime/)
  })

  it('accepts tiny and exact-limit state files, then rejects oversize and multibyte files before JSON parsing', async () => {
    const limit = 65_536
    const target = await tempDir('harness-legacy-bounded-target-')
    const legacy = await tempDir('harness-legacy-bounded-source-')
    const stateFile = join(target, LEGACY_MIGRATION_FILENAME)
    await writeFile(stateFile, '{"kind":"declined"}\n')
    await expect(detectLegacyImport(resolution(target, legacy))).resolves.toEqual({ kind: 'declined' })

    const prefix = '{"kind":"declined"}'
    const exact = prefix + ' '.repeat(limit - Buffer.byteLength(prefix) - 1) + '\n'
    expect(Buffer.byteLength(exact)).toBe(limit)
    await writeFile(stateFile, exact)
    await expect(detectLegacyImport(resolution(target, legacy))).resolves.toEqual({ kind: 'declined' })

    await writeFile(stateFile, exact + ' ')
    await expect(detectLegacyImport(resolution(target, legacy))).rejects.toThrow('exceeds')
    const multibyte = prefix + '界'.repeat(Math.ceil(limit / 3))
    expect(multibyte.length).toBeLessThan(limit)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(limit)
    await writeFile(stateFile, multibyte)
    await expect(detectLegacyImport(resolution(target, legacy))).rejects.toThrow('exceeds')
  })
})

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

  it.each([
    ['source readdir', 'source-readdir'],
    ['target readdir', 'target-readdir'],
    ['target mkdir', 'target-mkdir'],
    ['staging mkdtemp', 'staging-mkdtemp'],
  ] as const)('returns failed and preserves both roots after a %s failure', async (_label, failure) => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const fsp = await import('node:fs/promises')
    const fs: LegacyImportFs = {
      ...fsp,
      readdir: (async (path: string) => {
        if ((failure === 'source-readdir' && path === source)
          || (failure === 'target-readdir' && path === target)) {
          throw Object.assign(new Error('injected readdir failure'), { code: 'EACCES' })
        }
        return fsp.readdir(path, { withFileTypes: true })
      }) as unknown as LegacyImportFs['readdir'],
      mkdir: (async (path: string) => {
        if (failure === 'target-mkdir' && path === target) throw new Error('injected mkdir failure')
        await fsp.mkdir(path, { recursive: true, mode: 0o700 })
      }) as unknown as LegacyImportFs['mkdir'],
      mkdtemp: (async (prefix: string) => {
        if (failure === 'staging-mkdtemp') throw new Error('injected mkdtemp failure')
        return fsp.mkdtemp(prefix)
      }) as unknown as LegacyImportFs['mkdtemp'],
    }

    const result = await importLegacyDshHome({ source, target: target as HarnessHome, fs })

    expect(result).toMatchObject({
      kind: 'failed',
      retained: [],
      source,
      target: target as HarnessHome,
    })
    expect(result.kind === 'failed' && typeof result.diagnosticId).toBe('string')
    expect(await allFiles(source)).toContain(join(source, 'sessions', 'one.jsonl'))
    expect(await allFiles(target)).toEqual([])
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
    await expect(detectLegacyImport(resolved)).resolves.toMatchObject({
      kind: 'imported',
      copied: [...ROOTS],
    })
    const stateText = await readFile(join(target, 'legacy-migration.json'), 'utf8')
    expect(stateText).not.toContain(SENTINEL)
    expect(stateText).not.toContain(source)
    await assertNoSentinel(target)
  })

  it('returns an imported state unchanged when acceptance is repeated', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const resolved = resolution(target, source)
    const imported = await recordLegacyImportDecision({ decision: 'accepted', resolution: resolved })
    await writeFile(join(target, 'later.txt'), 'must not trigger another import\n')

    await expect(recordLegacyImportDecision({ decision: 'accepted', resolution: resolved })).resolves.toEqual(imported)
    await expect(detectLegacyImport(resolved)).resolves.toEqual(imported)
  })

  it('keeps the previous complete state file when the atomic replacement fails', async () => {
    const source = await tempDir('dsh-legacy-import-source-')
    const target = await tempDir('dsh-legacy-import-target-')
    await seedLegacy(source)
    const stateFile = join(target, 'legacy-migration.json')
    const prior = JSON.stringify({ kind: 'imported', copied: [] }, null, 2) + '\n'
    await writeFile(stateFile, prior)
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('injected atomic replacement failure'))

    await expect(recordLegacyImportDecision({
      decision: 'declined',
      resolution: resolution(target, source),
    })).rejects.toThrow(/injected atomic replacement failure/)
    await expect(readFile(stateFile, 'utf8')).resolves.toBe(prior)
  })

  it('reports not-needed when no legacy home exists', async () => {
    const target = await tempDir('dsh-legacy-import-target-')
    await expect(detectLegacyImport(resolution(target, undefined))).resolves.toEqual({ kind: 'not-needed' })
  })
})
