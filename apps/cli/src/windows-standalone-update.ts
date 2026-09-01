/** Detached Windows replacement worker for a verified standalone CLI archive. */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const workerReadyPollMs = 25

/** One Windows process identity that prevents a detached worker from trusting a recycled numeric process identifier. */
export interface WindowsStandaloneProcessReference {
  /** Operating-system process identifier. */
  readonly processId: number
  /** Absolute executable path that must still identify the expected parent. */
  readonly executablePath: string
  /** Epoch millisecond upper bound for the expected parent process creation time. */
  readonly startedBeforeMs: number
}

/** One local-only detached Windows update transaction. */
export interface WindowsStandaloneUpdatePlan {
  /** Fixed worker input grammar version. */
  readonly schemaVersion: 2
  /** Running CLI process that must finish before directory replacement starts. */
  readonly parentProcess: WindowsStandaloneProcessReference
  /** Current standalone installation root. */
  readonly root: string
  /** Fully extracted verified candidate root beside the current installation. */
  readonly candidate: string
  /** Private retained root used for rollback. */
  readonly retained: string
  /** Private failed-candidate root used while restoring the retained installation. */
  readonly failed: string
  /** Exact sibling transaction lock retained from staging through worker settlement. */
  readonly lockPath: string
  /** Unpredictable transaction ownership token stored in {@link lockPath}. */
  readonly lockToken: string
  /** Policy-selected upper bound for the candidate health check after the parent CLI process exits. */
  readonly healthCheckTimeoutMs: number
}

interface WindowsStandaloneWorkerRequest {
  readonly schemaVersion: 1
  readonly workerId: string
  readonly readyPath: string
  readonly plan: WindowsStandaloneUpdatePlan
}

/** Injectable process worker dependencies used by focused Windows scheduling tests. */
export interface WindowsStandaloneUpdateDependencies {
  /**
   * @param path - private worker script or plan file.
   * @param bytes - exact private worker bytes.
   * @returns settlement after durable write.
   */
  writeFile(path: string, bytes: string): Promise<void>
  /** @param path - private readiness marker. @returns marker bytes, or undefined only when it is absent. */
  readFile(path: string): Promise<string | undefined>
  /** @param path - exact private file. @returns settlement when absent or removed. */
  remove(path: string): Promise<void>
  /** @param milliseconds - bounded readiness poll delay. @returns fulfillment after the delay. */
  delay(milliseconds: number): Promise<void>
  /**
   * @param command - system-owned PowerShell executable.
   * @param args - fixed worker arguments.
   * @param options - process policy. Windows PowerShell remains attached until the ready marker is observed,
   * then the child is unreferenced.
   * @returns detached worker child.
   */
  spawn(command: string, args: readonly string[], options: { readonly detached: false; readonly stdio: 'ignore'; readonly windowsHide: true; readonly env: NodeJS.ProcessEnv }): WindowsStandaloneWorkerChild
  /** @returns the system-owned PowerShell executable path, or undefined when the platform cannot provide it. */
  powershellPath(): string | undefined
}

/** Detached child process lifecycle required by the parent update transaction. */
export interface WindowsStandaloneWorkerChild {
  /** @param event - one process launch event. @param listener - lifecycle callback. @returns emitter ownership. */
  once(event: 'spawn', listener: () => void): unknown
  /** @param event - one process launch event. @param listener - lifecycle callback. @returns emitter ownership. */
  once(event: 'error', listener: (error: Error) => void): unknown
  /** @param event - one process lifecycle event. @param listener - event callback. @returns emitter ownership. */
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Stop a worker that did not reach its local readiness marker. */
  kill(): boolean
  /** Release the detached worker from the CLI event loop. */
  unref(): void
}

/**
 * Persist and launch a system-hosted worker before the standalone CLI process exits.
 * @param plan - local extracted roots and bounded health policy; no release URL is accepted.
 * @param dependencies - filesystem and process collaborators; production uses system PowerShell only.
 * @returns fulfillment after the worker validates its private plan and begins waiting for the parent CLI process.
 */
