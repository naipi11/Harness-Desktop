/** Detached native rollback worker launch policy. */

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowsExactImageInspector,
  createElectronWorkerEnvironment,
  createWindowsWorkerEnvironment,
  encodeWindowsArgument,
  launchNativeRollbackWorker,
  runWindowsPowerShellBridge,
  type NativeRollbackWorkerChild,
  type NativeRollbackWorkerDependencies,
} from '../src/main/update/native-rollback-launcher.ts'
import type { NativeRollbackPlan } from '../src/main/update/native-rollback.ts'

class FakeWorker extends EventEmitter implements NativeRollbackWorkerChild {
  readonly pid = 4242
  unrefCalls = 0
  killCalls = 0
  killResult = true
  exitOnKill = true

  kill(): boolean {
    this.killCalls += 1
    if (this.exitOnKill) queueMicrotask(() => { this.emit('exit', null, 'SIGTERM') })
    return this.killResult
  }
  unref(): this { this.unrefCalls += 1; return this }
}

const workerId = '33333333-3333-4333-8333-333333333333'
const workerReadyTimeoutMs = 300_000
const diagnosticsEnvironmentKey = 'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS'
const execFileAsync = promisify(execFile)
const plan: NativeRollbackPlan = {
  schemaVersion: 1,
  platform: 'win32',
  parentProcess: {
    processId: 41,
    executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
    startedBeforeMs: 1_700_000_000_000,
  },
  applicationPath: 'C:\\Harness Desktop\\harness-desktop.exe',
  rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.exe',
  rollbackSha256: 'a'.repeat(64),
  rollbackFormat: 'nsis',
  healthCheckTimeoutMs: 30_000,
}

interface DependenciesFixture {
  readonly dependencies: NativeRollbackWorkerDependencies
  readonly files: Map<string, string | Uint8Array>
  readonly calls: unknown[]
}

interface WindowsBridgeCall {
  readonly executable: string
  readonly args: readonly string[]
  readonly options: {
    readonly env: NodeJS.ProcessEnv
    readonly maxBuffer: number
    readonly timeout: number
    readonly windowsHide: true
  }
}

function withWindowsBridge(
  subject: DependenciesFixture,
  run: (call: WindowsBridgeCall) => Promise<string>,
): NativeRollbackWorkerDependencies {
  return Object.assign(subject.dependencies, {
    runWindowsBridge: async (
      executable: string,
      args: readonly string[],
      options: WindowsBridgeCall['options'],
    ) => ({ stdout: await run({ executable, args, options }), stderr: '' }),
    spawn: () => { throw new Error('direct Windows spawn used') },
  })
}

function dependenciesFixture(
  child: FakeWorker,
  exitBeforeReady = false,
  transientReadFailures = 0,
  exitAfterReadyRead = false,
  errorAfterSpawn = false,
  readyDelayMs = 0,
  automaticCancellationProof = true,
): DependenciesFixture {
  const files = new Map<string, string | Uint8Array>()
  const calls: unknown[] = []
  let markerReads = 0
  let exactImageRunning = true
  return {
    files,
    calls,
    dependencies: {
      readResource: async path => path.endsWith('.exe') ? Uint8Array.from([77, 90]) : new TextEncoder().encode('# verified template'),
      mkdir: async (path) => { calls.push({ mkdir: path }) },
      writePrivate: async (path, bytes) => {
        files.set(path, bytes)
        if (automaticCancellationProof && path.includes('native-update-cancel-')) {
          const drainedPath = path.replace('native-update-cancel-', 'native-update-drained-').replace('.req', '.ack')
          files.set(drainedPath, bytes)
          exactImageRunning = false
        }
      },
      readPrivate: async (path) => {
        if (transientReadFailures > 0) {
          transientReadFailures -= 1
          throw Object.assign(new Error('marker is still locked'), { code: 'EBUSY' })
        }
        const stored = files.get(path)
        const value = typeof stored === 'string' ? stored : stored === undefined ? undefined : new TextDecoder().decode(stored)
        if (value !== undefined) markerReads += 1
        if (exitAfterReadyRead && markerReads === 2) exactImageRunning = false
        if (errorAfterSpawn && path.includes('native-rollback-ready-')) throw new Error('worker startup failed')
        return value
      },
      listPrivate: async () => [],
      lstatPrivate: async path => ({
        isDirectory: () => path.endsWith('workers'),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
      }),
      canonicalize: async path => path,
      isExactProcessImageRunning: async () => exactImageRunning,
      remove: async (path) => { files.delete(path) },
      delay: async () =>{  await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) },
      runWindowsBridge: async (executable, args, options) => {
        calls.push({ executable, args, options })
        const planEntry = [...files.entries()].find(([path]) => path.includes('native-rollback-plan-'))
        if (planEntry !== undefined && !exitBeforeReady) {
          const request = JSON.parse(typeof planEntry[1] === 'string' ? planEntry[1] : new TextDecoder().decode(planEntry[1])) as {
            readonly workerId: string
            readonly readyPath: string
          }
          const writeReady = (): void => { files.set(request.readyPath, `${request.workerId}\n`) }
          if (readyDelayMs === 0) writeReady()
          else setTimeout(writeReady, readyDelayMs)
        }
        if (exitBeforeReady) queueMicrotask(() => { exactImageRunning = false })
        return { stdout: '{"returnValue":0,"processId":4242,"exactImage":true}', stderr: '' }
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        const requestSource = args.find(argument => argument.endsWith('.json')) ?? args[1]
        if (requestSource !== undefined && !exitBeforeReady) {
          const stored = files.get(requestSource)
          const request = JSON.parse(typeof stored === 'string' ? stored : requestSource) as { readonly workerId?: string; readonly readyPath?: string }
          if (request.workerId !== undefined && request.readyPath !== undefined) {
            const writeReady = (): void => { files.set(request.readyPath!, `${request.workerId}\n`) }
            if (readyDelayMs === 0) writeReady()
            else setTimeout(writeReady, readyDelayMs)
          }
        }
        queueMicrotask(() => {
          child.emit('spawn')
          if (exitBeforeReady) child.emit('exit', 1, null)
          else if (errorAfterSpawn) child.emit('error', new Error('worker startup failed'))
        })
        return child
      },
    },
  }
}

