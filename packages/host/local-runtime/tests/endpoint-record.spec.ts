import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import * as publicApi from '../src/index.ts'
import type { HarnessHome } from '../src/data-root.ts'
import {
  RUNTIME_ENDPOINT_FILENAME,
  readPrivateEndpointRecord,
  redactRuntimeStatus,
  removePrivateEndpointRecord,
  writePrivateEndpointRecord,
  type PrivateEndpointRecord,
} from '../src/endpoint-record.ts'
import type { PrivatePathPolicy } from '../src/instance-lock.ts'

const cleanups: Array<() => Promise<void>> = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

async function temporaryHome(): Promise<HarnessHome> {
  const home = await mkdtemp(join(tmpdir(), 'harness-runtime-endpoint-')) as HarnessHome
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return home
}

function endpoint(accessToken: string, port = 38123): PrivateEndpointRecord {
  return {
    protocolVersion: 1,
    runtimeId: 'runtime-1' as PrivateEndpointRecord['runtimeId'],
    port,
    process: { pid: 1234, startedAt: 'process-start' },
    accessToken,
  }
}

describe('private Runtime endpoint record', () => {
  it('keeps the old complete record visible until the private replacement is committed', async () => {
    const home = await temporaryHome()
    const path = join(home, RUNTIME_ENDPOINT_FILENAME)
    await writeFile(path, JSON.stringify(endpoint('old-token', 3000)) + '\n', { mode: 0o600 })
    let allowCommit!: () => void
    const commitAllowed = new Promise<void>((resolve) => { allowCommit = resolve })
    let temporaryProtected!: () => void
    const protectedTemporary = new Promise<void>((resolve) => { temporaryProtected = resolve })
    const policy: PrivatePathPolicy = {
      async protectDirectory() { return { kind: 'current-user-only', platform: 'test', mode: 0o700 } },
      async protectFile() {
        temporaryProtected()
        await commitAllowed
        return { kind: 'current-user-only', platform: 'test', mode: 0o600 }
      },
      async verifyFile() { return { kind: 'current-user-only', platform: 'test', mode: 0o600 } },
    }

    const replacement = writePrivateEndpointRecord(home, endpoint('new-token', 4000), { privatePathPolicy: policy })
    await protectedTemporary
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ port: 3000, accessToken: 'old-token' })
    allowCommit()
    await replacement
    expect(await readPrivateEndpointRecord(home, { privatePathPolicy: policy })).toEqual(endpoint('new-token', 4000))
  })

  it('protects the endpoint for the current user under the platform policy', async () => {
    const home = await temporaryHome()

    const evidence = await writePrivateEndpointRecord(home, endpoint('private-token'))

    expect(evidence.kind).toBe('current-user-only')
    if (process.platform === 'win32') {
      expect(evidence).toMatchObject({ platform: 'win32', verified: true })
    } else {
      expect((await stat(join(home, RUNTIME_ENDPOINT_FILENAME))).mode & 0o777).toBe(0o600)
      expect(evidence).toMatchObject({ platform: process.platform, mode: 0o600 })
    }
  })

  it('preserves a replacement published after retirement reads the old record', async () => {
    const home = await temporaryHome()
    const path = join(home, RUNTIME_ENDPOINT_FILENAME)
    const oldRecord = endpoint('old-private-token', 3000)
    const replacement = {
      ...endpoint('replacement-private-token', 4000),
      runtimeId: 'runtime-2' as PrivateEndpointRecord['runtimeId'],
    }
    await writePrivateEndpointRecord(home, oldRecord)
    const mutablePromises = fs.promises as typeof fs.promises & {
      rename: typeof fs.promises.rename
      rm: typeof fs.promises.rm
    }
    const originalRename = mutablePromises.rename.bind(mutablePromises)
    const originalRm = mutablePromises.rm.bind(mutablePromises)
    let retirementReached!: () => void
    let continueRetirement!: () => void
    const reached = new Promise<void>((resolve) => { retirementReached = resolve })
    const allowed = new Promise<void>((resolve) => { continueRetirement = resolve })
    let paused = false
    const pause = async () => {
      if (paused) return
      paused = true
      retirementReached()
      await allowed
    }
    mutablePromises.rename = async (source, target) => {
      if (String(source) === path) await pause()
      await originalRename(source, target)
    }
    mutablePromises.rm = async (target, options) => {
      if (String(target) === path) await pause()
      await originalRm(target, options)
    }
    syncBuiltinESMExports()

    try {
      const retirement = removePrivateEndpointRecord(home, oldRecord.runtimeId)
      await reached
      await writePrivateEndpointRecord(home, replacement)
      continueRetirement()
      await expect(retirement).rejects.toThrow('endpoint ownership changed before removal')
      expect(await readPrivateEndpointRecord(home)).toEqual(replacement)
      expect((await readdir(home)).filter(name => name.endsWith('.retiring'))).toEqual([])
    } finally {
      continueRetirement()
      mutablePromises.rename = originalRename
      mutablePromises.rm = originalRm
      syncBuiltinESMExports()
    }
  })

  it('removes its own endpoint without leaving a retirement tombstone', async () => {
    const home = await temporaryHome()
    const record = endpoint('retiring-private-token')
    await writePrivateEndpointRecord(home, record)

    await removePrivateEndpointRecord(home, record.runtimeId)

    await expect(readFile(join(home, RUNTIME_ENDPOINT_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(home)).filter(name => name.endsWith('.retiring'))).toEqual([])
  })

  it('rejects a broader-access endpoint before disclosing its token', async () => {
    const home = await temporaryHome()
    const path = join(home, RUNTIME_ENDPOINT_FILENAME)
    await writeFile(path, JSON.stringify(endpoint('must-remain-unread')) + '\n', { mode: 0o644 })

    await expect(readPrivateEndpointRecord(home)).rejects.toThrow(/current user|mode 600/)
  })

  it('exposes only redacted state through the application package API', () => {
    const record = endpoint('never-disclose-this-token')

    const status = redactRuntimeStatus(record, 'running', 2)

    expect(status).toEqual({
      state: 'running',
      runtimeId: 'runtime-1',
      port: 38123,
      backgroundLeaseCount: 2,
    })
    expect(JSON.stringify(status)).not.toContain(record.accessToken)
    expect(publicApi).not.toHaveProperty('readPrivateEndpointRecord')
    expect(publicApi).not.toHaveProperty('writePrivateEndpointRecord')
    expect(publicApi).not.toHaveProperty('RUNTIME_ENDPOINT_FILENAME')
  })

  it('denies application imports of the private endpoint module', async () => {
    const result = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('@harness-desktop/dsh-host-local-runtime/src/endpoint-record.ts')",
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
      .catch((error: unknown) => error as { stderr: string })

    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
    expect(result.stderr).not.toContain('accessToken')
  })
})