export async function scheduleWindowsStandaloneUpdate(
  plan: WindowsStandaloneUpdatePlan,
  dependencies: WindowsStandaloneUpdateDependencies = windowsStandaloneUpdateDependencies,
): Promise<void> {
  validatePlan(plan)
  const powershell = dependencies.powershellPath()
  if (powershell === undefined) throw new Error('standalone CLI: system PowerShell is unavailable for a Windows update')
  const workerId = randomUUID()
  const request = createWorkerRequest(plan, workerId)
  const scriptPath = `${plan.root}.update-worker-${workerId}.ps1`
  const planPath = `${plan.root}.update-worker-${workerId}.json`
  try {
    await dependencies.writeFile(scriptPath, windowsStandaloneWorkerScript)
    await dependencies.writeFile(planPath, `${JSON.stringify(request)}\n`)
    const child = dependencies.spawn(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-PlanPath',
      planPath,
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: windowsWorkerEnvironment(),
    })
    const terminal = observeWorker(child)
    await awaitSpawn(child)
    try {
      await awaitWorkerReady(terminal, request, plan.healthCheckTimeoutMs, dependencies)
      child.unref()
    } catch (error) {
      child.kill()
      throw error
    }
  } catch (error) {
    await Promise.allSettled([dependencies.remove(scriptPath), dependencies.remove(planPath), dependencies.remove(request.readyPath)])
    throw error
  }
}

function createWorkerRequest(plan: WindowsStandaloneUpdatePlan, workerId: string): WindowsStandaloneWorkerRequest {
  return {
    schemaVersion: 1,
    workerId,
    readyPath: `${plan.root}.update-worker-${workerId}.ready`,
    plan,
  }
}

function validatePlan(plan: WindowsStandaloneUpdatePlan): void {
  const durable = durablePlanPaths(plan)
  if (!isProcessReference(plan.parentProcess) || !isBoundedTimeout(plan.healthCheckTimeoutMs)
    || !isAbsolute(plan.root)
    || (durable === undefined && (!isSibling(plan.root, plan.candidate, '.candidate-')
      || !isSibling(plan.root, plan.retained, '.retained-') || !isSibling(plan.root, plan.failed, '.failed-')
      || plan.lockPath !== `${plan.root}.update.lock`))
    || !new RegExp(`^${uuidPattern}$`, 'iu').test(plan.lockToken)) {
    throw new Error('standalone CLI: detached Windows update plan is invalid')
  }
}

function durablePlanPaths(plan: WindowsStandaloneUpdatePlan): { readonly archiveRoot: string } | undefined {
  const payload = dirname(plan.root)
  if (basename(plan.root) !== 'current' || basename(payload) !== 'payload') return undefined
  const archiveRoot = dirname(payload)
  const candidatePattern = new RegExp(`^${escapeRegularExpression(join(archiveRoot, '.harness-candidate-'))}${uuidPattern}$`, 'iu')
  return candidatePattern.test(plan.candidate)
    && plan.retained === join(payload, 'retained')
    && plan.failed === join(payload, 'failed')
    && plan.lockPath === join(archiveRoot, '.harness-update.lock')
    ? { archiveRoot }
    : undefined
}

/** @returns the current CLI process identity for a detached Windows replacement worker. */
export function currentWindowsStandaloneProcessReference(): WindowsStandaloneProcessReference {
  return {
    processId: process.pid,
    executablePath: process.execPath,
    startedBeforeMs: Math.ceil(Date.now() - process.uptime() * 1000),
  }
}

function isProcessReference(value: unknown): value is WindowsStandaloneProcessReference {
  return isRecord(value) && hasExactKeys(value, ['processId', 'executablePath', 'startedBeforeMs'])
    && isPositiveInteger(value.processId) && typeof value.executablePath === 'string' && isAbsolute(value.executablePath)
    && typeof value.startedBeforeMs === 'number' && Number.isSafeInteger(value.startedBeforeMs) && value.startedBeforeMs > 0
}

