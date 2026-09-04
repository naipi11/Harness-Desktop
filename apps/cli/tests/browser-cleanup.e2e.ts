/** Real IPC readiness and expiry coverage for the detached browser cleanup owner. */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserBootstrapDurableOwner } from '../src/browser.ts'

const helper = fileURLToPath(new URL('../browser-cleanup.mjs', import.meta.url))
const crashHelper = fileURLToPath(new URL('./fixtures/browser-cleanup-crash.mjs', import.meta.url))
const silentHelper = fileURLToPath(new URL('./fixtures/browser-cleanup-silent.mjs', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function bootstrapDocument(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-bootstrap-'))
  roots.push(root)
  const path = join(root, 'index.html')
  await writeFile(path, '<!doctype html>')
  return path
}

describe('browser cleanup durable owner', () => {
  it('acknowledges only after arming expiry and removes at that expiry', async () => {
    const documentPath = await bootstrapDocument()
    const expiresAt = Date.now() + 500
    const owner = createBrowserBootstrapDurableOwner({ helper, readyTimeoutMs: 2_000 })

    await owner.ownUntil(documentPath, expiresAt)
    await expect(access(documentPath)).resolves.toBeUndefined()
    const deadline = expiresAt + 2_000
    while (Date.now() < deadline) {
      try {
        await access(documentPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await expect(access(documentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing helper before ownership transfer', async () => {
    const owner = createBrowserBootstrapDurableOwner({ helper: `${helper}.missing`, readyTimeoutMs: 2_000 })
    await expect(owner.ownUntil(await bootstrapDocument(), Date.now() + 10_000))
      .rejects.toThrow('before ready')
  })

  it('rejects invalid cleanup arguments before readiness', async () => {
    const owner = createBrowserBootstrapDurableOwner({ helper, readyTimeoutMs: 2_000 })
    await expect(owner.ownUntil(join(tmpdir(), 'not-a-bootstrap.html'), Date.now() + 10_000))
      .rejects.toThrow('before ready')
  })

  it('rejects a crashing helper before ownership transfer', async () => {
    const owner = createBrowserBootstrapDurableOwner({ helper: crashHelper, readyTimeoutMs: 2_000 })
    await expect(owner.ownUntil(await bootstrapDocument(), Date.now() + 10_000))
      .rejects.toThrow('before ready')
  })

  it('bounds a helper that never acknowledges readiness', async () => {
    const owner = createBrowserBootstrapDurableOwner({ helper: silentHelper, readyTimeoutMs: 100 })
    await expect(owner.ownUntil(await bootstrapDocument(), Date.now() + 10_000))
      .rejects.toThrow('timed out before ready')
  })
})
