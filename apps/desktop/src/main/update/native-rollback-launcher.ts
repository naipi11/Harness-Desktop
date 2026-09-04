/** Main-owned detached launch of a local native rollback worker. */

import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { createNativeRollbackWorkerRequest, type NativeRollbackWorkerRequest } from './native-rollback-request.ts'
import {
  type NativeRollbackPlan,
  type NativeRollbackWorkerFailurePhase,
  type NativeUpdateWatchPlan,
} from './native-rollback.ts'

const workerReadyPollMs = 25
const diagnosticsEnvironmentKey = 'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS'
const testLibraryPathEnvironmentKey = 'DSH_TEST_ELECTRON_LD_LIBRARY_PATH'
const windowsBridgeRequestEnvironmentKey = 'DSH_NATIVE_WMI_LAUNCH'
const windowsBridgeOutputLimit = 1024
const windowsEnvironmentBlockLimit = 16 * 1024
const windowsCreateFlags = 0x0100_0408
const supervisorNamePattern = /^native-update-supervisor-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.exe$/iu
const execFileAsync = promisify(execFile)

type NativeUpdateDiagnosticStage =
  | 'prepare'
  | 'bridge-create'
  | 'bridge-identity'
  | 'readiness-image'
  | 'readiness-marker'
  | 'cancellation-proof'

interface NativeUpdateStageRecorder {
  (stage: NativeUpdateDiagnosticStage): void
  flush(): Promise<void>
}

/** Child-process surface required to launch, observe, and release a detached worker. */
export interface NativeRollbackWorkerChild {
  /** @param event - one worker lifecycle event. @param listener - event callback. @returns emitter ownership. */
  once(event: 'spawn', listener: () => void): unknown
  /** @param event - one worker lifecycle event. @param listener - event callback. @returns emitter ownership. */
  once(event: 'error', listener: (error: Error) => void): unknown
  /** @param event - one worker lifecycle event. @param listener - event callback. @returns emitter ownership. */
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Stop a worker that did not become ready before its policy-selected deadline. */
  kill(): boolean
  /** Release the detached worker from the parent event loop. */
  unref(): void
}

/** Injectable detached worker process launcher. */
export type NativeRollbackWorkerSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly detached: boolean; readonly stdio: 'ignore'; readonly windowsHide: true; readonly env: NodeJS.ProcessEnv },
) => NativeRollbackWorkerChild

/** Short-lived system PowerShell invocation used only to call the local WMI process provider. */
export type NativeRollbackWindowsBridge = (
  executable: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly maxBuffer: number
    readonly timeout: number
    readonly windowsHide: true
  },
) => Promise<{ readonly stdout: string; readonly stderr: string }>