function isSibling(root: string, path: string, suffix: string): boolean {
  return isAbsolute(path) && new RegExp(`^${escapeRegularExpression(`${root}${suffix}`)}${uuidPattern}$`, 'iu').test(path)
}

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

function escapeRegularExpression(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isBoundedTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 30_000 && value <= 600_000
}

async function awaitWorkerReady(
  terminal: { error: Error | undefined },
  request: WindowsStandaloneWorkerRequest,
  timeoutMs: number,
  dependencies: WindowsStandaloneUpdateDependencies,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (terminal.error !== undefined) throw terminal.error
    if (await dependencies.readFile(request.readyPath) === `${request.workerId}\n`) {
      // Match the Desktop worker handshake: a marker is only valid once the
      // attached child has remained alive through a second local observation.
      await dependencies.delay(workerReadyPollMs)
      const lateError = observedWorkerError(terminal)
      if (lateError !== undefined) throw lateError
      if (await dependencies.readFile(request.readyPath) === `${request.workerId}\n`) return
    }
    await dependencies.delay(workerReadyPollMs)
  }
  throw new Error('standalone CLI: detached Windows update worker did not become ready')
}

function observedWorkerError(terminal: { readonly error: Error | undefined }): Error | undefined {
  return terminal.error
}

function awaitSpawn(child: WindowsStandaloneWorkerChild): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`standalone CLI: detached Windows update worker exited before spawn (${code === null ? signal ?? 'unknown status' : String(code)})`))
    })
    child.once('spawn', resolve)
  })
}

function observeWorker(child: WindowsStandaloneWorkerChild): { error: Error | undefined } {
  const terminal: { error: Error | undefined } = { error: undefined }
  child.once('error', (error) => { terminal.error = error })
  child.once('exit', (code, signal) => {
    terminal.error = new Error(`standalone CLI: detached Windows update worker exited before readiness (${code === null ? signal ?? 'unknown status' : String(code)})`)
  })
  return terminal
}

function windowsWorkerEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot, WINDIR: systemRoot }
}

const windowsStandaloneUpdateDependencies: WindowsStandaloneUpdateDependencies = {
  writeFile: async (path, bytes) => { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) },
  readFile: async path => await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }),
  remove: async (path) => { await rm(path, { force: true }) },
  delay: milliseconds => new Promise((resolve) => { setTimeout(resolve, milliseconds) }),
  spawn: (command, args, options) => spawn(command, args, options),
  powershellPath: () => {
    const systemRoot = process.env.SystemRoot
    return systemRoot === undefined ? undefined : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  },
}

