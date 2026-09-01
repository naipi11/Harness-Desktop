/** Detached Windows standalone CLI replacement worker launch policy. */

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  scheduleWindowsStandaloneUpdate,
  windowsStandaloneWorkerScript,
  type WindowsStandaloneUpdateDependencies,
  type WindowsStandaloneUpdatePlan,
  type WindowsStandaloneWorkerChild,
} from '../src/windows-standalone-update.ts'

const windows = describe.runIf(process.platform === 'win32')

class FakeChild extends EventEmitter implements WindowsStandaloneWorkerChild {
  unrefCalls = 0
  killCalls = 0

  kill(): boolean { this.killCalls += 1; return true }
  unref(): this { this.unrefCalls += 1; return this }
}

const plan: WindowsStandaloneUpdatePlan = {
  schemaVersion: 2,
  parentProcess: {
    processId: 47,
    executablePath: 'C:\\Harness\\bundle\\runtime\\node.exe',
    startedBeforeMs: 1_700_000_000_000,
  },
  root: 'C:\\Harness\\bundle',
  candidate: 'C:\\Harness\\bundle.candidate-11111111-1111-4111-8111-111111111111',
  retained: 'C:\\Harness\\bundle.retained-22222222-2222-4222-8222-222222222222',
  failed: 'C:\\Harness\\bundle.failed-33333333-3333-4333-8333-333333333333',
  lockPath: 'C:\\Harness\\bundle.update.lock',
  lockToken: '55555555-5555-4555-8555-555555555555',
  healthCheckTimeoutMs: 120_000,
}

interface DependenciesFixture {
  readonly dependencies: WindowsStandaloneUpdateDependencies
  readonly files: Map<string, string>
  readonly calls: unknown[]
}

function dependenciesFixture(child: FakeChild, failSpawn = false, exitAfterReady = false): DependenciesFixture {
  const files = new Map<string, string>()
  const calls: unknown[] = []
  return {
    files,
    calls,
    dependencies: {
      writeFile: async (path, bytes) => { files.set(path, bytes) },
      readFile: async path => files.get(path),
      remove: async (path) => { files.delete(path) },
      delay: async () =>{  await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) },
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        queueMicrotask(() => {
          if (failSpawn) {
            child.emit('error', new Error('PowerShell launch failed'))
            return
          }
          const planPath = args.at(-1)
          const request = JSON.parse(files.get(planPath ?? '') ?? '{}') as { readonly workerId?: string; readonly readyPath?: string }
          if (request.workerId !== undefined && request.readyPath !== undefined) files.set(request.readyPath, `${request.workerId}\n`)
          child.emit('spawn')
          if (exitAfterReady) queueMicrotask(() => { child.emit('exit', 1, null) })
        })
        return child
      },
      powershellPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    },
  }
}

describe('scheduleWindowsStandaloneUpdate', () => {
  it('runs a fixed local PowerShell worker and writes no remote release input', async () => {
    const child = new FakeChild()
    const subject = dependenciesFixture(child)

    await scheduleWindowsStandaloneUpdate(plan, subject.dependencies)

    expect(subject.calls).toEqual([expect.objectContaining({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']) as unknown,
      options: expect.objectContaining({ detached: false }) as unknown,
    })])
    expect([...subject.files.values()].join('\n')).not.toContain('https://')
    expect(child.unrefCalls).toBe(1)
  })

  it('rejects an invalid sibling layout before it writes a worker file', async () => {
    const child = new FakeChild()
    const subject = dependenciesFixture(child)

    await expect(scheduleWindowsStandaloneUpdate({ ...plan, candidate: 'C:\\other\\candidate' }, subject.dependencies))
      .rejects.toThrow('plan is invalid')
    expect(subject.files).toEqual(new Map())
    expect(subject.calls).toEqual([])
  })

  it('rejects a transaction lock outside the exact installation sibling before worker files are written', async () => {
    const child = new FakeChild()
    const subject = dependenciesFixture(child)

    await expect(scheduleWindowsStandaloneUpdate({ ...plan, lockPath: 'C:\\other\\bundle.update.lock' }, subject.dependencies))
      .rejects.toThrow('plan is invalid')
    expect(subject.files).toEqual(new Map())
    expect(subject.calls).toEqual([])
  })

  it('removes both private worker files when the system worker cannot spawn', async () => {
    const child = new FakeChild()
    const subject = dependenciesFixture(child, true)

    await expect(scheduleWindowsStandaloneUpdate(plan, subject.dependencies)).rejects.toThrow('PowerShell launch failed')
    expect(subject.files).toEqual(new Map())
    expect(child.unrefCalls).toBe(0)
  })

  it('rejects a ready marker when the worker exits during the confirmation window', async () => {
    const child = new FakeChild()
    const subject = dependenciesFixture(child, false, true)

    await expect(scheduleWindowsStandaloneUpdate(plan, subject.dependencies))
      .rejects.toThrow('detached Windows update worker exited before readiness')
    expect(subject.files).toEqual(new Map())
    expect(child.killCalls).toBe(1)
  })
})

