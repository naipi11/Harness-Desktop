import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessHome } from '../src/data-root.ts'
import { acquireRuntimeLock as acquirePublicRuntimeLock } from '../src/index.ts'
import {
  RUNTIME_LOCK_FILENAME,
  acquireRuntimeLockWithDependencies as acquireRuntimeLock,
  type PrivatePathPolicy,
} from '../src/instance-lock.ts'
import type { ProcessIdentityProbe } from '../src/process-identity.ts'

const fixture = fileURLToPath(new URL('./fixtures/runtime-owner.ts', import.meta.url))
const contenderFixture = fileURLToPath(new URL('./fixtures/runtime-contender.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

async function temporaryHome(): Promise<HarnessHome> {
  const home = await mkdtemp(join(tmpdir(), 'harness-runtime-lock-')) as HarnessHome
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return home
}

async function startOwner(home: HarnessHome): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture], {
    env: { ...process.env, HARNESS_HOME: home, DSH_HOME: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill()
  })
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('READY\n')) resolve()
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('exit', (code) => { reject(new Error(`owner exited before readiness (${code}): ${stderr}`)) })
  })
  return child
}

interface RecoveryContender {
  readonly child: ChildProcessWithoutNullStreams
  send(command: 'RELEASE' | 'RENAME'): void
  waitFor(prefix: string, timeoutMs?: number): Promise<string>
}

function startRecoveryContender(home: HarnessHome, label: string): RecoveryContender {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', contenderFixture], {
    env: {
      ...process.env,
      HARNESS_HOME: home,
      DSH_HOME: undefined,
      HARNESS_RUNTIME_CONTENDER_LABEL: label,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  const lines: string[] = []
  const waiters = new Set<() => void>()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const output = createInterface({ input: child.stdout })
  output.on('line', (line) => {
    lines.push(line)
    for (const wake of waiters) wake()
  })
  cleanups.push(async () => {
    output.close()
    if (child.exitCode === null) {
      child.kill()
      await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    }
  })
  return {
    child,
    send(command) { child.stdin.write(`${command}\n`) },
    async waitFor(prefix, timeoutMs = 5_000) {
      const existing = lines.find(line => line.startsWith(prefix))
      if (existing !== undefined) return existing
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(wake)
          reject(new Error(`${label} did not emit ${prefix}; stderr: ${stderr}`))
        }, timeoutMs)
        const wake = () => {
          const line = lines.find(candidate => candidate.startsWith(prefix))
          if (line === undefined) return
          clearTimeout(timeout)
          waiters.delete(wake)
          resolve(line)
        }
        waiters.add(wake)
        child.once('exit', (code) => {
          clearTimeout(timeout)
          waiters.delete(wake)
          reject(new Error(`${label} exited ${code} before ${prefix}; stderr: ${stderr}`))
        })
      })
    },
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { setTimeout(resolve, timeoutMs) }),
  ])
}

const acceptingPolicy: PrivatePathPolicy = {
  async protectDirectory() { return { kind: 'current-user-only', platform: 'test', mode: 0o700 } },
  async protectFile() { return { kind: 'current-user-only', platform: 'test', mode: 0o600 } },
  async verifyFile() { return { kind: 'current-user-only', platform: 'test', mode: 0o600 } },
}