/** Fixed local-only PowerShell program used by the detached standalone Windows updater. */
export const windowsStandaloneWorkerScript = String.raw`param([Parameter(Mandatory = $true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HarnessStandaloneUpdate {
  public sealed class JobResult {
    public int ExitCode;
    public string Output = "";
    public bool TimedOut;
    public bool HadDescendants;
    public bool Quiescent;
  }

  public static class JobRunner {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);

    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

    static ulong[] ProcessIds(IntPtr job) {
      int capacity = 64;
      while (true) {
        int bytes = 8 + IntPtr.Size * capacity;
        IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try {
          Marshal.WriteInt32(buffer, 0, capacity);
          uint returned;
          if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)bytes, out returned)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 234) { capacity *= 2; continue; }
            throw new Win32Exception(error);
          }
          int count = Marshal.ReadInt32(buffer, 4);
          ulong[] result = new ulong[count];
          for (int index = 0; index < count; index++) result[index] = IntPtr.Size == 8 ? (ulong)Marshal.ReadInt64(buffer, 8 + index * 8) : (uint)Marshal.ReadInt32(buffer, 8 + index * 4);
          return result;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    }

    static bool WaitEmpty(IntPtr job, int timeoutMs) {
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      while (DateTime.UtcNow < deadline) { if (ProcessIds(job).Length == 0) return true; Thread.Sleep(25); }
      return ProcessIds(job).Length == 0;
    }

    public static JobResult Run(string executable, string arguments, int timeoutMs, string outputPath) {
      IntPtr job = IntPtr.Zero; PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      try {
        using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read)) {
          Check(SetHandleInformation(output.SafeFileHandle.DangerousGetHandle(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT));
          STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = output.SafeFileHandle.DangerousGetHandle(); startup.hStdError = output.SafeFileHandle.DangerousGetHandle();
          job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
          JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
          int limitSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr limitBuffer = Marshal.AllocHGlobal(limitSize);
          try { Marshal.StructureToPtr(limits, limitBuffer, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitBuffer, (uint)limitSize)); } finally { Marshal.FreeHGlobal(limitBuffer); }
          StringBuilder command = new StringBuilder(Quote(executable) + " " + arguments);
          Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process));
          Check(AssignProcessToJobObject(job, process.hProcess)); if (ResumeThread(process.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
          uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMs); bool timedOut = wait == WAIT_TIMEOUT; if (wait != WAIT_OBJECT_0 && !timedOut) throw new Win32Exception(Marshal.GetLastWin32Error());
          ulong[] members = ProcessIds(job); bool descendants = false; foreach (ulong id in members) if (id != process.dwProcessId) descendants = true;
          if (timedOut || descendants) Check(TerminateJobObject(job, 1)); bool quiescent = WaitEmpty(job, Math.Min(timeoutMs, 5000)); uint exitCode = 1; if (!timedOut) Check(GetExitCodeProcess(process.hProcess, out exitCode));
          output.Flush(true); output.Position = 0; using (StreamReader reader = new StreamReader(output, Encoding.UTF8, true, 4096, true)) return new JobResult { ExitCode = (int)exitCode, Output = reader.ReadToEnd(), TimedOut = timedOut, HadDescendants = descendants, Quiescent = quiescent };
        }
      } finally { if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread); if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess); if (job != IntPtr.Zero) CloseHandle(job); try { File.Delete(outputPath); } catch {} }
    }
  }
}
'@

function Require-Property([object]$Value, [string]$Name) {
  if ($null -eq $Value.PSObject.Properties[$Name]) { throw "Harness standalone update request omits $Name" }
  return $Value.$Name
}

function Test-ExactProperties([object]$Value, [string[]]$Expected) {
  $Actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $SortedExpected = @($Expected | Sort-Object)
  return ($Actual -join ',') -eq ($SortedExpected -join ',')
}

function Require-AbsolutePath([object]$Value, [string]$Name) {
  $Path = [string](Require-Property $Value $Name)
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') { throw "Harness standalone update request has a relative $Name" }
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-Uuid([object]$Value) {
  return $Value -is [string] -and $Value -match '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
}

function Test-PositiveInteger([object]$Value) {
  if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64]) { return $false }
  return [int64]$Value -gt 0
}

function Test-BoundedTimeout([object]$Value) {
  return (Test-PositiveInteger $Value) -and [int64]$Value -ge 30000 -and [int64]$Value -le 600000
}

function Test-EpochMilliseconds([object]$Value) {
  if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [double]) { return $false }
  return [double]$Value -gt 0 -and [double]$Value -le 9007199254740991 -and [double]$Value -eq [math]::Floor([double]$Value)
}

function Assert-ProcessReference([object]$Value, [string]$Name) {
  if ($Value -isnot [pscustomobject] -or -not (Test-ExactProperties $Value @('processId', 'executablePath', 'startedBeforeMs'))) {
    throw "Harness standalone update request has an invalid $Name"
  }
  $ProcessId = Require-Property $Value 'processId'
  $ExecutablePath = Require-AbsolutePath $Value 'executablePath'
  $StartedBeforeMs = Require-Property $Value 'startedBeforeMs'
  if (-not (Test-PositiveInteger $ProcessId) -or -not (Test-EpochMilliseconds $StartedBeforeMs)) {
    throw "Harness standalone update request has an invalid $Name"
  }
  return [pscustomobject]@{
    processId = [int]$ProcessId
    executablePath = $ExecutablePath
    startedBeforeMs = [int64]$StartedBeforeMs
  }
}

function Get-ExpectedProcess([pscustomobject]$Reference) {
  try {
    $Process = [System.Diagnostics.Process]::GetProcessById($Reference.processId)
  } catch [System.ArgumentException] {
    return $null
  }
  try {
    $Process.Refresh()
    if ($Process.HasExited) {
      $Process.Dispose()
      return $null
    }
    $Module = $Process.MainModule
    if ($null -eq $Module) { throw 'Harness standalone update worker cannot read the expected process identity' }
    $ExecutablePath = [System.IO.Path]::GetFullPath($Module.FileName)
    $Epoch = [DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime()
    $StartedAtMs = [int64]($Process.StartTime.ToUniversalTime() - $Epoch).TotalMilliseconds
    if (-not $ExecutablePath.Equals($Reference.executablePath, [System.StringComparison]::OrdinalIgnoreCase) -or $StartedAtMs -gt $Reference.startedBeforeMs) {
      $Process.Dispose()
      return $null
    }
    return $Process
  } catch [System.InvalidOperationException] {
    $Process.Dispose()
    return $null
  } catch {
    $Process.Dispose()
    throw
  }
}

function Test-ExpectedProcessAlive([pscustomobject]$Reference) {
  $Process = Get-ExpectedProcess $Reference
  if ($null -eq $Process) { return $false }
  try { return $true } finally { $Process.Dispose() }
}

function Wait-ForParentExit([pscustomobject]$Reference) {
  while (Test-ExpectedProcessAlive $Reference) {
    Start-Sleep -Milliseconds 100
  }
}

function Test-ExpectedSibling([string]$Root, [string]$Path, [string]$Suffix) {
  return $Path -match ('^' + [System.Text.RegularExpressions.Regex]::Escape($Root + $Suffix) + '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
}

function Assert-PrivateDirectory([string]$Path, [string]$ExpectedParent) {
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $Item.PSIsContainer -or ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Harness standalone update path is not a private directory'
  }
  $Resolved = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath)
  $ResolvedParent = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ExpectedParent -ErrorAction Stop).ProviderPath)
  if (-not [System.IO.Path]::GetDirectoryName($Resolved).Equals($ResolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Harness standalone update path escapes its private parent'
  }
}

function Assert-LockOwner([string]$LockPath, [string]$LockToken) {
  if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { throw 'Harness standalone update transaction lock is absent' }
  $Content = [System.IO.File]::ReadAllText($LockPath, [System.Text.UTF8Encoding]::new($false))
  try { $Lock = $Content | ConvertFrom-Json } catch { throw 'Harness standalone update transaction lock is malformed' }
  if ($Lock -isnot [pscustomobject] -or -not (Test-ExactProperties $Lock @('schemaVersion', 'token', 'processId', 'executablePath', 'startedBeforeMs', 'expiresAtMs')) -or $Lock.schemaVersion -ne 1 -or $Lock.token -ne $LockToken) {
    throw 'Harness standalone update transaction lock ownership changed'
  }
}

function Write-LockOwner([string]$LockPath, [string]$LockToken, [int]$TimeoutMs) {
  Assert-LockOwner $LockPath $LockToken
  $Process = [System.Diagnostics.Process]::GetCurrentProcess()
  $StartedAt = [DateTimeOffset]::new($Process.StartTime)
  $Lock = [ordered]@{ schemaVersion = 1; token = $LockToken; processId = $PID; executablePath = $Process.MainModule.FileName; startedBeforeMs = $StartedAt.ToUnixTimeMilliseconds(); expiresAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + (2 * $TimeoutMs) }
  Write-AtomicText $LockPath (($Lock | ConvertTo-Json -Compress) + [char]10)
}

function Assert-Plan([object]$Plan) {
  $Expected = @('schemaVersion', 'parentProcess', 'root', 'candidate', 'retained', 'failed', 'lockPath', 'lockToken', 'healthCheckTimeoutMs')
  if ($Plan -isnot [pscustomobject] -or -not (Test-ExactProperties $Plan $Expected)) { throw 'Harness standalone update plan has unsupported fields' }
  if ((Require-Property $Plan 'schemaVersion') -ne 2 -or -not (Test-BoundedTimeout (Require-Property $Plan 'healthCheckTimeoutMs'))) {
    throw 'Harness standalone update plan bounds are invalid'
  }
  $Root = Require-AbsolutePath $Plan 'root'
  $ParentProcess = Assert-ProcessReference (Require-Property $Plan 'parentProcess') 'parentProcess'
  $Candidate = Require-AbsolutePath $Plan 'candidate'
  $Retained = Require-AbsolutePath $Plan 'retained'
  $Failed = Require-AbsolutePath $Plan 'failed'
  $LockPath = Require-AbsolutePath $Plan 'lockPath'
  $LockToken = Require-Property $Plan 'lockToken'
  $PayloadRoot = [System.IO.Directory]::GetParent($Root)
  $Durable = $null -ne $PayloadRoot -and $PayloadRoot.Name -eq 'payload' -and [System.IO.Path]::GetFileName($Root) -eq 'current'
  $CandidateRoot = $Candidate
  $CandidateContainer = $Candidate
  $JournalPath = $null
  if ($Durable) {
    $ArchiveRoot = $PayloadRoot.Parent.FullName
    $CandidatePattern = '^' + [System.Text.RegularExpressions.Regex]::Escape((Join-Path $ArchiveRoot '.harness-candidate-')) + '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    if ($Candidate -notmatch $CandidatePattern -or -not $Retained.Equals((Join-Path $PayloadRoot.FullName 'retained'), [System.StringComparison]::OrdinalIgnoreCase) -or -not $Failed.Equals((Join-Path $PayloadRoot.FullName 'failed'), [System.StringComparison]::OrdinalIgnoreCase) -or -not $LockPath.Equals((Join-Path $ArchiveRoot '.harness-update.lock'), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Harness standalone update plan paths are invalid'
    }
    $CandidateRoot = Join-Path $Candidate 'payload\current'
    $JournalPath = Join-Path $ArchiveRoot '.harness-update.json'
  } elseif (-not (Test-ExpectedSibling $Root $Candidate '.candidate-') -or -not (Test-ExpectedSibling $Root $Retained '.retained-') -or -not (Test-ExpectedSibling $Root $Failed '.failed-')) {
    throw 'Harness standalone update plan paths are invalid'
  }
  if ((-not $Durable -and -not $LockPath.Equals("$($Root).update.lock", [System.StringComparison]::OrdinalIgnoreCase)) -or -not (Test-Uuid $LockToken)) {
    throw 'Harness standalone update transaction lock is invalid'
  }
  Assert-LockOwner $LockPath ([string]$LockToken)
  $Node = Join-Path $CandidateRoot 'runtime\node.exe'
  $Entry = Join-Path $CandidateRoot 'cli\package\lib\bin.js'
  if (-not (Test-Path -LiteralPath $Root -PathType Container) -or -not (Test-Path -LiteralPath $CandidateRoot -PathType Container) -or -not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
    throw 'Harness standalone update candidate files are invalid'
  }
  Assert-PrivateDirectory $Root ([System.IO.Path]::GetDirectoryName($Root))
  Assert-PrivateDirectory $CandidateContainer ([System.IO.Path]::GetDirectoryName($CandidateContainer))
  Assert-PrivateDirectory $CandidateRoot ([System.IO.Path]::GetDirectoryName($CandidateRoot))
  return [pscustomobject]@{
    parentProcess = $ParentProcess
    root = $Root
    candidate = $CandidateRoot
    candidateContainer = $CandidateContainer
    retained = $Retained
    failed = $Failed
    lockPath = $LockPath
    lockToken = [string]$LockToken
    healthCheckTimeoutMs = [int](Require-Property $Plan 'healthCheckTimeoutMs')
    journalPath = $JournalPath
  }
}

function Write-Journal([string]$JournalPath, [string]$Phase, [string]$CandidateContainer) {
  if ([string]::IsNullOrWhiteSpace($JournalPath)) { return }
  $Journal = [ordered]@{ schemaVersion = 1; phase = $Phase; candidate = $CandidateContainer }
  Write-AtomicText $JournalPath (($Journal | ConvertTo-Json -Compress) + [char]10)
}

function Write-AtomicText([string]$Path, [string]$Text) {
  $Temporary = "$Path.staging-$([guid]::NewGuid().ToString('D'))"
  $Backup = "$Path.backup-$([guid]::NewGuid().ToString('D'))"
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  try {
    $Stream = [System.IO.File]::Open($Temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $Bytes = $Encoding.GetBytes($Text)
      $Stream.Write($Bytes, 0, $Bytes.Length)
      $Stream.Flush($true)
    } finally { $Stream.Dispose() }
    if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($Temporary, $Path, $Backup, $true); [System.IO.File]::Delete($Backup) }
    else { [System.IO.File]::Move($Temporary, $Path) }
  } finally {
    if ([System.IO.File]::Exists($Temporary)) { [System.IO.File]::Delete($Temporary) }
    if ([System.IO.File]::Exists($Backup)) { [System.IO.File]::Delete($Backup) }
  }
}

function Write-Ready([string]$ReadyPath, [string]$WorkerId) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($ReadyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $Bytes = $Encoding.GetBytes("$WorkerId$([char]10)")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Test-CandidateHealth([string]$Node, [string]$Entry, [int]$TimeoutMs, [string]$OutputPath) {
  $Result = [HarnessStandaloneUpdate.JobRunner]::Run($Node, ('"' + $Entry + '" --help'), $TimeoutMs, $OutputPath)
  return $Result.ExitCode -eq 0 -and -not $Result.TimedOut -and -not $Result.HadDescendants -and $Result.Quiescent -and $Result.Output -match '(?m)^Usage: harness'
}

$CanCleanup = $false
$PrivateScriptPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$PrivatePlanPath = [System.IO.Path]::GetFullPath($PlanPath)
$PrivateReadyPath = $null
$Validated = $null
$CandidatePublished = $false
try {
  $Request = Get-Content -LiteralPath $PrivatePlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Request -isnot [pscustomobject] -or -not (Test-ExactProperties $Request @('schemaVersion', 'workerId', 'readyPath', 'plan')) -or $Request.schemaVersion -ne 1 -or -not (Test-Uuid $Request.workerId)) {
    throw 'Harness standalone update worker request is invalid'
  }
  $WorkerId = [string]$Request.workerId
  $Validated = Assert-Plan $Request.plan
  $ExpectedScriptPath = "$($Validated.root).update-worker-$WorkerId.ps1"
  $ExpectedPlanPath = "$($Validated.root).update-worker-$WorkerId.json"
  $ExpectedReadyPath = "$($Validated.root).update-worker-$WorkerId.ready"
  $PrivateReadyPath = Require-AbsolutePath $Request 'readyPath'
  if (-not $PrivateScriptPath.Equals($ExpectedScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -or -not $PrivatePlanPath.Equals($ExpectedPlanPath, [System.StringComparison]::OrdinalIgnoreCase) -or -not $PrivateReadyPath.Equals($ExpectedReadyPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Harness standalone update worker paths are invalid'
  }
  $CanCleanup = $true
  Write-LockOwner $Validated.lockPath $Validated.lockToken $Validated.healthCheckTimeoutMs
  Write-Ready $PrivateReadyPath $WorkerId
  Wait-ForParentExit $Validated.parentProcess
  Assert-LockOwner $Validated.lockPath $Validated.lockToken
  Assert-PrivateDirectory $Validated.root ([System.IO.Path]::GetDirectoryName($Validated.root))
  Write-Journal $Validated.journalPath 'prepared' $Validated.candidateContainer
  Move-Item -LiteralPath $Validated.root -Destination $Validated.retained -ErrorAction Stop
  Write-Journal $Validated.journalPath 'retained' $Validated.candidateContainer
  try {
    Move-Item -LiteralPath $Validated.candidate -Destination $Validated.root -ErrorAction Stop
    $CandidatePublished = $true
    Write-Journal $Validated.journalPath 'candidate-published' $Validated.candidateContainer
  } catch {
    Move-Item -LiteralPath $Validated.retained -Destination $Validated.root -ErrorAction Stop
    throw
  }
  $Node = Join-Path $Validated.root 'runtime\node.exe'
  $Entry = Join-Path $Validated.root 'cli\package\lib\bin.js'
  try {
    $HealthOutputPath = Join-Path ([System.IO.Path]::GetDirectoryName($Validated.lockPath)) ".harness-health-$WorkerId.log"
    $Healthy = Test-CandidateHealth $Node $Entry $Validated.healthCheckTimeoutMs $HealthOutputPath
  } catch {
    $Healthy = $false
  }
  if ($Healthy) {
    Write-Journal $Validated.journalPath 'committed' $Validated.candidateContainer
    Assert-PrivateDirectory $Validated.retained ([System.IO.Path]::GetDirectoryName($Validated.retained))
    Remove-Item -LiteralPath $Validated.retained -Recurse -Force -ErrorAction Stop
  } else {
    Write-Journal $Validated.journalPath 'rollback-started' $Validated.candidateContainer
    Assert-PrivateDirectory $Validated.root ([System.IO.Path]::GetDirectoryName($Validated.root))
    Move-Item -LiteralPath $Validated.root -Destination $Validated.failed -ErrorAction Stop
    try {
      Assert-PrivateDirectory $Validated.retained ([System.IO.Path]::GetDirectoryName($Validated.retained))
      Move-Item -LiteralPath $Validated.retained -Destination $Validated.root -ErrorAction Stop
    } catch {
      Move-Item -LiteralPath $Validated.failed -Destination $Validated.root -ErrorAction SilentlyContinue
      throw
    }
    Assert-PrivateDirectory $Validated.failed ([System.IO.Path]::GetDirectoryName($Validated.failed))
    Remove-Item -LiteralPath $Validated.failed -Recurse -Force -ErrorAction Stop
  }
  if (-not [string]::IsNullOrWhiteSpace($Validated.journalPath)) { Remove-Item -LiteralPath $Validated.journalPath -Force -ErrorAction SilentlyContinue }
  if (-not $Validated.candidateContainer.Equals($Validated.candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
    Assert-PrivateDirectory $Validated.candidateContainer ([System.IO.Path]::GetDirectoryName($Validated.candidateContainer))
    Remove-Item -LiteralPath $Validated.candidateContainer -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  $OriginalError = $_
  if ($CandidatePublished -and $null -ne $PrivateReadyPath -and $null -ne $Validated -and -not (Test-Path -LiteralPath $Validated.root) -and (Test-Path -LiteralPath $Validated.retained)) {
    Move-Item -LiteralPath $Validated.retained -Destination $Validated.root -ErrorAction Stop
  }
  throw $OriginalError
} finally {
  if ($CanCleanup) {
    Remove-Item -LiteralPath $PrivatePlanPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PrivateScriptPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PrivateReadyPath -Force -ErrorAction SilentlyContinue
    Assert-LockOwner $Validated.lockPath $Validated.lockToken
    Remove-Item -LiteralPath $Validated.lockPath -Force -ErrorAction Stop
  }
}
`