windows('windows standalone update worker', () => {
  it('rejects a worker request whose transaction lock token does not match before publishing the candidate', async () => {
    const subject = await externalWorker("console.log('Usage: harness')\n", false, 'different-owner\n')
    try {
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).rejects.toThrow('Windows standalone update worker exited with')
      await expect(readFile(join(subject.root, 'old.txt'), 'utf8')).resolves.toBe('stable')
      await expect(readFile(join(subject.root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('performs the ready handshake and replaces a verified local candidate only after its identified parent exits', async () => {
    const subject = await externalWorker("console.log('Usage: harness')\n")
    try {
      await subject.waitForReady()
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).resolves.toBe(0)
      await expect(readFile(join(subject.root, 'new.txt'), 'utf8')).resolves.toBe('candidate')
      await expect(readFile(join(subject.root, 'old.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(subject.retained, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await subject.assertPrivateFilesRemoved()
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('restores the retained standalone root when the candidate health process fails', async () => {
    const subject = await externalWorker('process.exitCode = 1\n')
    try {
      await subject.waitForReady()
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).resolves.toBe(0)
      await expect(readFile(join(subject.root, 'old.txt'), 'utf8')).resolves.toBe('stable')
      await expect(readFile(join(subject.root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(subject.retained, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await subject.assertPrivateFilesRemoved()
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('rejects leader-first health success and terminates the surviving descendant tree', async () => {
    const subject = await externalWorker([
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })",
      'child.unref()',
      "process.stdout.write('Usage: harness\\n')",
    ].join('\n'))
    try {
      await subject.waitForReady()
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).resolves.toBe(0)
      await expect(readFile(join(subject.root, 'old.txt'), 'utf8')).resolves.toBe('stable')
      await expect(readFile(join(subject.root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('restores the retained standalone root when the candidate health process throws', async () => {
    const subject = await externalWorker('', true)
    try {
      await subject.waitForReady()
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).resolves.toBe(0)
      await expect(readFile(join(subject.root, 'old.txt'), 'utf8')).resolves.toBe('stable')
      await expect(readFile(join(subject.root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(subject.retained, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await subject.assertPrivateFilesRemoved()
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('reports a failed rollback when the retained root cannot be restored', async () => {
    const subject = await externalWorker("require('node:fs').rmSync(__RETAINED__, { recursive: true, force: true }); process.exitCode = 1\n")
    try {
      await subject.waitForReady()
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).rejects.toThrow('Windows standalone update worker exited with')
      await subject.assertPrivateFilesRemoved()
    } finally {
      await subject.close()
    }
  }, 15_000)

  it('rejects a candidate junction before readiness and preserves the junction target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-cli-worker-outside-'))
    await writeFile(join(outside, 'sentinel'), 'preserved')
    const subject = await externalWorker("console.log('Usage: harness')\n", false, undefined, outside)
    try {
      await expect(workerExitCode(subject.worker, () => subject.workerDiagnostic())).rejects.toThrow('Windows standalone update worker exited with')
      await expect(readFile(join(outside, 'sentinel'), 'utf8')).resolves.toBe('preserved')
    } finally {
      await subject.close()
      await rm(outside, { recursive: true, force: true })
    }
  }, 15_000)
})

interface ExternalWorkerFixture {
  readonly root: string
  readonly retained: string
  readonly worker: ReturnType<typeof spawn>
  /** @returns diagnostic text emitted by the external PowerShell worker. */
  workerDiagnostic(): string
  /** @returns after the external worker proved readiness or reports its captured diagnostic. */
  waitForReady(): Promise<void>
  /** @returns after the worker removes the script, plan, and marker that it owned. */
  assertPrivateFilesRemoved(): Promise<void>
  /** @returns after test-owned subprocesses and the private fixture directory are released. */
  close(): Promise<void>
}

async function externalWorker(
  healthScript: string,
  invalidRuntime = false,
  lockContents?: string,
  candidateJunctionTarget?: string,
): Promise<ExternalWorkerFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-cli-worker-'))
  const root = join(directory, 'bundle')
  const candidate = `${root}.candidate-11111111-1111-4111-8111-111111111111`
  const retained = `${root}.retained-22222222-2222-4222-8222-222222222222`
  const failed = `${root}.failed-33333333-3333-4333-8333-333333333333`
  const workerId = '44444444-4444-4444-8444-444444444444'
  const scriptPath = `${root}.update-worker-${workerId}.ps1`
  const planPath = `${root}.update-worker-${workerId}.json`
  const readyPath = `${root}.update-worker-${workerId}.ready`
  const lockPath = `${root}.update.lock`
  const lockToken = '55555555-5555-4555-8555-555555555555'
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const parent = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 600'], {
    windowsHide: true,
    stdio: 'ignore',
  })

  let worker: ReturnType<typeof spawn> | undefined
  try {
    if (parent.pid === undefined) throw new Error('test parent did not expose a process identifier')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'old.txt'), 'stable')
    await mkdir(join(candidate, 'runtime'), { recursive: true })
    await mkdir(join(candidate, 'cli', 'package', 'lib'), { recursive: true })
    const candidateNode = join(candidate, 'runtime', 'node.exe')
    if (invalidRuntime) await writeFile(candidateNode, 'invalid executable')
    else await copyFile(process.execPath, candidateNode)
    await writeFile(join(candidate, 'cli', 'package', 'lib', 'bin.js'), healthScript.replaceAll('__RETAINED__', JSON.stringify(retained)))
    await writeFile(join(candidate, 'new.txt'), 'candidate')
    if (candidateJunctionTarget !== undefined) {
      await rm(candidate, { recursive: true, force: true })
      await symlink(candidateJunctionTarget, candidate, 'junction')
    }
    await writeFile(lockPath, lockContents ?? `${JSON.stringify({
      schemaVersion: 1,
      token: lockToken,
      processId: parent.pid,
      executablePath: powershell,
      startedBeforeMs: Date.now() + 10_000,
      expiresAtMs: Date.now() + 60_000,
    })}\n`, { flag: 'wx' })
    await writeFile(scriptPath, windowsStandaloneWorkerScript)
    await writeFile(planPath, `${JSON.stringify({
      schemaVersion: 1,
      workerId,
      readyPath,
      plan: {
        schemaVersion: 2,
        parentProcess: {
          processId: parent.pid,
          executablePath: powershell,
          startedBeforeMs: Date.now() + 10_000,
        },
        root,
        candidate,
        retained,
        failed,
        lockPath,
        lockToken,
        healthCheckTimeoutMs: 30_000,
      },
    })}\n`)
    worker = spawn(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-PlanPath',
      planPath,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    worker.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    return {
      root,
      retained,
      worker,
      workerDiagnostic: () => stderr,
      waitForReady: async () =>{  await waitForWorkerReady(readyPath, `${workerId}\n`).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}: ${stderr}`)
      }) },
      assertPrivateFilesRemoved: async () => {
        await waitForAbsent(readyPath)
        await waitForAbsent(planPath)
        await waitForAbsent(scriptPath)
        await waitForAbsent(lockPath)
      },
      close: async () => {
        worker?.kill()
        parent.kill()
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
      },
    }
  } catch (error) {
    worker?.kill()
    parent.kill()
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    throw error
  }
}

async function waitForWorkerReady(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await readFile(path, 'utf8').catch((error: unknown) => {
      if (isTransientReadError(error)) return undefined
      throw error
    })
    if (value === expected) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error('Windows standalone update worker did not write readiness marker')
}

async function waitForAbsent(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = await readFile(path, 'utf8').catch((error: unknown) => {
      if (isTransientReadError(error)) return undefined
      throw error
    })
    if (value === undefined) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error(`Windows standalone update worker did not clean ${path}`)
}

/** @returns whether Windows is still opening or deleting a private worker marker. */
function isTransientReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM'
}

function workerExitCode(child: ReturnType<typeof spawn>, diagnostic?: () => string): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(code)
      else reject(new Error(`Windows standalone update worker exited with ${String(code)}: ${diagnostic?.() ?? ''}`))
    })
  })
}
