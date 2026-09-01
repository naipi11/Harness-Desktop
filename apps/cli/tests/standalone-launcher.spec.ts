/** Durable standalone launcher recovery across every payload rename phase. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverStandalonePayload } from '../src/standalone-launcher.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('recoverStandalonePayload', () => {
  it.each([
    { phase: 'prepared', current: '1.0.0', retained: undefined },
    { phase: 'retained', current: undefined, retained: '1.0.0' },
    { phase: 'candidate-published', current: '1.1.0', retained: '1.0.0' },
    { phase: 'rollback-started', current: undefined, retained: '1.0.0' },
  ] as const)('restores a launchable stable payload after $phase', async ({ phase, current, retained }) => {
    const root = await fixtureRoot()
    const candidate = join(root, '.harness-candidate-11111111-1111-4111-8111-111111111111')
    await Promise.all([
      current === undefined ? Promise.resolve() : version(join(root, 'payload', 'current'), current),
      retained === undefined ? Promise.resolve() : version(join(root, 'payload', 'retained'), retained),
      version(candidate, '1.1.0'),
      writeFile(join(root, '.harness-update.lock'), `${JSON.stringify({
        schemaVersion: 1,
        token: '11111111-1111-4111-8111-111111111111',
        processId: 2 ** 30,
        executablePath: process.execPath,
        startedBeforeMs: 1,
        expiresAtMs: Date.now() - 1,
      })}\n`),
      writeFile(join(root, '.harness-update.json'), `${JSON.stringify({ schemaVersion: 1, phase, candidate })}\n`),
    ])

    await recoverStandalonePayload(root)

    await expect(readFile(join(root, 'payload', 'current', 'version'), 'utf8')).resolves.toBe('1.0.0')
    await expect(readFile(join(root, '.harness-update.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.harness-update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a health-committed candidate and finishes retained cleanup', async () => {
    const root = await fixtureRoot()
    const candidate = join(root, '.harness-candidate-11111111-1111-4111-8111-111111111111')
    await Promise.all([
      version(join(root, 'payload', 'current'), '1.1.0'),
      version(join(root, 'payload', 'retained'), '1.0.0'),
      version(candidate, '1.1.0'),
      writeFile(join(root, '.harness-update.json'), `${JSON.stringify({ schemaVersion: 1, phase: 'committed', candidate })}\n`),
    ])

    await recoverStandalonePayload(root)

    await expect(readFile(join(root, 'payload', 'current', 'version'), 'utf8')).resolves.toBe('1.1.0')
    await expect(readFile(join(root, 'payload', 'retained', 'version'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a journal candidate path outside its exact archive sibling before removing anything', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    await writeFile(join(root, '.harness-update.json'), `${JSON.stringify({ schemaVersion: 1, phase: 'prepared', candidate: outside })}\n`)

    await expect(recoverStandalonePayload(root)).rejects.toThrow('journal is invalid')
    await expect(readFile(join(root, '.harness-update.json'), 'utf8')
      .then((text): unknown => JSON.parse(text) as unknown)).resolves.toMatchObject({ candidate: outside })
  })

  it('does not treat an unrelated live process with a reused lock pid as the transaction owner', async () => {
    const root = await fixtureRoot()
    await version(join(root, 'payload', 'current'), '1.0.0')
    await writeFile(join(root, '.harness-update.lock'), `${JSON.stringify({
      schemaVersion: 1,
      token: '11111111-1111-4111-8111-111111111111',
      processId: process.pid,
      executablePath: join(root, 'unrelated.exe'),
      startedBeforeMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    })}\n`)

    await expect(recoverStandalonePayload(root)).resolves.toBeUndefined()
    await expect(readFile(join(root, '.harness-update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not recover an expired durable transaction while its exact owner remains alive', async () => {
    const root = await fixtureRoot()
    const candidate = join(root, '.harness-candidate-11111111-1111-4111-8111-111111111111')
    const lock = join(root, '.harness-update.lock')
    const journal = join(root, '.harness-update.json')
    await Promise.all([
      version(join(root, 'payload', 'retained'), '1.0.0'),
      version(candidate, '1.1.0'),
      writeFile(lock, `${JSON.stringify({
        schemaVersion: 1,
        token: '11111111-1111-4111-8111-111111111111',
        processId: process.pid,
        executablePath: process.execPath,
        startedBeforeMs: Date.now(),
        expiresAtMs: Date.now() - 1,
      })}\n`),
      writeFile(journal, `${JSON.stringify({ schemaVersion: 1, phase: 'retained', candidate })}\n`),
    ])

    await expect(recoverStandalonePayload(root)).rejects.toThrow('still in progress')

    await expect(readFile(lock, 'utf8')).resolves.toContain('11111111-1111-4111-8111-111111111111')
    await expect(readFile(journal, 'utf8')).resolves.toContain('"retained"')
    await expect(readFile(join(root, 'payload', 'retained', 'version'), 'utf8')).resolves.toBe('1.0.0')
    await expect(readFile(join(root, 'payload', 'current', 'version'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'linux')('does not recover an expired lock after its POSIX owner moves into retained payload', async () => {
    const root = await fixtureRoot()
    const current = join(root, 'payload', 'current')
    const executablePath = join(current, 'runtime', 'node')
    const candidate = join(root, '.harness-candidate-11111111-1111-4111-8111-111111111111')
    const retained = join(root, 'payload', 'retained')
    await mkdir(dirname(executablePath), { recursive: true })
    await copyFile(process.execPath, executablePath)
    await chmod(executablePath, 0o755)
    const owner = spawn(executablePath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await once(owner, 'spawn')
      const ownerProcessId = owner.pid
      if (ownerProcessId === undefined) throw new Error('fixture owner did not expose a process id')
      await Promise.all([
        rename(current, retained),
        version(candidate, '1.1.0'),
      ])
      await Promise.all([
        writeFile(join(root, '.harness-update.lock'), `${JSON.stringify({
          schemaVersion: 1,
          token: '11111111-1111-4111-8111-111111111111',
          processId: ownerProcessId,
          executablePath,
          startedBeforeMs: Date.now(),
          expiresAtMs: Date.now() - 1,
        })}\n`),
        writeFile(join(root, '.harness-update.json'), `${JSON.stringify({ schemaVersion: 1, phase: 'retained', candidate })}\n`),
      ])

      await expect(recoverStandalonePayload(root)).rejects.toThrow('still in progress')
      await expect(readFile(join(retained, 'version'), 'utf8')).resolves.toBe('1.0.0')
    } finally {
      owner.kill()
      await once(owner, 'exit').catch(() => undefined)
    }
  })

  it('fails closed on a malformed orphan lock instead of deleting it and launching', async () => {
    const root = await fixtureRoot()
    const lock = join(root, '.harness-update.lock')
    await writeFile(lock, 'malformed')

    await expect(recoverStandalonePayload(root)).rejects.toThrow('lock is invalid')
    await expect(readFile(lock, 'utf8')).resolves.toBe('malformed')
  })

  it('restores deterministic retained payload when a durable stale lock survives without a journal', async () => {
    const root = await fixtureRoot()
    await version(join(root, 'payload', 'retained'), '1.0.0')
    await writeFile(join(root, '.harness-update.lock'), `${JSON.stringify({
      schemaVersion: 1,
      token: '11111111-1111-4111-8111-111111111111',
      processId: 2 ** 30,
      executablePath: process.execPath,
      startedBeforeMs: 1,
      expiresAtMs: Date.now() - 1,
    })}\n`)

    await recoverStandalonePayload(root)

    await expect(readFile(join(root, 'payload', 'current', 'version'), 'utf8')).resolves.toBe('1.0.0')
    await expect(readFile(join(root, '.harness-update.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when stale lock topology has no fixed launchable or retained payload', async () => {
    const root = await fixtureRoot()
    const lock = join(root, '.harness-update.lock')
    await writeFile(lock, `${JSON.stringify({
      schemaVersion: 1,
      token: '11111111-1111-4111-8111-111111111111',
      processId: 2 ** 30,
      executablePath: process.execPath,
      startedBeforeMs: 1,
      expiresAtMs: Date.now() - 1,
    })}\n`)

    await expect(recoverStandalonePayload(root)).rejects.toThrow('topology is ambiguous')
    await expect(readFile(lock, 'utf8')).resolves.toContain('11111111-1111-4111-8111-111111111111')
  })

  it('rejects a candidate junction before recursive cleanup and preserves its target', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    const candidate = join(root, '.harness-candidate-11111111-1111-4111-8111-111111111111')
    await version(join(root, 'payload', 'current'), '1.0.0')
    await writeFile(join(outside, 'sentinel'), 'preserved')
    await symlink(outside, candidate, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(root, '.harness-update.json'), `${JSON.stringify({ schemaVersion: 1, phase: 'prepared', candidate })}\n`)

    await expect(recoverStandalonePayload(root)).rejects.toThrow('not a private directory')
    await expect(readFile(join(outside, 'sentinel'), 'utf8')).resolves.toBe('preserved')
  })

  it('rejects a junction-shaped current payload before an ordinary no-journal launch', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    await version(outside, 'untrusted')
    await mkdir(join(root, 'payload'), { recursive: true })
    await symlink(outside, join(root, 'payload', 'current'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(recoverStandalonePayload(root)).rejects.toThrow('not a private directory')
    await expect(readFile(join(outside, 'version'), 'utf8')).resolves.toBe('untrusted')
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-standalone-launcher-'))
  roots.push(root)
  return root
}

async function version(root: string, value: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'version'), value)
}
