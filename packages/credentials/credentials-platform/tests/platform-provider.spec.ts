import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import { credentialRef } from '@harness-desktop/dsh-credentials'
import type { CredentialRef } from '@harness-desktop/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@harness-desktop/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@harness-desktop/dsh-launch-environment'
import {
  CREDENTIAL_REFERENCES_FILENAME,
  PlatformCredentialProvider,
  resolveSpec,
  type PlatformCredentialAdapter,
} from '../src/index.ts'

const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OPENAI_API_KEY')
/** Generated at test runtime so no secret-like literal is committed. */
const SECRET = `sk-test-do-not-log-${randomUUID()}`
/** Generated at test runtime so no secret-like literal is committed. */
const ENV_VALUE = `sk-env-value-${randomUUID()}`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-platform-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(
  config: ConstructorParameters<typeof PlatformCredentialProvider>[1],
  snapshot?: LaunchEnvironmentSnapshot,
): Promise<Context> {
  const ctx = new Context()
  if (snapshot !== undefined) ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, snapshot)
  const fiber = ctx.plugin(PlatformCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

function updates(ctx: Context): CredentialRef[] {
  const seen: CredentialRef[] = []
  ctx.on('credentials/updated', (ref) => { seen.push(ref) })
  return seen
}

/** In-memory writable adapter recording every mutation for assertions. */
function spyAdapter(): { adapter: PlatformCredentialAdapter; values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    adapter: {
      writable: true,
      async resolve(ref) {
        const value = values.get(ref)
        return value === undefined ? undefined : { value, source: 'platform' }
      },
      async set(ref, value) { values.set(ref, value) },
      async unset(ref) { values.delete(ref) },
    },
    values,
  }
}

describe('resolveSpec', () => {
  it('requires the harness home', async () => {
    expect(() => resolveSpec({})).toThrow(/harnessHome is required/)
  })

  it('resolves the metadata filename under the harness home', () => {
    const spec = resolveSpec({ harnessHome: '/custom/home' })
    expect(spec.metadataFilename).toBe(join('/custom/home', CREDENTIAL_REFERENCES_FILENAME))
  })
})

describe('platform provider', () => {
  it('persists only opaque reference metadata and delegates values to the adapter', async () => {
    const dir = await tempDir()
    const { adapter, values } = spyAdapter()
    const ctx = await boot({ harnessHome: dir, adapter })
    const seen = updates(ctx)

    await ctx.credentials.set(KEY, SECRET)

    expect(values.get(KEY)).toBe(SECRET)
    const metadata = JSON.parse(readFileSync(join(dir, CREDENTIAL_REFERENCES_FILENAME), 'utf8')) as {
      version: number
      references: string[]
    }
    expect(metadata.version).toBe(1)
    expect(metadata.references).toEqual([KEY])
    expect(readFileSync(join(dir, CREDENTIAL_REFERENCES_FILENAME), 'utf8')).not.toContain(SECRET)
    expect(seen).toEqual([KEY])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: SECRET, source: 'platform' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'platform', writable: true })
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, CREDENTIAL_REFERENCES_FILENAME)).mode & 0o777).toBe(0o600)
    }
  })

  it('removes the reference from metadata and the adapter on unset, with a silent absent no-op', async () => {
    const dir = await tempDir()
    const { adapter, values } = spyAdapter()
    const ctx = await boot({ harnessHome: dir, adapter })
    await ctx.credentials.set(KEY, SECRET)
    const seen = updates(ctx)

    await ctx.credentials.unset(KEY)

    expect(values.has(KEY)).toBe(false)
    const metadata = JSON.parse(readFileSync(join(dir, CREDENTIAL_REFERENCES_FILENAME), 'utf8')) as {
      references: string[]
    }
    expect(metadata.references).toEqual([])
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(seen).toEqual([KEY])

    await ctx.credentials.unset(OTHER)
    expect(seen).toEqual([KEY])
  })

  it('resolves and describes from the environment adapter without ever writing', async () => {
    const dir = await tempDir()
    const env = createLaunchEnvironmentSnapshot([{ source: 'process', values: { [KEY]: ENV_VALUE } }])
    const ctx = await boot({ harnessHome: dir }, env)

    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: ENV_VALUE, source: 'env' })
    expect(await ctx.credentials.describe(KEY)).toEqual({ configured: true, source: 'env', writable: false })
    await expect(ctx.credentials.set(KEY, SECRET)).rejects.toThrow(/environment adapter is read-only/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('rejects empty values before touching the adapter', async () => {
    const dir = await tempDir()
    const { adapter, values } = spyAdapter()
    const ctx = await boot({ harnessHome: dir, adapter })

    await expect(ctx.credentials.set(KEY, '')).rejects.toThrow(/empty value/)
    expect(values.size).toBe(0)
  })

  it('refuses a shadowed unset on a read-only adapter that currently resolves', async () => {
    const dir = await tempDir()
    const env = createLaunchEnvironmentSnapshot([{ source: 'process', values: { [KEY]: ENV_VALUE } }])
    const ctx = await boot({ harnessHome: dir }, env)

    await expect(ctx.credentials.unset(KEY)).rejects.toThrow(/read-only/)
  })
})

describe('package boundary', () => {
  it('publishes the invariant companion and bilingual READMEs with matching structure', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string
      exports: Record<string, { types: string; default: string }>
      files: string[]
    }
    expect(packageJson.name).toBe('@harness-desktop/dsh-credentials-platform')
    expect(packageJson.exports['./invariant']).toEqual({
      types: './lib/types/invariant.d.ts',
      default: './lib/invariant.js',
    })
    expect(packageJson.files).toContain('lib/invariant.js')

    const tsdown = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
    expect(tsdown).toContain('lib/types/invariant.js')

    for (const file of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').length).toBeGreaterThan(0)
    }
  })
})