describe('Runtime instance ownership', () => {
  it('keeps a live owner when another process acquires the same Harness home', async () => {
    const home = await temporaryHome()
    const child = await startOwner(home)

    const contender = await acquireRuntimeLock(home)

    expect(contender).toMatchObject({ kind: 'owned-by-live-runtime' })
    child.stdin.write('release\n')
    await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  })

  it('does not let an application inject a probe that displaces a live owner', async () => {
    const home = await temporaryHome()
    await startOwner(home)
    const callWithUntrustedOptions = acquirePublicRuntimeLock as unknown as (
      target: HarnessHome,
      options: Record<string, unknown>,
    ) => ReturnType<typeof acquirePublicRuntimeLock>

    const contender = await callWithUntrustedOptions(home, {
      identity: { pid: 99, startedAt: 'forged' },
      processProbe: { async probe() { return { kind: 'dead' } } },
      privatePathPolicy: acceptingPolicy,
    })

    expect(contender).toMatchObject({ kind: 'owned-by-live-runtime' })
  })

  it('recovers a lock when the PID exists but its process-start identity differs', async () => {
    const home = await temporaryHome()
    const lockPath = join(home, RUNTIME_LOCK_FILENAME)
    await writeFile(lockPath, JSON.stringify({ pid: 4242, startedAt: 'old-start' }) + '\n', { mode: 0o600 })
    const probe: ProcessIdentityProbe = {
      async probe(pid) {
        expect(pid).toBe(4242)
        return { kind: 'running', startedAt: 'new-start' }
      },
    }

    const result = await acquireRuntimeLock(home, {
      identity: { pid: 99, startedAt: 'current-start' },
      processProbe: probe,
      privatePathPolicy: acceptingPolicy,
    })

    expect(result).toMatchObject({ kind: 'acquired', recoveredStaleOwner: true })
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({ pid: 99, startedAt: 'current-start' })
    if (result.kind === 'acquired') await result.lock.release()
  })

  it('serializes two processes recovering the same stale owner', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, RUNTIME_LOCK_FILENAME), JSON.stringify({ pid: 4242, startedAt: 'stale' }) + '\n', { mode: 0o600 })
    const contenders = [startRecoveryContender(home, 'a'), startRecoveryContender(home, 'b')]
    const ready = contenders.map(contender => contender.waitFor('RENAME_READY'))
    const firstReady = await Promise.race(ready.map((promise, index) => promise.then(() => index)))
    const otherIndex = firstReady === 0 ? 1 : 0
    const secondReady = await settlesWithin(ready[otherIndex] as Promise<string>, 500)

    if (secondReady !== undefined) {
      contenders[firstReady]?.send('RENAME')
      await contenders[firstReady]?.waitFor('RESULT')
      contenders[otherIndex]?.send('RENAME')
    } else {
      contenders[firstReady]?.send('RENAME')
    }

    const results = await Promise.all(contenders.map(contender => contender.waitFor('RESULT')))
    expect(results.map(line => line.split(' ').at(-1)).sort()).toEqual(['acquired', 'owned-by-live-runtime'])
    for (const [index, result] of results.entries()) {
      if (result.endsWith(' acquired')) contenders[index]?.send('RELEASE')
    }
  })

  it('preserves an owner lock when the process probe cannot prove it dead', async () => {
    const home = await temporaryHome()
    const lockPath = join(home, RUNTIME_LOCK_FILENAME)
    const existing = JSON.stringify({ pid: 4242, startedAt: 'recorded-start' }) + '\n'
    await writeFile(lockPath, existing, { mode: 0o600 })
    const probe: ProcessIdentityProbe = { async probe() { return { kind: 'unknown' } } }

    const result = await acquireRuntimeLock(home, {
      identity: { pid: 99, startedAt: 'current-start' },
      processProbe: probe,
      privatePathPolicy: acceptingPolicy,
    })

    expect(result).toEqual({ kind: 'ownership-unverified' })
    expect(await readFile(lockPath, 'utf8')).toBe(existing)
  })

  it('removes its exclusive lock when private-file protection fails', async () => {
    const home = await temporaryHome()
    const failingPolicy: PrivatePathPolicy = {
      ...acceptingPolicy,
      async protectFile() { throw new Error('private policy rejected lock') },
    }

    await expect(acquireRuntimeLock(home, {
      identity: { pid: 99, startedAt: 'current-start' },
      privatePathPolicy: failingPolicy,
    })).rejects.toThrow('private policy rejected lock')

    await expect(readFile(join(home, RUNTIME_LOCK_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = await acquireRuntimeLock(home, {
      identity: { pid: 99, startedAt: 'current-start' },
      privatePathPolicy: acceptingPolicy,
    })
    expect(retry).toMatchObject({ kind: 'acquired' })
    if (retry.kind === 'acquired') await retry.lock.release()
  })
})
