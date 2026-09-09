/** Disposable OS credential test; never enumerates or reads user entries. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import { credentialRef } from '@harness-desktop/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@harness-desktop/dsh-launch-environment'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PlatformCredentialProvider from '../src/index.ts'

let home: string | undefined
const instances: Context[] = []
const key = credentialRef(`HARNESS_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`)
afterEach(async () => {
  for (const ctx of instances.reverse()) {
    try { await ctx.credentials.unset(key) } finally { await ctx.fiber.dispose() }
  }
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})
async function boot() {
  if (home === undefined) throw new Error('Missing test home')
  const ctx = new Context()
  instances.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { [key]: 'test-environment-fallback' } }]))
  await ctx.plugin(PlatformCredentialProvider, { harnessHome: home })
  return ctx
}

it.skipIf(process.platform !== 'win32')('allows manual replacement across provider restart, then restores the environment fallback', async () => {
  home = await mkdtemp(join(tmpdir(), 'harness-vault-test-'))
  const first = await boot()
  expect(await first.credentials.describe(key)).toEqual({ configured: true, source: 'env', writable: true })
  const original = `synthetic-中文-${randomUUID()}`
  await first.credentials.set(key, original)
  await first.fiber.dispose()
  instances.splice(instances.indexOf(first), 1)
  const second = await boot()
  expect((await second.credentials.resolve(key))?.value === original).toBe(true)
  expect(await second.credentials.describe(key)).toEqual({ configured: true, source: 'platform', writable: true })
  const replacement = `replacement-${randomUUID()}`
  await second.credentials.set(key, replacement)
  expect((await second.credentials.resolve(key))?.value === replacement).toBe(true)
  const metadata = await readFile(join(home, '.credential-references.json'), 'utf8')
  expect(metadata.includes(original) || metadata.includes(replacement)).toBe(false)
  await expect(second.credentials.set(key, 'x'.repeat(2561))).rejects.toThrow('too large')
  expect((await second.credentials.resolve(key))?.value === replacement).toBe(true)
  await second.credentials.unset(key)
  expect((await second.credentials.resolve(key))?.value === 'test-environment-fallback').toBe(true)
})