function stageReceipts(subject: DependenciesFixture): readonly string[] {
  return [...subject.files.entries()]
    .filter(([path]) => path.includes('native-update-stage-'))
    .map(([, value]) => typeof value === 'string' ? value : new TextDecoder().decode(value))
}

describe('launchNativeRollbackWorker', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('preserves only non-secret Unix profile, display, and local trust paths for the Electron worker', () => {
    expect(createElectronWorkerEnvironment({
      HARNESS_HOME: '/private/harness',
      HOME: '/Users/person',
      XDG_CONFIG_HOME: '/private/config',
      XDG_DATA_HOME: '/private/data',
      XDG_CACHE_HOME: '/private/cache',
      XDG_STATE_HOME: '/private/state',
      PATH: '/usr/local/bin:/usr/bin',
      DISPLAY: ':0',
      NODE_EXTRA_CA_CERTS: '/private/loopback-ca.pem',
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'must-not-cross-the-worker-boundary',
      DSH_SESSION_TOKEN: 'must-not-cross-the-worker-boundary',
      APPIMAGE: '/old/Harness Desktop.AppImage',
      APPDIR: '/tmp/.mount_Harness',
    })).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      HARNESS_HOME: '/private/harness',
      HOME: '/Users/person',
      XDG_CONFIG_HOME: '/private/config',
      XDG_DATA_HOME: '/private/data',
      XDG_CACHE_HOME: '/private/cache',
      XDG_STATE_HOME: '/private/state',
      PATH: '/usr/local/bin:/usr/bin',
      DISPLAY: ':0',
      NODE_EXTRA_CA_CERTS: '/private/loopback-ca.pem',
      DSH_TELEMETRY_DISABLED: '1',
    })
  })

  it('preserves only the non-secret Windows user paths needed by a restarted Desktop', () => {
    expect(createWindowsWorkerEnvironment({
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      ProgramData: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      HARNESS_HOME: 'C:\\Users\\person\\Harness',
      USERPROFILE: 'C:\\Users\\person',
      APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
      TEMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      NODE_EXTRA_CA_CERTS: 'C:\\certificates\\private-ca.pem',
      PATH: 'C:\\Windows\\System32',
      DEEPSEEK_API_KEY: 'must-not-cross-the-worker-boundary',
      DSH_SESSION_TOKEN: 'must-not-cross-the-worker-boundary',
      ELECTRON_RUN_AS_NODE: '1',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      SystemDrive: 'C:',
      ProgramData: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      HARNESS_HOME: 'C:\\Users\\person\\Harness',
      USERPROFILE: 'C:\\Users\\person',
      APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
      TEMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      NODE_EXTRA_CA_CERTS: 'C:\\certificates\\private-ca.pem',
      PATH: 'C:\\Windows\\System32',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    expect(createWindowsWorkerEnvironment({ DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '0' })).toEqual({})
  })

  it('derives same-drive system paths when ambient machine paths are absent or cross-drive', () => {
    expect(createWindowsWorkerEnvironment({
      SystemRoot: 'D:\\Windows',
      ProgramData: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'D:\\SharedProfiles',
    })).toEqual({
      SystemRoot: 'D:\\Windows',
      WINDIR: 'D:\\Windows',
      SystemDrive: 'D:',
      ProgramData: 'D:\\ProgramData',
      ALLUSERSPROFILE: 'D:\\SharedProfiles',
    })
  })

  it('uses only the hidden system PowerShell WMI bridge with exact child inputs and environment', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('HARNESS_HOME', 'C:\\Users\\person\\Harness')
    vi.stubEnv('TEMP', 'C:\\Users\\person\\Temp')
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-cross-either-boundary')
    vi.stubEnv('DSH_SESSION_TOKEN', 'must-not-cross-either-boundary')
    vi.stubEnv(diagnosticsEnvironmentKey, '1')
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const bridgeCalls: WindowsBridgeCall[] = []
    subject.dependencies.isExactProcessImageRunning = async () => true
    const dependencies = withWindowsBridge(subject, async (call) => {
      bridgeCalls.push(call)
      const encodedRequest = call.options.env.DSH_NATIVE_WMI_LAUNCH
      if (encodedRequest === undefined) throw new Error('fixture bridge request was absent')
      const stored = [...subject.files.entries()].find(([path]) => path.includes('native-rollback-plan-'))?.[1]
      const workerRequest = JSON.parse(typeof stored === 'string' ? stored : '') as {
        readonly readyPath: string
        readonly workerId: string
      }
      subject.files.set(workerRequest.readyPath, `${workerRequest.workerId}\n`)
      return '{"returnValue":0,"processId":4242,"exactImage":true}'
    })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies,
    })).resolves.toMatchObject({ workerId })

    expect(bridgeCalls).toHaveLength(1)
    const call = bridgeCalls[0]!
    expect(call.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive'])
    expect(call.args[3]).toBe('-EncodedCommand')
    expect(call.options).toMatchObject({ windowsHide: true, maxBuffer: 1024 })
    expect(call.options.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(call.options.env.DSH_SESSION_TOKEN).toBeUndefined()
    const encodedRequest = call.options.env.DSH_NATIVE_WMI_LAUNCH
    expect(encodedRequest).toEqual(expect.any(String))
    const request = JSON.parse(Buffer.from(encodedRequest!, 'base64').toString('utf8')) as {
      readonly commandLine: string
      readonly currentDirectory: string
      readonly drainTimeout: string
      readonly environment: readonly string[]
      readonly planPath: string
      readonly scriptPath: string
      readonly supervisorPath: string
    }
    expect({ ...request, environment: [] }).toEqual({
      commandLine: '"C:\\private\\native-updates\\workers\\native-update-supervisor-33333333-3333-4333-8333-333333333333.exe" "C:\\private\\native-updates\\workers\\native-rollback-worker-33333333-3333-4333-8333-333333333333.ps1" "C:\\private\\native-updates\\workers\\native-rollback-plan-33333333-3333-4333-8333-333333333333.json" "300000"',
      currentDirectory: 'C:\\private\\native-updates\\workers',
      drainTimeout: '300000',
      environment: [],
      planPath: 'C:\\private\\native-updates\\workers\\native-rollback-plan-33333333-3333-4333-8333-333333333333.json',
      scriptPath: 'C:\\private\\native-updates\\workers\\native-rollback-worker-33333333-3333-4333-8333-333333333333.ps1',
      supervisorPath: 'C:\\private\\native-updates\\workers\\native-update-supervisor-33333333-3333-4333-8333-333333333333.exe',
    })
    for (const entry of [
      'HARNESS_HOME=C:\\Users\\person\\Harness',
      'SystemRoot=C:\\Windows',
      'TEMP=C:\\Users\\person\\Temp',
      'WINDIR=C:\\Windows',
      'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS=1',
    ]) expect(request.environment).toContain(entry)
    expect(request.environment.some(entry => /(?:KEY|SECRET|TOKEN|PASSWORD|DSH_NATIVE_WMI_LAUNCH)/iu.test(entry))).toBe(false)
    expect(call.args[4]).toEqual(expect.any(String))
  })

  it('records only fixed opt-in Windows launch stages through stable readiness', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).resolves.toMatchObject({ workerId })

    await vi.waitFor(() => {
      expect(stageReceipts(subject)).toEqual([
        'prepare\n',
        'bridge-create\n',
        'bridge-identity\n',
        'readiness-image\n',
        'readiness-marker\n',
      ])
    })
    const receipts = stageReceipts(subject)
    expect(receipts.join('')).not.toMatch(/(?:[A-Z]:\\|processId|commandLine|environment|4242)/u)
  })

  it('does not let pending diagnostic receipt writes delay stable readiness', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const writePrivate = subject.dependencies.writePrivate.bind(subject.dependencies)
    const releaseStageWrites: Array<() => void> = []
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.delay = async () => undefined
    subject.dependencies.writePrivate = async (path, bytes) => {
      if (path.includes('native-update-stage-')) {
        await new Promise<void>((resolve) => { releaseStageWrites.push(resolve) })
      }
      await writePrivate(path, bytes)
    }

    const launch = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })
    const observed = await Promise.race([
      launch.then(() => 'ready' as const),
      new Promise<'blocked'>((resolve) => { setImmediate(() => { resolve('blocked') }) }),
    ])

    expect(observed).toBe('ready')
    for (const release of releaseStageWrites) release()
    await launch
  })

  it('does not let a synchronous diagnostic receipt failure change stable readiness', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const writePrivate = subject.dependencies.writePrivate.bind(subject.dependencies)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.writePrivate = (path, bytes) => {
      if (path.includes('native-update-stage-')) throw new Error('diagnostic storage unavailable')
      return writePrivate(path, bytes)
    }

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).resolves.toMatchObject({ workerId })
  })

  it('flushes opt-in diagnostic stages before a failed Windows launch is cleaned up', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const writePrivate = subject.dependencies.writePrivate.bind(subject.dependencies)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.writePrivate = async (path, bytes) => {
      if (path.includes('native-update-stage-')) await new Promise<void>((resolve) => { setTimeout(resolve, 1_000) })
      await writePrivate(path, bytes)
    }
    const dependencies = withWindowsBridge(subject, async () => (
      '{"returnValue":8,"processId":4242,"exactImage":false}'
    ))

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 5_000, workerId, dependencies,
    })).rejects.toThrow('provider')
    expect(stageReceipts(subject)).toEqual(['prepare\n', 'bridge-create\n'])
  }, 10_000)

  it('does not let a rejected diagnostic receipt write change stable readiness', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const writePrivate = subject.dependencies.writePrivate.bind(subject.dependencies)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.writePrivate = async (path, bytes) => {
      if (path.includes('native-update-stage-')) throw new Error('diagnostic storage rejected')
      await writePrivate(path, bytes)
    }

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).resolves.toMatchObject({ workerId })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  })

  it.each([
    ['provider failure', '{"returnValue":8,"processId":4242,"exactImage":false}', 'provider'],
    ['image mismatch', '{"returnValue":0,"processId":4242,"exactImage":false}', 'exact private supervisor image'],
    ['extra result field', '{"returnValue":0,"processId":4242,"exactImage":true,"detail":"private"}', 'malformed'],
    ['invalid process identity', '{"returnValue":0,"processId":0,"exactImage":true}', 'malformed'],
    ['oversized process identity', '{"returnValue":0,"processId":4294967296,"exactImage":true}', 'malformed'],
    ['string process identity', '{"returnValue":0,"processId":"4242","exactImage":true}', 'malformed'],
    ['missing result field', '{"returnValue":0,"processId":4242}', 'malformed'],
    ['whitespace-padded result', ' {"returnValue":0,"processId":4242,"exactImage":true}\n', 'malformed'],
    ['stdout noise', 'noise {"returnValue":0,"processId":4242,"exactImage":true}', 'malformed'],
  ])('rejects a bounded WMI %s result without direct-spawn fallback', async (_name, stdout, message) => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 0, false)
    const dependencies = withWindowsBridge(subject, async () => stdout)

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 25, workerId, dependencies,
    })).rejects.toThrow(message)
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
  })

  it('rejects unexpected bridge stderr and preserves inputs without cancellation proof', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 0, false)
    const dependencies = Object.assign(subject.dependencies, {
      runWindowsBridge: async () => ({
        stdout: '{"returnValue":0,"processId":4242,"exactImage":true}',
        stderr: 'unexpected provider warning',
      }),
    })
    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies,
    })).rejects.toThrow('WMI bridge failed')
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
  })

  it('preserves all inputs when acknowledgement without exact-image absence cannot prove cancellation', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 0, false)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.isExactProcessImageRunning = async () => true
    subject.dependencies.writePrivate = async (path, bytes) => {
      subject.files.set(path, bytes)
      if (path.includes('native-update-cancel-')) {
        subject.files.set(path.replace('native-update-cancel-', 'native-update-drained-').replace('.req', '.ack'), bytes)
      }
    }
    const dependencies = withWindowsBridge(subject, async () => (
      '{"returnValue":0,"processId":4242,"exactImage":true}'
    ))

    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies,
    })
    await expect(result).rejects.toThrow('did not become ready')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toContain('cancellation proof')
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
    const stagePaths = [...subject.files.keys()].filter(path => path.includes('native-update-stage-'))
    expect(stagePaths.some(path => path.includes('native-update-stage-prepare-'))).toBe(true)
    expect(stagePaths.some(path => path.includes('native-update-stage-cancellation-proof-'))).toBe(false)
  })

  it('spends one monotonic deadline across WMI creation and readiness', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    let now = 0
    subject.dependencies.now = () => now
    subject.dependencies.delay = async (milliseconds) => { now += milliseconds }
    const dependencies = withWindowsBridge(subject, async () => {
      now = 90
      return '{"returnValue":0,"processId":4242,"exactImage":true}'
    })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies,
    })).rejects.toThrow('did not become ready')
    expect(now).toBe(115)
  })

  it('requires the exact private image before, between, and after stable marker reads', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const observations: string[] = []
    const readPrivate = subject.dependencies.readPrivate.bind(subject.dependencies)
    subject.dependencies.readPrivate = async (path) => {
      if (path.includes('native-rollback-ready-')) observations.push('marker')
      return await readPrivate(path)
    }
    subject.dependencies.isExactProcessImageRunning = async () => { observations.push('image'); return true }

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).resolves.toMatchObject({ workerId })
    expect(observations).toEqual(['image', 'marker', 'image', 'marker', 'image'])
  })

  it.each(['"', '\n'])('rejects a Windows bridge path containing %j before process creation', async (invalid) => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const invalidPlan: NativeRollbackPlan = {
      ...plan,
      rollbackArtifactPath: `C:\\pri${invalid}vate\\native-updates\\rollback\\candidate.exe`,
    }
    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan: invalidPlan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('WMI bridge input was invalid')
    expect(subject.calls.some(call => typeof call === 'object' && call !== null && 'executable' in call)).toBe(false)
  })

  it.each(['"', '\0', '\r', '\n'])('rejects a Windows argument containing control %j', (invalid) => {
    expect(() => { encodeWindowsArgument(`C:\\private\\${invalid}worker.exe`) }).toThrow('argument was invalid')
  })

  it.runIf(process.platform === 'win32')('round-trips a trailing backslash through CommandLineToArgvW', async () => {
    const argument = 'C:\\private path\\trailing\\'
    await expect(decodeWindowsCommandLine(`"fixture.exe" ${encodeWindowsArgument(argument)}`))
      .resolves.toEqual(['fixture.exe', argument])
  })

  it.each([
    ['case-insensitive duplicate names', { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', Path: 'first', PATH: 'second' }, 'duplicate'],
    ['an oversized block', { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'x'.repeat(20_000) }, 'exceeded'],
  ])('rejects a Windows child environment with %s before WMI creation', async (_name, environment, message) => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const dependencies = Object.assign(subject.dependencies, {
      createWindowsWorkerEnvironment: () => environment,
    })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies,
    })).rejects.toThrow(message)
  })

  it.runIf(process.platform === 'win32')('preserves private inputs when a real CIM inspection fails non-terminating', async () => {
    const inspector = createWindowsExactImageInspector(async (executable, _args, options) => {
      const failingProgram = [
        "$ErrorActionPreference = 'Continue'",
        'Get-CimInstance -Namespace root\\dsh_missing_namespace -ClassName Win32_Process',
        "[Console]::Out.Write('absent')",
      ].join('; ')
      const result = await execFileAsync(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(failingProgram, 'utf16le').toString('base64'),
      ], {
        env: options.env,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    })
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const removed: string[] = []
    subject.dependencies.isExactProcessImageRunning = inspector
    subject.dependencies.remove = async (path) => { removed.push(path); subject.files.delete(path) }

    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 5_000, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('exact-image inspection failed')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toMatchObject({ message: 'native Desktop rollback supervisor exact-image inspection failed' })
    expect(removed).toEqual([])
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
  }, 15_000)

  it.runIf(process.platform === 'win32')('preserves private inputs after an actual bridge process timeout', async () => {
    expect(runWindowsPowerShellBridge).toBeTypeOf('function')
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 0, false)
    const dependencies = Object.assign(subject.dependencies, {
      runWindowsBridge: async (executable: string, _args: readonly string[], options: WindowsBridgeCall['options']) => {
        const timeoutProgram = 'Start-Sleep -Seconds 2'
        return await runWindowsPowerShellBridge(executable, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(timeoutProgram, 'utf16le').toString('base64'),
        ], { ...options, timeout: 25 })
      },
    })

    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies,
    })
    await expect(result).rejects.toThrow('WMI bridge failed')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toContain('cancellation proof')
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
  }, 10_000)

  it('copies a Windows worker outside the NSIS installation and proves local readiness before continuing', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)

    const receipt = await launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\resources\\app.asar\\out\\main\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan,
      workerReadyTimeoutMs,
      workerId,
      dependencies: subject.dependencies,
    })

    expect(receipt).toEqual({
      workerId,
      readyPath: 'C:\\private\\native-updates\\workers\\native-rollback-ready-33333333-3333-4333-8333-333333333333.json',
    })
    expect(subject.calls).toContainEqual({ mkdir: 'C:\\private\\native-updates\\workers' })
    expect(subject.calls.some(call => typeof call === 'object' && call !== null
      && 'executable' in call && typeof call.executable === 'string' && /powershell\.exe$/iu.test(call.executable)
      && 'options' in call && typeof call.options === 'object' && call.options !== null
      && 'windowsHide' in call.options && call.options.windowsHide === true)).toBe(true)
    expect(subject.calls.some(call => typeof call === 'object' && call !== null && 'command' in call)).toBe(false)
    expect(child.unrefCalls).toBe(0)
  })

  it('uses Electron-as-Node only for a non-Windows worker and passes its constrained request envelope', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const macPlan: NativeRollbackPlan = {
      ...plan,
      platform: 'darwin',
      applicationPath: 'C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop',
      rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.zip',
      rollbackFormat: 'zip',
    }

    await launchNativeRollbackWorker({
      platform: 'darwin',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\resources\\app.asar\\out\\main\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan: macPlan,
      workerReadyTimeoutMs,
      workerId,
      dependencies: subject.dependencies,
    })

    expect(subject.calls).toContainEqual(expect.objectContaining({
      command: 'C:\\Harness Desktop\\harness-desktop.exe',
      args: [
        'C:\\Harness Desktop\\resources\\app.asar\\out\\main\\native-rollback-worker.js',
        expect.stringContaining('"readyPath":"C:\\\\private\\\\native-updates\\\\workers\\\\native-rollback-ready-33333333-3333-4333-8333-333333333333.json"'),
      ],
      options: expect.objectContaining({ env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) as unknown }) as unknown,
    }))
  })

  it('cancels a ready non-Windows worker when the durable rollback handoff is rejected', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const macPlan: NativeRollbackPlan = {
      ...plan,
      platform: 'darwin',
      rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.zip',
      rollbackFormat: 'zip',
    }

    await expect(launchNativeRollbackWorker({
      platform: 'darwin', executablePath: plan.applicationPath, workerPath: 'worker.js',
      windowsSupervisorTemplatePath: 'unused.exe', windowsWorkerTemplatePath: 'unused.ps1',
      plan: macPlan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
      afterReady: async () => {
        expect(child.unrefCalls).toBe(0)
        throw new Error('rollback handoff was rejected')
      },
    })).rejects.toThrow('rollback handoff was rejected')

    expect(child.killCalls).toBe(1)
    expect(child.unrefCalls).toBe(0)
  })

  it('kills and awaits a failed non-Windows worker without using Windows cancellation operations', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)
    subject.dependencies.writePrivate = async () => { throw new Error('Windows private write used') }
    const macPlan: NativeRollbackPlan = {
      ...plan, platform: 'darwin', rollbackFormat: 'zip',
      rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.zip',
    }

    await expect(launchNativeRollbackWorker({
      platform: 'darwin', executablePath: plan.applicationPath, workerPath: 'worker.js',
      windowsSupervisorTemplatePath: 'unused.exe', windowsWorkerTemplatePath: 'unused.ps1',
      plan: macPlan, workerReadyTimeoutMs: 50, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('worker startup failed')
    expect(child.killCalls).toBe(1)
  })

  it('keeps waiting while the Windows worker still holds its readiness marker exclusively', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 1)

    await expect(launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan,
      workerReadyTimeoutMs,
      workerId,
      dependencies: subject.dependencies,
    })).resolves.toEqual(expect.objectContaining({ workerId }))
    expect(child.killCalls).toBe(0)
    expect(child.unrefCalls).toBe(0)
  })

  it('uses the release-policy worker preparation window instead of the candidate health window', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 50)

    await expect(launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan: { ...plan, healthCheckTimeoutMs: 30 },
      workerReadyTimeoutMs: 150,
      workerId,
      dependencies: subject.dependencies,
    })).resolves.toEqual(expect.objectContaining({ workerId }))
    expect(child.killCalls).toBe(0)
  })

  it('does not accept a ready marker from a worker that exits during the handoff', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, true)

    await expect(launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan,
      workerReadyTimeoutMs,
      workerId,
      dependencies: subject.dependencies,
    })).rejects.toThrow('exited before readiness')
    expect(child.killCalls).toBe(0)
    expect(child.unrefCalls).toBe(0)
  })

  it('preserves inputs when a Windows supervisor exits before it proves readiness', async () => {
    vi.stubEnv(diagnosticsEnvironmentKey, undefined)
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, true, 0, false, false, 0, false)

    await expect(launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan,
      workerReadyTimeoutMs: 50,
      workerId,
      dependencies: subject.dependencies,
    })).rejects.toThrow('exited before readiness')
    expect(child.unrefCalls).toBe(0)
    expect(child.killCalls).toBe(0)
    expect([...subject.files.keys()]).toContain(
      'C:\\private\\native-updates\\workers\\native-rollback-worker-33333333-3333-4333-8333-333333333333.ps1',
    )
    expect([...subject.files.keys()]).toContain(
      'C:\\private\\native-updates\\workers\\native-rollback-plan-33333333-3333-4333-8333-333333333333.json',
    )
    expect([...subject.files.keys()].some(path => path.includes('native-update-exit-'))).toBe(false)
  })

  it('waits for a worker terminated after a readiness error before allowing a retry', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)

    await expect(launchNativeRollbackWorker({
      platform: 'win32',
      executablePath: 'C:\\Harness Desktop\\harness-desktop.exe',
      workerPath: 'C:\\Harness Desktop\\native-rollback-worker.js',
      windowsSupervisorTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\Harness Desktop\\resources\\windows-native-rollback-worker.ps1',
      plan,
      workerReadyTimeoutMs,
      workerId,
      dependencies: subject.dependencies,
    })).rejects.toThrow('worker startup failed')
    expect(child.killCalls).toBe(0)
    expect(child.unrefCalls).toBe(0)
  })

  it('requests Windows cancellation and removes the drained acknowledgement last after matching exit proof', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true, 0, false)
    const removed: string[] = []
    subject.dependencies.writePrivate = async (path, bytes) => {
      subject.files.set(path, bytes)
      if (path.includes('native-update-cancel-')) {
        const drainedPath = path.replace('native-update-cancel-', 'native-update-drained-').replace('.req', '.ack')
        subject.files.set(drainedPath, bytes)
        subject.dependencies.isExactProcessImageRunning = async () => false
      }
    }
    subject.dependencies.lstatPrivate = async path => ({
      isDirectory: () => path.endsWith('workers'),
      isFile: () => subject.files.has(path),
      isSymbolicLink: () => false,
    })
    subject.dependencies.remove = async (path) => { removed.push(path); subject.files.delete(path) }

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('worker startup failed')
    expect(child.killCalls).toBe(0)
    expect(removed.at(-1)).toContain('native-update-drained-')
  })

  it('records cancellation proof only after the native acknowledgement and exact image absence', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('worker startup failed')

    await vi.waitFor(() => { expect(stageReceipts(subject)).toContain('cancellation-proof\n') })
  })

  it('accepts cancellation when exit arrives before the final exact acknowledgement read', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true, 0, false)
    let record: string | Uint8Array | undefined
    subject.dependencies.writePrivate = async (path, bytes) => {
      subject.files.set(path, bytes)
      if (path.includes('native-update-cancel-')) {
        record = bytes
        subject.dependencies.isExactProcessImageRunning = async () => false
      }
    }
    subject.dependencies.lstatPrivate = async (path) => {
      if (path.includes('native-update-drained-') && record !== undefined) subject.files.set(path, record)
      return {
        isDirectory: () => path.endsWith('workers'),
        isFile: () => subject.files.has(path),
        isSymbolicLink: () => false,
      }
    }

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('worker startup failed')
    expect(child.killCalls).toBe(0)
  })

  it('accepts a matching acknowledgement plus exact-image absence without a Node exit code', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true, 0, false)
    subject.dependencies.writePrivate = async (path, bytes) => {
      subject.files.set(path, bytes)
      if (path.includes('native-update-cancel-')) {
        subject.files.set(path.replace('native-update-cancel-', 'native-update-drained-').replace('.req', '.ack'), bytes)
        subject.dependencies.isExactProcessImageRunning = async () => false
      }
    }
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('worker startup failed')
    expect([...subject.files.keys()].some(path => path.includes('native-update-supervisor-'))).toBe(false)
  })

  it('preserves inputs when the drained acknowledgement is link-shaped', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)
    subject.dependencies.lstatPrivate = async path => ({
      isDirectory: () => path.endsWith('workers'),
      isFile: () => subject.files.has(path),
      isSymbolicLink: () => path.includes('native-update-drained-'),
    })
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('worker startup failed')
    expect([...subject.files.keys()].some(path => path.includes('native-update-drained-'))).toBe(true)
  })

  it('preserves inputs when exclusive cancellation request publication collides', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)
    subject.dependencies.writePrivate = async (path, bytes) => {
      if (path.includes('native-update-cancel-')) throw Object.assign(new Error('request collision'), { code: 'EEXIST' })
      subject.files.set(path, bytes)
    }
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('worker startup failed')
    expect([...subject.files.keys()].some(path => path.includes('native-update-supervisor-'))).toBe(true)
  })

  it('cleans an ambiguous WMI bridge only after cooperative cancellation proof', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false)
    subject.dependencies.runWindowsBridge = async () => { throw new Error('bridge outcome is ambiguous') }
    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('WMI bridge failed')
    expect([...subject.files.keys()].some(path => path.includes(workerId))).toBe(false)
    expect(child.killCalls).toBe(0)
  })

  it('preserves every input when the WMI bridge is lost without cancellation proof', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, false, 0, false)
    const removed: string[] = []
    subject.dependencies.runWindowsBridge = async () => { throw new Error('bridge exited') }
    subject.dependencies.remove = async (path) => { removed.push(path); subject.files.delete(path) }
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'supervisor.exe', windowsWorkerTemplatePath: 'worker.ps1',
      plan, workerReadyTimeoutMs: 100, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('WMI bridge failed')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toContain('cancellation proof')
    expect(removed).toEqual([])
  })

  it('rejects exact supervisor image absence before the stable readiness marker', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, true)

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('exact private image exited before readiness')
    expect(child.unrefCalls).toBe(0)
  })

  it('preserves all private inputs when Windows cancellation acknowledgement times out', async () => {
    const child = new FakeWorker()
    child.killResult = false
    child.exitOnKill = false
    const subject = dependenciesFixture(child, false, 0, false, true, 0, false)

    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies: subject.dependencies,
    })
    await expect(result).rejects.toThrow('worker startup failed')
    const failure = await result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    const privateInputs = [...subject.files.keys()].filter(path =>
      /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path))
    expect(privateInputs).toHaveLength(3)
  })

  it('preserves inputs when the drained acknowledgement carries the wrong cancellation token', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true, 0, false)
    subject.dependencies.createWindowsWorkerEnvironment = () => ({
      SystemRoot: 'C:\\Windows',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
    })
    subject.dependencies.writePrivate = async (path, bytes) => {
      subject.files.set(path, bytes)
      if (path.includes('native-update-cancel-')) {
        const drainedPath = path.replace('native-update-cancel-', 'native-update-drained-').replace('.req', '.ack')
        subject.files.set(drainedPath, `${workerId}:77777777-7777-4777-8777-777777777777\n`)
        queueMicrotask(() => { child.emit('exit', 70, null) })
      }
    }
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies: subject.dependencies,
    })

    await expect(result).rejects.toThrow('worker startup failed')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect([...subject.files.keys()].filter(path => /native-(?:update-supervisor|rollback-worker|rollback-plan)-/u.test(path)))
      .toHaveLength(3)
    const stagePaths = [...subject.files.keys()].filter(path => path.includes('native-update-stage-'))
    expect(stagePaths.some(path => path.includes('native-update-stage-prepare-'))).toBe(true)
    expect(stagePaths.some(path => path.includes('native-update-stage-cancellation-proof-'))).toBe(false)
  })

  it('keeps the readiness failure primary when post-quiescence input cleanup fails', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child, false, 0, false, true)
    subject.dependencies.remove = async (path) => {
      if (path.endsWith('.json')) throw new Error('input is still locked')
      subject.files.delete(path)
    }
    const result = launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs: 50, workerId, dependencies: subject.dependencies,
    })

    await expect(result).rejects.toThrow('worker startup failed')
    const failure = await result.catch((error: unknown) => error)
    expect((failure as Error).cause).toMatchObject({ message: 'input is still locked' })
  })

  it('rejects a linked worker directory before reading resources or spawning', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    subject.dependencies.lstatPrivate = async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true })

    await expect(launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })).rejects.toThrow('not a real directory')
    expect(subject.calls).toEqual([{ mkdir: 'C:\\private\\native-updates\\workers' }])
  })

  it('retires only non-running exact stale supervisors and unlinks matching links without traversal', async () => {
    const child = new FakeWorker()
    const subject = dependenciesFixture(child)
    const old = 'native-update-supervisor-55555555-5555-4555-8555-555555555555.exe'
    const live = 'native-update-supervisor-66666666-6666-4666-8666-666666666666.exe'
    const link = 'native-update-supervisor-77777777-7777-4777-8777-777777777777.exe'
    const malformed = 'native-update-supervisor-not-a-uuid.exe'
    const canonicalized: string[] = []
    const removed: string[] = []
    subject.dependencies.listPrivate = async () => [old, live, link, malformed]
    subject.dependencies.lstatPrivate = async path => ({
      isDirectory: () => path.endsWith('workers'),
      isFile: () => path.endsWith(old) || path.endsWith(live),
      isSymbolicLink: () => path.endsWith(link),
    })
    subject.dependencies.canonicalize = async (path) => { canonicalized.push(path); return path }
    subject.dependencies.isExactProcessImageRunning = async path => path.endsWith(live) || path.includes(workerId)
    subject.dependencies.remove = async (path) => { removed.push(path); subject.files.delete(path) }

    await launchNativeRollbackWorker({
      platform: 'win32', executablePath: plan.applicationPath, workerPath: 'unused.js',
      windowsSupervisorTemplatePath: 'C:\\resources\\windows-native-update-supervisor.exe',
      windowsWorkerTemplatePath: 'C:\\resources\\windows-native-rollback-worker.ps1',
      plan, workerReadyTimeoutMs, workerId, dependencies: subject.dependencies,
    })
    expect(removed.some(path => path.endsWith(old))).toBe(true)
    expect(removed.some(path => path.endsWith(link))).toBe(true)
    expect(removed.some(path => path.endsWith(live) || path.endsWith(malformed))).toBe(false)
    expect(canonicalized.some(path => path.endsWith(link) || path.endsWith(malformed))).toBe(false)
  })
})