/** Private filesystem and process operations behind one deterministic worker launch. */
export interface NativeRollbackWorkerDependencies {
  /** @param path - packaged Windows resource. @returns immutable resource bytes before private copying. */
  readResource(path: string): Promise<Uint8Array>
  /** @param path - private worker directory. @returns settlement once the directory exists. */
  mkdir(path: string): Promise<void>
  /** @param path - private worker or plan file. @param bytes - exact local bytes. @returns settlement after exclusive creation. */
  writePrivate(path: string, bytes: Uint8Array | string): Promise<void>
  /** @param path - private worker-owned file. @returns text, or undefined only when it is absent. */
  readPrivate(path: string): Promise<string | undefined>
  /** @param path - private directory. @returns direct entry names only. */
  listPrivate(path: string): Promise<readonly string[]>
  /** @param path - exact private entry. @returns non-following entry classification. */
  lstatPrivate(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  /** @param path - existing path. @returns canonical path after resolving links. */
  canonicalize(path: string): Promise<string>
  /**
   * @param path - canonical executable path.
   * @param timeoutMs - optional local inspection bound.
   * @returns whether one live image equals it.
   */
  isExactProcessImageRunning(path: string, timeoutMs?: number): Promise<boolean>
  /** @param path - exact private temporary file or link. @returns settlement when absent or removed. */
  remove(path: string): Promise<void>
  /** @param milliseconds - bounded readiness poll delay. @returns fulfillment after the delay. */
  delay(milliseconds: number): Promise<void>
  /** @returns current monotonic milliseconds for launch and readiness deadlines. */
  now?(): number
  /** @returns constrained Windows supervisor environment before serialization. */
  createWindowsWorkerEnvironment?(): NodeJS.ProcessEnv
  /** Invoke the bounded local WMI launch bridge. */
  runWindowsBridge?: NativeRollbackWindowsBridge
  /** Start a detached worker process. */
  spawn: NativeRollbackWorkerSpawn
}

/** Inputs for one worker launch after all release bytes have already been authenticated locally. */
export interface NativeRollbackWorkerLaunchOptions {
  /** Runtime platform selecting the external Windows helper or Electron-as-Node worker. */
  readonly platform: NodeJS.Platform
  /** Electron executable that can run the packaged non-Windows Main worker in Node mode. */
  readonly executablePath: string
  /** Bundled non-Windows worker entry below the packaged Main output directory. */
  readonly workerPath: string
  /** Packaged Windows PowerShell worker copied outside the NSIS installation directory before launch. */
  readonly windowsWorkerTemplatePath: string
  /** Packaged native Windows supervisor copied beside the private worker before launch. */
  readonly windowsSupervisorTemplatePath: string
  /** Fixed local rollback or watchdog request; it never contains a release URL. */
  readonly plan: NativeRollbackPlan | NativeUpdateWatchPlan
  /** Policy-selected upper bound for local artifact snapshotting before Main exits. */
  readonly workerReadyTimeoutMs: number
  /** Main-owned durable handoff performed after this worker proves readiness and before it is detached. */
  readonly afterReady?: () => Promise<void>
  /** Fixed external worker identity when a watchdog must confirm a recovery worker is ready. */
  readonly workerId?: string
  /** Injectable operations used by focused process-launch tests. */
  readonly dependencies?: NativeRollbackWorkerDependencies
}

/** Receipt proving that one detached worker loaded its verified local operation before Main continues. */
export interface NativeRollbackWorkerReceipt {
  /** Unique worker identity written into the cache-local readiness marker. */
  readonly workerId: string
  /** Exact ready marker confirmed by Main before the native installation transition begins. */
  readonly readyPath: string
}

interface WorkerTerminal {
  error: Error | undefined
  exited: boolean
  exitCode: number | null | undefined
}

interface ChildWorkerLaunch {
  readonly kind: 'child'
  readonly child: NativeRollbackWorkerChild
  readonly terminal: WorkerTerminal
}

interface WindowsWorkerLaunch {
  readonly kind: 'windows'
  readonly supervisorPath: string
  readonly privateWorkerDirectory: string
  readonly scriptPath: string
  readonly planPath: string
  readonly readinessDeadline: number
  readonly recordStage: NativeUpdateStageRecorder
  readonly flushStages: () => Promise<void>
}

type WorkerLaunch = ChildWorkerLaunch | WindowsWorkerLaunch

/**
 * Launch a detached native rollback worker and wait for its local verified readiness marker.
 * @param options - packaged worker source, local operation, and platform-specific process path.
 * @returns receipt only after the worker validated its plan, journal, and rollback artifact.
 */
export async function launchNativeRollbackWorker(options: NativeRollbackWorkerLaunchOptions): Promise<NativeRollbackWorkerReceipt> {
  const dependencies = options.dependencies ?? nativeDependencies
  const workerId = options.workerId ?? randomUUID()
  const paths = nativeRollbackWorkerPaths(options.plan, workerId, options.plan.platform)
  const request = { ...createNativeRollbackWorkerRequest(options.plan, workerId), readyPath: paths.readyPath }
  const failurePath = paths.failurePath
  const workerDirectory = paths.workerDirectory
  await dependencies.mkdir(workerDirectory)
  const launch = options.platform === 'win32'
    ? await launchWindowsWorker(options, request, dependencies, workerDirectory)
    : await launchElectronWorker(options, request, dependencies)
  try {
    await awaitWorkerReady(
      launch.kind === 'child' ? launch.terminal : undefined,
      launch.kind === 'windows' ? launch.supervisorPath : undefined,
      request,
      failurePath,
      launch.kind === 'windows'
        ? launch.readinessDeadline
        : monotonicNow(dependencies) + options.workerReadyTimeoutMs,
      dependencies,
      launch.kind === 'windows' ? launch.recordStage : undefined,
    )
    await options.afterReady?.()
    if (launch.kind === 'child') launch.child.unref()
    return { workerId, readyPath: request.readyPath }
  } catch (error) {
    if (launch.kind === 'windows') {
      await launch.flushStages()
      try {
        const proof = await requestWindowsCancellation(
          options, request, launch.supervisorPath, dependencies, launch.recordStage,
        )
        await cleanupWindowsPrivateInputs(
          launch.privateWorkerDirectory,
          launch.supervisorPath,
          launch.scriptPath,
          launch.planPath,
          request,
          proof,
          dependencies,
        )
      } catch (proofError) {
        throw new Error((error as Error).message, { cause: proofError })
      }
    } else if (!launch.terminal.exited) {
      try {
        if (!launch.child.kill()) throw new Error('native Desktop rollback worker could not be terminated')
        await awaitWorkerExit(launch.terminal, options.workerReadyTimeoutMs, dependencies)
      } catch (cleanupError) {
        throw new Error((error as Error).message, { cause: cleanupError })
      }
    }
    throw error
  }
}

async function launchWindowsWorker(
  options: NativeRollbackWorkerLaunchOptions,
  request: NativeRollbackWorkerRequest,
  dependencies: NativeRollbackWorkerDependencies,
  workerDirectory: string,
): Promise<WindowsWorkerLaunch> {
  const privateWorkerDirectory = await validatePrivateWorkerDirectory(workerDirectory, dependencies)
  await retireStaleSupervisors(privateWorkerDirectory, dependencies)
  const supervisorPath = win32.join(privateWorkerDirectory, `native-update-supervisor-${request.workerId}.exe`)
  const scriptPath = win32.join(privateWorkerDirectory, `native-rollback-worker-${request.workerId}.ps1`)
  const planPath = win32.join(privateWorkerDirectory, `native-rollback-plan-${request.workerId}.json`)
  const workerEnvironment = dependencies.createWindowsWorkerEnvironment?.() ?? createWindowsWorkerEnvironment()
  const recordStage = createNativeUpdateStageRecorder(
    privateWorkerDirectory, request.workerId, workerEnvironment, dependencies,
  )
  validatePrivateSiblingPaths(privateWorkerDirectory, [
    supervisorPath,
    scriptPath,
    planPath,
  ])
  validateWindowsLaunchInputs(
    supervisorPath, scriptPath, planPath, privateWorkerDirectory, options.workerReadyTimeoutMs,
  )
  const readinessDeadline = monotonicNow(dependencies) + options.workerReadyTimeoutMs
  let launchAttempted = false
  try {
    recordStage('prepare')
    await dependencies.writePrivate(supervisorPath, await dependencies.readResource(options.windowsSupervisorTemplatePath))
    await dependencies.writePrivate(scriptPath, await dependencies.readResource(options.windowsWorkerTemplatePath))
    await dependencies.writePrivate(planPath, `${JSON.stringify(request)}\n`)
    launchAttempted = true
    recordStage('bridge-create')
    await runWindowsSupervisorBridge(
      supervisorPath,
      scriptPath,
      planPath,
      privateWorkerDirectory,
      options.workerReadyTimeoutMs,
      workerEnvironment,
      readinessDeadline,
      dependencies,
      recordStage,
    )
    return {
      kind: 'windows',
      supervisorPath,
      privateWorkerDirectory,
      scriptPath,
      planPath,
      readinessDeadline,
      recordStage,
      flushStages: () => recordStage.flush(),
    }
  } catch (error) {
    await recordStage.flush()
    if (launchAttempted) {
      try {
        const proof = await requestWindowsCancellation(options, request, supervisorPath, dependencies, recordStage)
        await cleanupWindowsPrivateInputs(
          privateWorkerDirectory, supervisorPath, scriptPath, planPath, request, proof, dependencies,
        )
      } catch (cleanupError) {
        throw new Error((error as Error).message, { cause: cleanupError })
      }
      throw error
    }
    await Promise.allSettled([
      dependencies.remove(supervisorPath),
      dependencies.remove(scriptPath),
      dependencies.remove(planPath),
    ])
    throw error
  }
}

async function cleanupWindowsPrivateInputs(
  workerDirectory: string,
  supervisorPath: string,
  scriptPath: string,
  planPath: string,
  request: NativeRollbackWorkerRequest,
  proof: WindowsCancellationProof,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<void> {
  const cancelPath = win32.join(workerDirectory, `native-update-cancel-${request.workerId}.req`)
  const drainedPath = win32.join(workerDirectory, `native-update-drained-${request.workerId}.ack`)
  for (const path of [
    supervisorPath,
    scriptPath,
    planPath,
    request.readyPath,
    win32.join(workerDirectory, `native-rollback-failure-${request.workerId}.json`),
    win32.join(workerDirectory, `native-rollback-installer-${request.workerId}.exe`),
    win32.join(workerDirectory, `native-candidate-installer-${request.workerId}.exe`),
    cancelPath,
  ]) {
    await assertWindowsCancellationProof(proof, dependencies)
    await dependencies.remove(path)
  }
  await assertWindowsCancellationProof(proof, dependencies)
  await dependencies.remove(drainedPath)
}

async function validatePrivateWorkerDirectory(
  workerDirectory: string,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<string> {
  const metadata = await dependencies.lstatPrivate(workerDirectory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('native Desktop rollback worker directory is not a real directory')
  const canonicalRoot = await dependencies.canonicalize(win32.dirname(workerDirectory))
  const canonicalWorkers = await dependencies.canonicalize(workerDirectory)
  if (normalizeWindowsCanonicalPath(canonicalWorkers) !== normalizeWindowsCanonicalPath(win32.join(canonicalRoot, 'workers'))) {
    throw new Error('native Desktop rollback worker directory escaped its private update root')
  }
  return canonicalWorkers
}

function normalizeWindowsCanonicalPath(path: string): string {
  return win32.resolve(path.replace(/^\\\\\?\\/u, '')).replace(/[\\/]+$/u, '').toLowerCase()
}

function validatePrivateSiblingPaths(workerDirectory: string, paths: readonly string[]): void {
  const expectedParent = win32.resolve(workerDirectory).toLowerCase()
  if (paths.some(path => win32.resolve(win32.dirname(path)).toLowerCase() !== expectedParent)) {
    throw new Error('native Desktop rollback worker input escaped its private worker directory')
  }
}

function nativeRollbackWorkerPaths(
  plan: NativeRollbackPlan | NativeUpdateWatchPlan,
  workerId: string,
  platform: NativeRollbackPlan['platform'],
): { readonly workerDirectory: string; readonly readyPath: string; readonly failurePath: string } {
  const path = platform === 'win32' ? win32 : posix
  const workerDirectory = path.join(path.dirname(path.dirname(plan.rollbackArtifactPath)), 'workers')
  return {
    workerDirectory,
    readyPath: path.join(workerDirectory, `native-rollback-ready-${workerId}.json`),
    failurePath: path.join(workerDirectory, `native-rollback-failure-${workerId}.json`),
  }
}

async function retireStaleSupervisors(
  workerDirectory: string,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<void> {
  for (const name of await dependencies.listPrivate(workerDirectory)) {
    if (!supervisorNamePattern.test(name)) continue
    const path = win32.join(workerDirectory, name)
    const metadata = await dependencies.lstatPrivate(path)
    if (metadata.isSymbolicLink()) {
      await dependencies.remove(path)
      continue
    }
    if (!metadata.isFile()) continue
    const canonicalPath = await dependencies.canonicalize(path)
    if (await dependencies.isExactProcessImageRunning(canonicalPath)) continue
    try {
      await dependencies.remove(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw error
    }
  }
}

async function launchElectronWorker(
  options: NativeRollbackWorkerLaunchOptions,
  request: NativeRollbackWorkerRequest,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<WorkerLaunch> {
  const child = dependencies.spawn(options.executablePath, [options.workerPath, JSON.stringify(request)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: createElectronWorkerEnvironment(),
  })
  const terminal = observeWorker(child)
  await awaitSpawn(child)
  return { kind: 'child', child, terminal }
}

async function awaitWorkerReady(
  terminal: WorkerTerminal | undefined,
  supervisorPath: string | undefined,
  request: NativeRollbackWorkerRequest,
  failurePath: string,
  deadline: number,
  dependencies: NativeRollbackWorkerDependencies,
  recordStage?: NativeUpdateStageRecorder,
): Promise<void> {
  const throwTerminalError = async (): Promise<void> => {
    if (terminal?.error === undefined) return
    const failure = await readWorkerFailure(failurePath, request.workerId, request.plan.platform, dependencies)
    if (failure !== undefined) throw new Error(`native Desktop rollback worker failed during ${failure}`)
    throw terminal.error
  }
  while (monotonicNow(dependencies) < deadline) {
    await throwTerminalError()
    try {
      if (supervisorPath !== undefined) {
        recordStage?.('readiness-image')
        const running = await exactImageRunningForReadiness(supervisorPath, dependencies, deadline)
        if (running === undefined) break
        if (!running) throw new Error('native Desktop rollback supervisor exact private image exited before readiness')
      }
      if (monotonicNow(dependencies) >= deadline) break
      if (await dependencies.readPrivate(request.readyPath) === `${request.workerId}\n`) {
        await dependencies.delay(workerReadyPollMs)
        await throwTerminalError()
        if (monotonicNow(dependencies) >= deadline) break
        if (supervisorPath !== undefined) {
          recordStage?.('readiness-image')
          const running = await exactImageRunningForReadiness(supervisorPath, dependencies, deadline)
          if (running === undefined) break
          if (!running) throw new Error('native Desktop rollback supervisor exact private image exited before readiness')
        }
        if (monotonicNow(dependencies) >= deadline) break
        const confirmed = await dependencies.readPrivate(request.readyPath)
        await throwTerminalError()
        if (confirmed === `${request.workerId}\n`) {
          if (supervisorPath !== undefined) {
            recordStage?.('readiness-image')
            const running = await exactImageRunningForReadiness(supervisorPath, dependencies, deadline)
            if (running === undefined) break
            if (!running) throw new Error('native Desktop rollback supervisor exact private image exited before readiness')
          }
          if (monotonicNow(dependencies) >= deadline) break
          recordStage?.('readiness-marker')
          return
        }
      }
    } catch (error) {
      if (!isTransientWindowsMarkerReadError(error, request.plan.platform)) throw error
    }
    await dependencies.delay(workerReadyPollMs)
  }
  await throwTerminalError()
  throw new Error('native Desktop rollback worker did not become ready')
}

/** Read the worker-owned, redacted receipt without treating a malformed marker as a valid failure report. */
async function readWorkerFailure(
  failurePath: string,
  workerId: string,
  platform: NodeJS.Platform,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<NativeRollbackWorkerFailurePhase | undefined> {
  try {
    const receipt = await dependencies.readPrivate(failurePath)
    const workerIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    const failurePhasePattern = '(validating|snapshotting-rollback|snapshotting-candidate|waiting-parent|watching-candidate|rolling-back)'
    const match = receipt?.match(new RegExp(`^(${workerIdPattern}):${failurePhasePattern}\\n$`, 'iu'))
    if (match === undefined || match === null) return undefined
    if (match[1]?.toLowerCase() !== workerId.toLowerCase()) return undefined
    return match[2] as NativeRollbackWorkerFailurePhase | undefined
  } catch (error) {
    if (isTransientWindowsMarkerReadError(error, platform)) return undefined
    throw error
  }
}

/** Wait until a worker that failed readiness has actually stopped before a retry can reuse its private cache paths. */
async function awaitWorkerExit(
  terminal: WorkerTerminal,
  timeoutMs: number,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<void> {
  const deadline = monotonicNow(dependencies) + timeoutMs
  while (!terminal.exited && monotonicNow(dependencies) < deadline) await dependencies.delay(workerReadyPollMs)
  if (!terminal.exited) throw new Error('native Desktop rollback worker did not stop after failed readiness')
}

async function requestWindowsCancellation(
  options: NativeRollbackWorkerLaunchOptions,
  request: NativeRollbackWorkerRequest,
  supervisorPath: string,
  dependencies: NativeRollbackWorkerDependencies,
  recordStage?: NativeUpdateStageRecorder,
): Promise<WindowsCancellationProof> {
  const workerDirectory = win32.dirname(request.readyPath)
  const cancelPath = win32.join(workerDirectory, `native-update-cancel-${request.workerId}.req`)
  const drainedPath = win32.join(workerDirectory, `native-update-drained-${request.workerId}.ack`)
  const record = `${request.workerId}:${randomUUID()}\n`
  await dependencies.writePrivate(cancelPath, record)
  const deadline = monotonicNow(dependencies) + options.workerReadyTimeoutMs
  while (monotonicNow(dependencies) < deadline) {
    const acknowledged = await readExactDrainedAcknowledgement(drainedPath, record, dependencies)
    if (acknowledged && !await exactImageRunning(supervisorPath, dependencies, deadline)) {
      recordStage?.('cancellation-proof')
      return { drainedPath, record, supervisorPath }
    }
    await dependencies.delay(workerReadyPollMs)
  }
  throw new Error('native Desktop rollback supervisor cancellation proof timed out')
}

interface WindowsCancellationProof {
  readonly drainedPath: string
  readonly record: string
  readonly supervisorPath: string
}

async function assertWindowsCancellationProof(
  proof: WindowsCancellationProof,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<void> {
  if (!await readExactDrainedAcknowledgement(proof.drainedPath, proof.record, dependencies)) {
    throw new Error('native Desktop rollback supervisor cancellation proof was not retained')
  }
  if (await exactImageRunning(proof.supervisorPath, dependencies)) {
    throw new Error('native Desktop rollback supervisor cancellation proof still has an exact private image')
  }
}

async function readExactDrainedAcknowledgement(
  path: string,
  record: string,
  dependencies: NativeRollbackWorkerDependencies,
): Promise<boolean> {
  try {
    const metadata = await dependencies.lstatPrivate(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false
    return await dependencies.readPrivate(path) === record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isTransientWindowsMarkerReadError(error, 'win32')) return false
    throw error
  }
}

/** @returns whether an exclusive Windows marker write has not released its file handle yet. */
function isTransientWindowsMarkerReadError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM'
}

function awaitSpawn(child: NativeRollbackWorkerChild): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`native Desktop rollback worker exited before spawn (${code === null ? signal ?? 'unknown status' : String(code)})`))
    })
    child.once('spawn', resolve)
  })
}

function monotonicNow(dependencies: NativeRollbackWorkerDependencies): number {
  return dependencies.now?.() ?? performance.now()
}

async function exactImageRunning(
  supervisorPath: string,
  dependencies: NativeRollbackWorkerDependencies,
  deadline?: number,
): Promise<boolean> {
  try {
    const remaining = deadline === undefined ? 5_000 : Math.floor(deadline - monotonicNow(dependencies))
    if (remaining <= 0) throw new Error('inspection deadline expired')
    return await dependencies.isExactProcessImageRunning(supervisorPath, Math.min(remaining, 5_000))
  } catch {
    throw new Error('native Desktop rollback supervisor exact-image inspection failed')
  }
}

async function exactImageRunningForReadiness(
  supervisorPath: string,
  dependencies: NativeRollbackWorkerDependencies,
  deadline: number,
): Promise<boolean> {
  return await exactImageRunning(supervisorPath, dependencies, deadline)
}

function observeWorker(child: NativeRollbackWorkerChild): WorkerTerminal {
  const terminal: WorkerTerminal = {
    error: undefined,
    exited: false,
    exitCode: undefined,
  }
  child.once('error', (error) => { terminal.error = error })
  child.once('exit', (code, signal) => {
    terminal.exited = true
    terminal.exitCode = code
    terminal.error = new Error(`native Desktop rollback worker exited before readiness (${code === null ? signal ?? 'unknown status' : String(code)})`)
  })
  return terminal
}

const windowsSupervisorBridgeProgram = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$EncodedRequest = [Environment]::GetEnvironmentVariable('${windowsBridgeRequestEnvironmentKey}', 'Process')`,
  `if ([String]::IsNullOrEmpty($EncodedRequest) -or $EncodedRequest.Length -gt ${windowsEnvironmentBlockLimit * 2}) { throw 'invalid request' }`,
  '$RequestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedRequest))',
  '$Request = ConvertFrom-Json -InputObject $RequestJson',
  "$Expected = @('commandLine', 'currentDirectory', 'drainTimeout', 'environment', 'planPath', 'scriptPath', 'supervisorPath')",
  '$Actual = @($Request.PSObject.Properties.Name | Sort-Object)',
  'if ($Actual.Count -ne $Expected.Count -or (Compare-Object -ReferenceObject ($Expected | Sort-Object) -DifferenceObject $Actual)) { throw \'invalid request\' }',
  '$Paths = @([string]$Request.supervisorPath, [string]$Request.scriptPath, [string]$Request.planPath)',
  'if ($Paths.Where({ -not [IO.Path]::IsPathRooted($_) -or $_.IndexOfAny([char[]]@(0, 10, 13, 34)) -ge 0 }).Count -ne 0) { throw \'invalid request\' }',
  'if ($Paths.Where({ -not [IO.Path]::GetDirectoryName($_).Equals([string]$Request.currentDirectory, [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw \'invalid request\' }',
  '$DrainTimeout = [string]$Request.drainTimeout',
  'if ($DrainTimeout -notmatch \'^[0-9]{1,6}$\' -or [int]$DrainTimeout -le 0 -or [int]$DrainTimeout -gt 600000) { throw \'invalid request\' }',
  '$ExpectedCommandLine = ($Paths + $DrainTimeout | ForEach-Object { \'"\' + $_ + \'"\' }) -join \' \'',
  'if (-not $ExpectedCommandLine.Equals([string]$Request.commandLine, [StringComparison]::Ordinal)) { throw \'invalid request\' }',
  '$EnvironmentNames = @{}',
  'foreach ($Entry in [string[]]$Request.environment) { $Separator = $Entry.IndexOf(\'=\'); if ($Separator -le 0 -or $Entry.IndexOf([char]0) -ge 0 -or $Entry.IndexOf([char]10) -ge 0 -or $Entry.IndexOf([char]13) -ge 0) { throw \'invalid request\' }; $Name = $Entry.Substring(0, $Separator).ToUpperInvariant(); if ($EnvironmentNames.ContainsKey($Name)) { throw \'invalid request\' }; $EnvironmentNames[$Name] = $true }',
  `$Startup = New-CimInstance -Namespace root/cimv2 -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32]${windowsCreateFlags}; ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$Request.environment }`,
  '$Created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$Request.commandLine; CurrentDirectory = [string]$Request.currentDirectory; ProcessStartupInformation = $Startup }',
  '$ReturnValue = [uint32]$Created.ReturnValue',
  '$ProcessId = [uint32]$Created.ProcessId',
  '$ExactImage = $false',
  'if ($ReturnValue -eq 0 -and $ProcessId -gt 0) {',
  '  $Process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) | Select-Object -First 1',
  '  if ($null -ne $Process -and $Process.ExecutablePath -and $Process.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId) {',
  '    $ExactImage = [IO.Path]::GetFullPath([string]$Process.ExecutablePath).Equals([IO.Path]::GetFullPath([string]$Request.supervisorPath), [StringComparison]::OrdinalIgnoreCase)',
  '  }',
  '}',
  '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ returnValue = $ReturnValue; processId = $ProcessId; exactImage = $ExactImage })))',
].join('; ')

const windowsExactImageProbeProgram = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$Target = [Environment]::GetEnvironmentVariable("DSH_NATIVE_SUPERVISOR_IMAGE", "Process")',
  'if ([String]::IsNullOrEmpty($Target)) { throw \'invalid target\' }',
  '$Match = Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($Target, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1',
  'if ($null -eq $Match) { [Console]::Out.Write("absent") } else { [Console]::Out.Write("present") }',
].join('; ')

interface WindowsBridgeRequest {
  readonly commandLine: string
  readonly currentDirectory: string
  readonly drainTimeout: string
  readonly environment: readonly string[]
  readonly planPath: string
  readonly scriptPath: string
  readonly supervisorPath: string
}

interface WindowsBridgeResult {
  readonly returnValue: number
  readonly processId: number
  readonly exactImage: boolean
}

async function runWindowsSupervisorBridge(
  supervisorPath: string,
  scriptPath: string,
  planPath: string,
  privateWorkerDirectory: string,
  drainTimeoutMs: number,
  supervisorEnvironment: NodeJS.ProcessEnv,
  deadline: number,
  dependencies: NativeRollbackWorkerDependencies,
  recordStage: NativeUpdateStageRecorder,
): Promise<void> {
  const systemRoot = supervisorEnvironment.SystemRoot
  if (systemRoot === undefined) throw new Error('native Desktop rollback WMI bridge requires the Windows system root')
  const request: WindowsBridgeRequest = {
    commandLine: [supervisorPath, scriptPath, planPath, String(drainTimeoutMs)].map(encodeWindowsArgument).join(' '),
    currentDirectory: privateWorkerDirectory,
    drainTimeout: String(drainTimeoutMs),
    environment: serializeWindowsEnvironment(supervisorEnvironment),
    planPath,
    scriptPath,
    supervisorPath,
  }
  const encodedRequest = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  if (encodedRequest.length > windowsEnvironmentBlockLimit * 2) {
    throw new Error('native Desktop rollback WMI bridge request exceeded its bound')
  }
  const remaining = Math.floor(deadline - monotonicNow(dependencies))
  if (remaining <= 0) throw new Error('native Desktop rollback WMI bridge timed out')
  const bridge = dependencies.runWindowsBridge ?? runWindowsPowerShellBridge
  let stdout: string
  try {
    const result = await bridge(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsSupervisorBridgeProgram, 'utf16le').toString('base64')],
      {
        env: createWindowsBridgeEnvironment(supervisorEnvironment, encodedRequest),
        maxBuffer: windowsBridgeOutputLimit,
        timeout: remaining,
        windowsHide: true,
      },
    )
    if (result.stderr !== '') throw new Error('bridge stderr was not empty')
    stdout = result.stdout
  } catch {
    throw new Error('native Desktop rollback WMI bridge failed')
  }
  const result = parseWindowsBridgeResult(stdout)
  if (result.returnValue !== 0) throw new Error('native Desktop rollback WMI provider rejected process creation')
  if (result.processId <= 0) throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  if (!result.exactImage) throw new Error('native Desktop rollback WMI provider did not establish the exact private supervisor image')
  recordStage('bridge-identity')
}

function createNativeUpdateStageRecorder(
  workerDirectory: string,
  workerId: string,
  workerEnvironment: NodeJS.ProcessEnv,
  dependencies: NativeRollbackWorkerDependencies,
): NativeUpdateStageRecorder {
  if (workerEnvironment[diagnosticsEnvironmentKey] !== '1') {
    const disabled = ((_stage: NativeUpdateDiagnosticStage): void => undefined) as NativeUpdateStageRecorder
    disabled.flush = () => Promise.resolve()
    return disabled
  }
  const recorded = new Set<NativeUpdateDiagnosticStage>()
  const pending = new Set<Promise<void>>()
  const recorder = ((stage: NativeUpdateDiagnosticStage): void => {
    if (recorded.has(stage)) return
    recorded.add(stage)
    const write = Promise.resolve()
      .then(() => dependencies.writePrivate(
        win32.join(workerDirectory, `native-update-stage-${stage}-${workerId}.json`),
        `${stage}\n`,
      ))
      .catch(() => {
        // Test-only stage evidence cannot change the native transition outcome.
      })
    pending.add(write)
    void write.then(() => { pending.delete(write) })
  }) as NativeUpdateStageRecorder
  recorder.flush = async () => { await Promise.allSettled([...pending]) }
  return recorder
}

function validateWindowsLaunchInputs(
  supervisorPath: string,
  scriptPath: string,
  planPath: string,
  privateWorkerDirectory: string,
  drainTimeoutMs: number,
): void {
  for (const path of [supervisorPath, scriptPath, planPath, privateWorkerDirectory]) {
    if (!win32.isAbsolute(path) || /[\0\r\n"]/u.test(path)) {
      throw new Error('native Desktop rollback WMI bridge input was invalid')
    }
  }
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0 || drainTimeoutMs > 600_000) {
    throw new Error('native Desktop rollback WMI bridge timeout was invalid')
  }
}

/** @param value - one validated Windows argv value. @returns CommandLineToArgvW-compatible quoted text. */
export function encodeWindowsArgument(value: string): string {
  if (/[\0\r\n"]/u.test(value)) throw new Error('native Desktop rollback WMI bridge argument was invalid')
  return `"${value.replace(/(\\*)$/u, '$1$1')}"`
}

function serializeWindowsEnvironment(environment: NodeJS.ProcessEnv): readonly string[] {
  const names = new Set<string>()
  const entries = Object.entries(environment).map(([name, value]) => {
    if (value === undefined || !windowsWorkerEnvironmentNameSet.has(name.toUpperCase())
      || name.length === 0 || name.includes('=') || /[\0\r\n]/u.test(name) || /[\0\r\n]/u.test(value)) {
      throw new Error('native Desktop rollback WMI child environment was invalid')
    }
    const foldedName = name.toUpperCase()
    if (names.has(foldedName)) throw new Error('native Desktop rollback WMI child environment contained a duplicate name')
    names.add(foldedName)
    return `${name}=${value}`
  }).sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
  if (Buffer.byteLength(entries.join('\0'), 'utf16le') > windowsEnvironmentBlockLimit) {
    throw new Error('native Desktop rollback WMI child environment exceeded its bound')
  }
  return entries
}

function createWindowsBridgeEnvironment(
  supervisorEnvironment: NodeJS.ProcessEnv,
  encodedRequest: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { [windowsBridgeRequestEnvironmentKey]: encodedRequest }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'] as const) {
    const value = supervisorEnvironment[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function parseWindowsBridgeResult(stdout: string): WindowsBridgeResult {
  if (Buffer.byteLength(stdout, 'utf8') > windowsBridgeOutputLimit) {
    throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(stdout)
  } catch {
    throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  }
  if (JSON.stringify(candidate) !== stdout) {
    throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  }
  const record = candidate as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'exactImage,processId,returnValue'
    || !Number.isSafeInteger(record.returnValue) || (record.returnValue as number) < 0 || (record.returnValue as number) > 0xffff_ffff
    || !Number.isSafeInteger(record.processId) || (record.processId as number) < 0 || (record.processId as number) > 0xffff_ffff
    || typeof record.exactImage !== 'boolean') {
    throw new Error('native Desktop rollback WMI bridge returned a malformed result')
  }
  return record as unknown as WindowsBridgeResult
}

/**
 * Create the strict Windows exact-image inspector used by readiness and cancellation proof.
 * @param runWindowsCommand - bounded hidden PowerShell executor.
 * @returns exact-image inspection that rejects command, stderr, or output ambiguity.
 */
export function createWindowsExactImageInspector(
  runWindowsCommand: NativeRollbackWindowsBridge = runWindowsPowerShellBridge,
): (path: string, timeoutMs?: number) => Promise<boolean> {
  return async (path, timeoutMs = 5_000) => {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) throw new Error('native Desktop exact-image inspection requires the Windows system root')
    try {
      const result = await runWindowsCommand(
        win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsExactImageProbeProgram, 'utf16le').toString('base64')],
        {
          env: { ...createWindowsWorkerEnvironment(), DSH_NATIVE_SUPERVISOR_IMAGE: path },
          maxBuffer: windowsBridgeOutputLimit,
          timeout: Math.max(1, Math.min(timeoutMs, 5_000)),
          windowsHide: true,
        },
      )
      if (result.stderr !== '') throw new Error('inspection stderr was not empty')
      if (result.stdout === 'present') return true
      if (result.stdout === 'absent') return false
    } catch {
      throw new Error('native Desktop exact-image inspection failed')
    }
    throw new Error('native Desktop exact-image inspection failed')
  }
}

/**
 * Preserve the non-secret profile and display paths required by a restarted non-Windows Desktop while excluding credentials.
 * @param source - current Main process environment, provided explicitly for focused tests.
 * @returns constrained Electron-as-Node worker environment.
 */
export function createElectronWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of electronWorkerEnvironmentKeys) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  if (source[diagnosticsEnvironmentKey] === '1' && source[testLibraryPathEnvironmentKey] !== undefined) {
    environment.LD_LIBRARY_PATH = source[testLibraryPathEnvironmentKey]
  }
  return environment
}

const electronWorkerEnvironmentKeys = [
  'HARNESS_HOME',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'PATH',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'DESKTOP_SESSION',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'DSH_TELEMETRY_DISABLED',
] as const

const windowsWorkerEnvironmentKeys = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'ComSpec',
  'HARNESS_HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'PATHEXT',
  'ProgramData',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'DSH_TELEMETRY_DISABLED',
] as const

const windowsWorkerEnvironmentNameSet = new Set([
  'SYSTEMROOT',
  'WINDIR',
  diagnosticsEnvironmentKey,
  ...windowsWorkerEnvironmentKeys,
].map(name => name.toUpperCase()))

/**
 * Preserve the non-secret per-user paths that the replacement Desktop needs while excluding ambient credentials.
 * @param environment - current Main process environment, provided explicitly for focused tests.
 * @returns constrained Windows worker environment with the system root required by
 * PowerShell; PATHEXT includes the extension PowerShell adds for control-panel files.
 */
export function createWindowsWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const systemRoot = environment.SystemRoot
  if (systemRoot !== undefined) {
    result.SystemRoot = systemRoot
    result.WINDIR = systemRoot
  }
  for (const key of windowsWorkerEnvironmentKeys) {
    const value = environment[key]
    if (value !== undefined) {
      result[key] = key === 'PATHEXT' ? normalizeWindowsPowerShellPathExtensions(value) : value
    }
  }
  if (systemRoot !== undefined) {
    const systemDrive = windowsSystemDrive(systemRoot)
    if (systemDrive !== undefined) {
      result.SystemDrive = systemDrive
      result.ProgramData = windowsSystemPath(environment.ProgramData, systemDrive, 'ProgramData')
      result.ALLUSERSPROFILE = windowsSystemPath(environment.ALLUSERSPROFILE, systemDrive, 'ProgramData')
    }
  }
  if (environment[diagnosticsEnvironmentKey] === '1') result[diagnosticsEnvironmentKey] = '1'
  return result
}

function normalizeWindowsPowerShellPathExtensions(value: string): string {
  if (value.split(';').some(extension => extension.trim().toUpperCase() === '.CPL')) return value
  return value === '' ? '.CPL' : `${value};.CPL`
}

function windowsSystemDrive(systemRoot: string): string | undefined {
  if (!win32.isAbsolute(systemRoot) || /[\0\r\n]/u.test(systemRoot)) return undefined
  const root = win32.parse(systemRoot).root
  return /^[A-Za-z]:\\$/u.test(root) ? root.slice(0, 2) : undefined
}

function windowsSystemPath(value: string | undefined, systemDrive: string, fallbackDirectory: string): string {
  if (value !== undefined && win32.isAbsolute(value) && !/[\0\r\n]/u.test(value)
    && win32.parse(value).root.slice(0, 2).toUpperCase() === systemDrive.toUpperCase()) {
    return value
  }
  return win32.join(`${systemDrive}\\`, fallbackDirectory)
}

export const nativeRollbackWorkerDependencies: NativeRollbackWorkerDependencies = {
  readResource: async path => await readFile(path),
  mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }) },
  writePrivate: async (path, bytes) => {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const directory = await open(dirname(path), process.platform === 'win32' ? 'a+' : 'r')
    try { await directory.sync() } finally { await directory.close() }
  },
  readPrivate: async path => await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }),
  listPrivate: async path => await readdir(path),
  lstatPrivate: async path => await lstat(path),
  canonicalize: async path => await realpath(path),
  isExactProcessImageRunning: createWindowsExactImageInspector(),
  remove: async (path) => { await unlink(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
  delay: milliseconds => new Promise((resolve) => { setTimeout(resolve, milliseconds) }),
  spawn: (command, args, options) => spawn(command, args, options),
}

/**
 * Execute one bounded hidden system PowerShell command without a shell.
 * @param executable - absolute system Windows PowerShell image.
 * @param args - fixed noninteractive encoded-command arguments.
 * @param options - constrained environment and output/time bounds.
 * @returns exact stdout and stderr streams after a zero exit.
 */
export async function runWindowsPowerShellBridge(
  executable: string,
  args: readonly string[],
  options: Parameters<NativeRollbackWindowsBridge>[2],
): Promise<Awaited<ReturnType<NativeRollbackWindowsBridge>>> {
  const result = await execFileAsync(executable, [...args], {
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

const nativeDependencies = nativeRollbackWorkerDependencies