async function decodeWindowsCommandLine(commandLine: string): Promise<readonly string[]> {
  const source = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class HarnessCommandLineProbe {',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);',
    '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);',
    '  public static string[] Decode(string commandLine) {',
    '    int count; IntPtr values = CommandLineToArgvW(commandLine, out count); if (values == IntPtr.Zero) throw new InvalidOperationException();',
    '    try { string[] result = new string[count]; for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(values, index * IntPtr.Size)); return result; }',
    '    finally { LocalFree(values); }',
    '  }',
    '}',
  ].join(' ')
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$Source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source, 'utf8').toString('base64')}'))`,
    'Add-Type -TypeDefinition $Source',
    '$Value = [Environment]::GetEnvironmentVariable("DSH_TEST_COMMAND_LINE", "Process")',
    '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([HarnessCommandLineProbe]::Decode($Value))))',
  ].join('; ')
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const result = await execFileAsync(joinWindowsSystemPowerShell(systemRoot), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ], {
    env: { ...createWindowsWorkerEnvironment(), DSH_TEST_COMMAND_LINE: commandLine },
    windowsHide: true,
  })
  if (result.stderr !== '') throw new Error('CommandLineToArgvW probe wrote stderr')
  return JSON.parse(result.stdout) as readonly string[]
}

function joinWindowsSystemPowerShell(systemRoot: string): string {
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}
