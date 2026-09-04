/** Windows native rollback watchdog resource behavior. */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createWindowsWorkerEnvironment,
  launchNativeRollbackWorker,
  nativeRollbackWorkerDependencies,
  type NativeRollbackWorkerChild,
  type NativeRollbackWorkerDependencies,
} from '../src/main/update/native-rollback-launcher.ts'

const windows = describe.runIf(process.platform === 'win32')
const workerId = '44444444-4444-4444-8444-444444444444'
const workerTemplate = resolve(import.meta.dirname, '../resources/update/windows-native-rollback-worker.ps1')
const supervisorTemplate = resolve(import.meta.dirname, '../out/native/win32-x64/windows-native-update-supervisor.exe')

windows('windows-native-rollback-worker', () => {
  it('includes the control-panel extension that Windows PowerShell adds to PATHEXT', () => {
    expect(createWindowsWorkerEnvironment({ PATHEXT: '.COM;.EXE' }).PATHEXT).toBe('.COM;.EXE;.CPL')
    expect(createWindowsWorkerEnvironment({ PATHEXT: '.COM;.CPL' }).PATHEXT).toBe('.COM;.CPL')
  })

  it('accepts only the launched candidate identity when applied atomically replaces checking', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$script:StateReads = 0',
      '$script:RolledBack = $false',
      '$script:Stopped = $false',
      '$script:ReusedCapturedPidKilled = $false',
      '$script:ReportedProcessId = 4242',
      '$script:CandidateJob = [pscustomobject]@{ released = $false; disposed = $false }',
      '$script:CandidateJob | Add-Member -MemberType ScriptMethod -Name ReleaseHealthy -Value { $this.released = $true }',
      '$script:CandidateJob | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposed = $true }',
      '$script:CandidateJob | Add-Member -MemberType ScriptMethod -Name ProcessIds -Value { return @([uint64]4242) }',
      'function Wait-ForOwnedParentExitBeforeCandidate { return $true }',
      'function Read-WatchState {',
      '  $script:StateReads += 1',
      "  if ($script:StateReads -eq 1) { return [pscustomobject]@{ phase = 'awaiting-dashboard-health' } }",
      "  return [pscustomobject]@{ phase = 'applied'; candidateProcess = [pscustomobject]@{ processId = $script:ReportedProcessId; executablePath = 'C:\\Harness Desktop\\harness-desktop.exe'; startedBeforeMs = 1010 } }",
      '}',
      "function Invoke-CandidateInstall { return [pscustomobject]@{ processId = 4242; executablePath = 'C:\\Harness Desktop\\harness-desktop.exe'; startedBeforeMs = 1000; launchNonce = '00112233445566778899aabbccddeeff'; job = $script:CandidateJob } }",
      'function Add-ProcessTreeSnapshot {}',
      'function Write-Heartbeat {}',
      'function Test-ExpectedProcessAlive { return $true }',
      'function Stop-CandidateForRollback { $script:Stopped = $true }',
      'function Stop-CapturedProcessIds { $script:ReusedCapturedPidKilled = $true }',
      'function Invoke-Rollback { $script:RolledBack = $true }',
      "$Plan = [pscustomobject]@{ journalPath = 'C:\\private\\pending-native-update.json'; candidateVersion = '1.1.0'; transactionId = '11111111-1111-4111-8111-111111111111'; rollbackArtifactPath = 'C:\\private\\rollback\\candidate.exe'; healthCheckTimeoutMs = 30000 }",
      '$Parent = [System.Diagnostics.Process]::GetProcessById($PID)',
      'try {',
      '  $MatchingResult = Invoke-Watchdog $Plan $Parent "rollback.exe" "candidate.exe"',
      '  $Matching = [pscustomobject]@{ result = $MatchingResult; released = $script:CandidateJob.released; rolledBack = $script:RolledBack; stopped = $script:Stopped; reusedCapturedPidKilled = $script:ReusedCapturedPidKilled; reads = $script:StateReads }',
      '  $script:StateReads = 0; $script:RolledBack = $false; $script:Stopped = $false; $script:ReusedCapturedPidKilled = $false; $script:ReportedProcessId = 4243; $script:CandidateJob.released = $false; $script:CandidateJob.disposed = $false',
      '  $MismatchedResult = Invoke-Watchdog $Plan $Parent "rollback.exe" "candidate.exe"',
      '  $Mismatched = [pscustomobject]@{ result = $MismatchedResult; released = $script:CandidateJob.released; rolledBack = $script:RolledBack; stopped = $script:Stopped; reusedCapturedPidKilled = $script:ReusedCapturedPidKilled; reads = $script:StateReads }',
      '} finally { $Parent.Dispose() }',
      '[pscustomobject]@{ matching = $Matching; mismatched = $Mismatched } | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      matching: { result: true, released: true, rolledBack: false, stopped: false, reusedCapturedPidKilled: false, reads: 2 },
      mismatched: { result: false, released: false, rolledBack: true, stopped: true, reusedCapturedPidKilled: false, reads: 2 },
    })
  }, 15_000)

  it('rejects a matching candidate PID and path that is absent from the launched Candidate Job', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$Job = [pscustomobject]@{}',
      '$Job | Add-Member -MemberType ScriptMethod -Name ProcessIds -Value { return @([uint64]4343) }',
      "$Launched = [pscustomobject]@{ processId = 4242; executablePath = 'C:\\Harness Desktop\\harness-desktop.exe'; startedBeforeMs = 1000; job = $Job }",
      "$Reported = [pscustomobject]@{ processId = 4242; executablePath = 'C:\\Harness Desktop\\harness-desktop.exe'; startedBeforeMs = 1010 }",
      '[Console]::Out.Write([string](Test-ReportedCandidate $Launched $Reported))',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await expect(successfulOutput(probe)).resolves.toBe('False')
  }, 15_000)

  it('expires candidate health from injected monotonic elapsed time without consulting the wall clock', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$script:Elapsed = [System.Collections.Generic.Queue[int64]]::new()',
      '$script:Elapsed.Enqueue(0); $script:Elapsed.Enqueue(0); $script:Elapsed.Enqueue(30000)',
      '$script:Reads = 0; $script:RolledBack = $false; $script:Stopped = $false',
      '$script:CandidateJob = [pscustomobject]@{}',
      '$script:CandidateJob | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}',
      'function Wait-ForOwnedParentExitBeforeCandidate { return $true }',
      "function Read-WatchState { $script:Reads += 1; return [pscustomobject]@{ phase = 'awaiting-dashboard-health' } }",
      "function Invoke-CandidateInstall { return [pscustomobject]@{ processId = 4242; executablePath = 'C:\\Harness Desktop\\harness-desktop.exe'; startedBeforeMs = 1000; launchNonce = '00112233445566778899aabbccddeeff'; job = $script:CandidateJob } }",
      'function Add-ProcessTreeSnapshot {}',
      'function Write-Heartbeat {}',
      'function Test-ExpectedProcessAlive { return $true }',
      'function Stop-CandidateForRollback { $script:Stopped = $true }',
      'function Stop-CapturedProcessIds { throw "bare PID fallback must not run for a Job-owned candidate" }',
      'function Invoke-Rollback { $script:RolledBack = $true }',
      'function Start-Sleep {}',
      "$Plan = [pscustomobject]@{ journalPath = 'C:\\private\\pending-native-update.json'; candidateVersion = '1.1.0'; transactionId = '11111111-1111-4111-8111-111111111111'; rollbackArtifactPath = 'C:\\private\\rollback\\candidate.exe'; healthCheckTimeoutMs = 30000 }",
      '$Parent = [System.Diagnostics.Process]::GetProcessById($PID)',
      'try { $Result = Invoke-Watchdog $Plan $Parent "rollback.exe" "candidate.exe" { return $script:Elapsed.Dequeue() } } finally { $Parent.Dispose() }',
      '[pscustomobject]@{ result = $Result; reads = $script:Reads; stopped = $script:Stopped; rolledBack = $script:RolledBack } | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      result: false,
      reads: 3,
      stopped: true,
      rolledBack: true,
    })
  }, 15_000)

  it('retains verified candidate and rollback snapshots through immutable executable handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-installer-snapshot-'))
    const installerPath = join(root, 'fixture-installer.exe')
    const writeCapablePath = join(root, 'write-capable.exe')
    const rollbackSnapshotPath = join(root, 'rollback-snapshot.exe')
    const candidateSnapshotPath = join(root, 'candidate-snapshot.exe')
    const changedSnapshotPath = join(root, 'changed-snapshot.exe')
    try {
      await compileHarmlessWindowsExecutable(installerPath)
      await copyFile(installerPath, writeCapablePath)
      await copyFile(installerPath, changedSnapshotPath)
      await writeFile(changedSnapshotPath, 'changed after verified write handle closed')
      const digest = createHash('sha256').update(await readFile(installerPath)).digest('hex')
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        '$WriteHandle = [IO.File]::Open(' + powershellLiteral(writeCapablePath) + ', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)',
        '$WriteCapableRejected = $false',
        '$WriteProcess = $null',
        'try { try { $WriteProcess = Start-Process -FilePath ' + powershellLiteral(writeCapablePath) + " -ArgumentList @('/S') -Wait -PassThru } catch { $WriteCapableRejected = $true } } finally { if ($null -ne $WriteProcess) { $WriteProcess.Dispose() }; $WriteHandle.Dispose() }",
        '$RollbackHandle = New-VerifiedInstallerSnapshot ' + powershellLiteral(installerPath) + ' ' + powershellLiteral(rollbackSnapshotPath) + ' ' + powershellLiteral(digest) + " 'rollback'",
        '$CandidateHandle = New-VerifiedInstallerSnapshot ' + powershellLiteral(installerPath) + ' ' + powershellLiteral(candidateSnapshotPath) + ' ' + powershellLiteral(digest) + " 'candidate'",
        '$RollbackProcess = $null',
        '$CandidateProcess = $null',
        '$RollbackExitCode = -1',
        '$CandidateExitCode = -1',
        'try {',
        '  try { $RollbackProcess = Start-Process -FilePath ' + powershellLiteral(rollbackSnapshotPath) + " -ArgumentList @('/S') -Wait -PassThru; $RollbackExitCode = $RollbackProcess.ExitCode } catch {}",
        '  try { $CandidateProcess = Start-Process -FilePath ' + powershellLiteral(candidateSnapshotPath) + " -ArgumentList @('/S') -Wait -PassThru; $CandidateExitCode = $CandidateProcess.ExitCode } catch {}",
        '  $ChangedRejected = $false',
        '  $ChangedHandle = $null',
        '  try { $ChangedHandle = Open-VerifiedInstallerSnapshot ' + powershellLiteral(changedSnapshotPath) + ' ' + powershellLiteral(digest) + " 'changed' } catch { $ChangedRejected = $_.Exception.Message -eq 'Harness Desktop changed installer digest changed' } finally { if ($null -ne $ChangedHandle) { $ChangedHandle.Dispose() } }",
        '  [pscustomobject]@{ writeCapableRejected = $WriteCapableRejected; rollbackCanWrite = $RollbackHandle.CanWrite; candidateCanWrite = $CandidateHandle.CanWrite; rollbackExitCode = $RollbackExitCode; candidateExitCode = $CandidateExitCode; changedRejected = $ChangedRejected } | ConvertTo-Json -Compress',
        '} finally {',
        '  if ($null -ne $CandidateProcess) { $CandidateProcess.Dispose() }',
        '  if ($null -ne $RollbackProcess) { $RollbackProcess.Dispose() }',
        '  $CandidateHandle.Dispose()',
        '  $RollbackHandle.Dispose()',
        '}',
      ].join('; ')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
        writeCapableRejected: true,
        rollbackCanWrite: false,
        candidateCanWrite: false,
        rollbackExitCode: 0,
        candidateExitCode: 0,
        changedRejected: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 30_000)

  it('starts candidate and stable breakaway processes from the installed application directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-working-directory-'))
    const workingDirectory = join(root, 'application')
    const candidateScript = join(root, 'candidate.ps1')
    const candidateMarker = join(root, 'candidate-cwd.txt')
    const stableMarker = join(root, 'stable-cwd.txt')
    const stablePath = join(root, 'stable.exe')
    try {
      await mkdir(workingDirectory)
      await writeFile(candidateScript, [
        `[IO.File]::WriteAllText(${powershellLiteral(candidateMarker)}, [IO.Directory]::GetCurrentDirectory())`,
        'Start-Sleep -Seconds 30',
      ].join('\r\n'), { flag: 'wx' })
      await compileHarmlessWindowsExecutable(stablePath, 'using System; using System.IO; public static class StableWorkingDirectoryFixture { public static int Main() { File.WriteAllText(Environment.GetEnvironmentVariable("HARNESS_STABLE_CWD_MARKER"), Environment.CurrentDirectory); return 0; } }')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const candidateArguments = `-NoLogo -NoProfile -NonInteractive -File "${candidateScript}"`
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `[Environment]::SetEnvironmentVariable('HARNESS_STABLE_CWD_MARKER', ${powershellLiteral(stableMarker)}, 'Process')`,
        `$Job = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments(${powershellLiteral(powershell)}, ${powershellLiteral(candidateArguments)}, ${powershellLiteral(workingDirectory)})`,
        'try { while (-not (Test-Path -LiteralPath ' + powershellLiteral(candidateMarker) + ')) { Start-Sleep -Milliseconds 25 }; $Job.TerminateAndWait(5000) } finally { $Job.Dispose() }',
        `[void][HarnessDesktopUpdate.CandidateJob]::LaunchBreakaway(${powershellLiteral(stablePath)}, ${powershellLiteral(workingDirectory)})`,
        'while (-not (Test-Path -LiteralPath ' + powershellLiteral(stableMarker) + ')) { Start-Sleep -Milliseconds 25 }',
        '[pscustomobject]@{ candidate = [IO.File]::ReadAllText(' + powershellLiteral(candidateMarker) + '); stable = [IO.File]::ReadAllText(' + powershellLiteral(stableMarker) + ') } | ConvertTo-Json -Compress',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const receipt = JSON.parse(await successfulOutput(probe)) as { readonly candidate: string; readonly stable: string }
      const canonicalWorkingDirectory = await realpath(workingDirectory)
      await expect(Promise.all([realpath(receipt.candidate), realpath(receipt.stable)])).resolves.toEqual([
        canonicalWorkingDirectory,
        canonicalWorkingDirectory,
      ])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 30_000)

  it('does not launch the stable application when rollback completion proof cannot be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-rollback-proof-order-'))
    const installerPath = join(root, 'rollback-installer.exe')
    const stablePath = join(root, 'stable.exe')
    const sentinelPath = join(root, 'stable-launched.txt')
    const markerPath = join(root, 'native-update-rolled-back-11111111-1111-4111-8111-111111111111.json')
    try {
      await compileHarmlessWindowsExecutable(installerPath)
      await compileHarmlessWindowsExecutable(stablePath, 'using System; using System.IO; public static class StableFixture { public static int Main() { File.WriteAllText(Environment.GetEnvironmentVariable("HARNESS_PROOF_SENTINEL"), "launched"); return 0; } }')
      await writeFile(markerPath, 'collision\n', { flag: 'wx' })
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `[Environment]::SetEnvironmentVariable('HARNESS_PROOF_SENTINEL', ${powershellLiteral(sentinelPath)}, 'Process')`,
        `$Plan = [pscustomobject]@{ applicationPath = ${powershellLiteral(stablePath)}; rollbackArtifactPath = ${powershellLiteral(installerPath)}; transactionId = '11111111-1111-4111-8111-111111111111'; healthCheckTimeoutMs = 5000 }`,
        '$Message = "none"',
        `try { Invoke-Rollback $Plan ${powershellLiteral(installerPath)} ${powershellLiteral(markerPath)} } catch { $Message = $_.Exception.Message }`,
        '[Console]::Out.Write($Message)',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      await expect(successfulOutput(probe)).resolves.not.toBe('none')
      await expect(readFile(markerPath, 'utf8')).resolves.toBe('collision\n')
      await expect(readFile(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 30_000)

  it('serializes competing rollback workers by transaction before either runs the installer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-rollback-serialization-'))
    const installerPath = join(root, 'rollback-installer.exe')
    const stablePath = join(root, 'stable.exe')
    const invocationPath = join(root, 'rollback-invocations.txt')
    const stableLaunchPath = join(root, 'stable-launches.txt')
    const transactionId = '55555555-5555-4555-8555-555555555555'
    const markerPath = join(root, `native-update-rolled-back-${transactionId}.json`)
    try {
      await compileHarmlessWindowsExecutable(
        installerPath,
        'using System; using System.IO; using System.Threading; public static class SerializedRollbackInstaller { public static int Main() { File.AppendAllText(Environment.GetEnvironmentVariable("HARNESS_ROLLBACK_INVOCATIONS"), "installer\\n"); Thread.Sleep(750); return 0; } }',
      )
      await compileHarmlessWindowsExecutable(
        stablePath,
        'using System; using System.IO; public static class SerializedRollbackStable { public static int Main() { File.AppendAllText(Environment.GetEnvironmentVariable("HARNESS_ROLLBACK_STABLE_LAUNCHES"), "stable\\n"); return 0; } }',
      )
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Plan = [pscustomobject]@{ applicationPath = ${powershellLiteral(stablePath)}; rollbackArtifactPath = ${powershellLiteral(installerPath)}; transactionId = '${transactionId}'; healthCheckTimeoutMs = 5000 }`,
        '$Message = "ok"',
        `try { Invoke-Rollback $Plan ${powershellLiteral(installerPath)} ${powershellLiteral(markerPath)} } catch { $Message = "error:$($_.Exception.Message)" }`,
        '[Console]::Out.Write($Message)',
      ].join('; ')
      const environment = {
        ...process.env,
        HARNESS_ROLLBACK_INVOCATIONS: invocationPath,
        HARNESS_ROLLBACK_STABLE_LAUNCHES: stableLaunchPath,
      }
      const first = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const second = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      await expect(Promise.all([successfulOutput(first), successfulOutput(second)])).resolves.toEqual(['ok', 'ok'])
      await expect(readFile(invocationPath, 'utf8')).resolves.toBe('installer\n')
      await expect.poll(async () => await readFile(stableLaunchPath, 'utf8').catch(() => '')).toBe('stable\n')
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(`${transactionId}\n`)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 30_000)

  it('pins candidate and rollback NSIS installers to the application directory with the destination argument last', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      "$Plan = [pscustomobject]@{ applicationPath = 'C:\\Program Files\\Harness Desktop\\harness-desktop.exe' }",
      '$Candidate = @(Get-NsisInstallerArguments $Plan)',
      '$Rollback = @(Get-NsisInstallerArguments $Plan)',
      '[pscustomobject]@{ candidate = $Candidate; rollback = $Rollback; candidateLast = $Candidate[-1]; rollbackLast = $Rollback[-1] } | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      candidate: ['/S', '/D=C:\\Program Files\\Harness Desktop'],
      rollback: ['/S', '/D=C:\\Program Files\\Harness Desktop'],
      candidateLast: '/D=C:\\Program Files\\Harness Desktop',
      rollbackLast: '/D=C:\\Program Files\\Harness Desktop',
    })
  }, 15_000)

  it('writes the candidate startup bound into the transaction heartbeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-heartbeat-start-bound-'))
    const heartbeatPath = join(root, 'native-update-heartbeat.json')
    try {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `Write-Heartbeat ${powershellLiteral(heartbeatPath)} '11111111-1111-4111-8111-111111111111' '00112233445566778899aabbccddeeff' 1700000000123`,
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      await successfulOutput(probe)
      await expect(readFile(heartbeatPath, 'utf8')).resolves.toBe(
        '11111111-1111-4111-8111-111111111111:00112233445566778899aabbccddeeff:1700000000123\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('builds one explicit candidate launch argument from the supplied nonce only', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      "$env:DSH_NATIVE_UPDATE_LAUNCH_NONCE = 'ambient-must-not-propagate'",
      "$Arguments = @(Get-CandidateLaunchArguments '00112233445566778899aabbccddeeff')",
      '$Arguments | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toBe(
      '--dsh-native-update-launch-nonce=00112233445566778899aabbccddeeff',
    )
  }, 15_000)

  it('writes fixed opt-in candidate diagnostic stages without recording ambient values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-candidate-stage-'))
    const stagePath = join(root, 'native-update-worker-stage-candidate-launch-11111111-1111-4111-8111-111111111111.json')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        "[Environment]::SetEnvironmentVariable('DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS', '1', 'Process')",
        `Write-WorkerDiagnosticStage ${powershellLiteral(root)} '11111111-1111-4111-8111-111111111111' 'candidate-launch'`,
        `[Console]::Out.Write([IO.File]::ReadAllText(${powershellLiteral(stagePath)}))`,
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await expect(successfulOutput(probe)).resolves.toBe('candidate-launch')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 15_000)

  it('durably creates all private inputs with the production Windows writer before spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-production-writer-'))
    const updatesDirectory = join(directory, 'native-updates')
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const privateWorkerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    try {
      await mkdir(dirname(rollbackPath), { recursive: true })
      await writeFile(rollbackPath, 'rollback')
      const dependencies: NativeRollbackWorkerDependencies = {
        ...nativeRollbackWorkerDependencies,
        isExactProcessImageRunning: async () => true,
        runWindowsBridge: async (_executable, _arguments, options) => {
          const encodedRequest = options.env.DSH_NATIVE_WMI_LAUNCH
          if (encodedRequest === undefined) throw new Error('production writer fixture omitted its bridge request')
          const bridgeRequest = JSON.parse(Buffer.from(encodedRequest, 'base64').toString('utf8')) as {
            readonly currentDirectory: string
          }
          const supervisorPath = join(bridgeRequest.currentDirectory, `native-update-supervisor-${privateWorkerId}.exe`)
          const scriptPath = join(bridgeRequest.currentDirectory, `native-rollback-worker-${privateWorkerId}.ps1`)
          const planPath = join(bridgeRequest.currentDirectory, `native-rollback-plan-${privateWorkerId}.json`)
          await Promise.all([supervisorPath, scriptPath, planPath].map(async path => await lstat(path)))
          const request = JSON.parse(await readFile(planPath, 'utf8')) as { readonly readyPath: string; readonly workerId: string }
          await writeFile(request.readyPath, `${request.workerId}\n`, { flag: 'wx' })
          return { stdout: '{"returnValue":0,"processId":4242,"exactImage":true}', stderr: '' }
        },
      }
      await expect(launchNativeRollbackWorker({
        platform: 'win32', executablePath: process.execPath, workerPath: 'unused.js',
        windowsSupervisorTemplatePath: supervisorTemplate, windowsWorkerTemplatePath: workerTemplate,
        plan: {
          schemaVersion: 1, platform: 'win32',
          parentProcess: { processId: process.pid, executablePath: process.execPath, startedBeforeMs: Date.now() },
          applicationPath: process.execPath, rollbackArtifactPath: rollbackPath,
          rollbackSha256: createHash('sha256').update('rollback').digest('hex'), rollbackFormat: 'nsis',
          healthCheckTimeoutMs: 30_000,
        },
        workerReadyTimeoutMs: 30_000, workerId: privateWorkerId, dependencies,
      })).resolves.toMatchObject({ workerId: privateWorkerId })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('launches the external Windows worker, waits for the identified parent, and cleans private worker files', async () => {
    if (!await processIsInJob(process.pid)) {
      throw new Error('real WMI readiness premise absent: the Vitest caller is not Job-contained')
    }
    const directory = await mkdtemp(join(tmpdir(), 'harness-native-worker-'))
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const updatesDirectory = join(directory, 'native-updates')
    const readyPath = join(updatesDirectory, 'workers', `native-rollback-ready-${workerId}.json`)
    const scriptPath = join(updatesDirectory, 'workers', `native-rollback-worker-${workerId}.ps1`)
    const planPath = join(updatesDirectory, 'workers', `native-rollback-plan-${workerId}.json`)
    const supervisorPath = join(updatesDirectory, 'workers', `native-update-supervisor-${workerId}.exe`)
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const rollbackSnapshotPath = join(updatesDirectory, 'workers', `native-rollback-installer-${workerId}.exe`)
    const rollback = Buffer.from('verified stable installer')
    const rollbackSha256 = createHash('sha256').update(rollback).digest('hex')
    const parent = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    try {
      if (parent.pid === undefined) throw new Error('test parent did not expose a process identifier')
      await mkdir(join(updatesDirectory, 'workers'), { recursive: true })
      await mkdir(join(updatesDirectory, 'rollback'), { recursive: true })
      await writeFile(rollbackPath, rollback)
      const receipt = await launchNativeRollbackWorker({
        platform: 'win32',
        executablePath: join(directory, 'Harness Desktop.exe'),
        workerPath: join(directory, 'unused-native-rollback-worker.js'),
        windowsSupervisorTemplatePath: supervisorTemplate,
        windowsWorkerTemplatePath: workerTemplate,
        plan: {
          schemaVersion: 1,
          platform: 'win32',
          parentProcess: {
            processId: parent.pid,
            executablePath: powershell,
            startedBeforeMs: Date.now() + 10_000,
          },
          applicationPath: join(directory, 'Harness Desktop.exe'),
          rollbackArtifactPath: rollbackPath,
          rollbackSha256,
          rollbackFormat: 'nsis',
          healthCheckTimeoutMs: 30_000,
        },
        workerReadyTimeoutMs: 30_000,
        workerId,
        dependencies: nativeRollbackWorkerDependencies,
      })

      expect(receipt).toEqual({ workerId, readyPath })
      await expect(readFile(rollbackSnapshotPath)).resolves.toEqual(rollback)
      await expect(readFile(readyPath, 'utf8')).resolves.toBe(`${workerId}\n`)
      parent.kill()
      await waitForAbsent([readyPath, planPath, scriptPath, rollbackSnapshotPath])
      expect((await readFile(supervisorPath)).subarray(0, 2).toString('ascii')).toBe('MZ')
      await waitForNoExactProcess(supervisorPath)
    } finally {
      parent.kill()
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)

  it('gives a real WMI-created private image only the constrained supervisor environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-wmi-environment-'))
    const updatesDirectory = join(directory, 'native-updates')
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const environmentReceiptPath = join(directory, 'environment.json')
    const fixtureTemplate = join(directory, 'environment-worker.ps1')
    const privateWorkerId = '12121212-1212-4121-8121-121212121212'
    const seeded = {
      HARNESS_HOME: join(directory, 'HarnessHome'),
      DEEPSEEK_API_KEY: 'must-not-reach-wmi-child',
      DSH_SESSION_TOKEN: 'must-not-reach-wmi-child',
      DSH_NATIVE_WMI_LAUNCH: 'ambient-bridge-control',
      DSH_NATIVE_UPDATE_LAUNCH_NONCE: 'ambient-launch-nonce-must-not-propagate',
      DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1',
      PSExecutionPolicyPreference: 'ambient-execution-policy',
      PSModulePath: 'ambient-module-path',
    } as const
    const previous = Object.fromEntries(Object.keys(seeded).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, seeded)
      await mkdir(dirname(rollbackPath), { recursive: true })
      await writeFile(rollbackPath, 'rollback')
      await writeFile(fixtureTemplate, [
        'param([Parameter(Mandatory = $true)][string]$PlanPath)',
        "$ErrorActionPreference = 'Stop'",
        '$Request = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json',
        '$Environment = [ordered]@{}',
        'foreach ($Entry in [Environment]::GetEnvironmentVariables("Process").GetEnumerator()) { $Environment[[string]$Entry.Key] = [string]$Entry.Value }',
        '$Json = ConvertTo-Json -Compress -InputObject $Environment',
        'if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt 16384) { throw \'environment receipt exceeded its bound\' }',
        `[IO.File]::WriteAllText(${powershellLiteral(environmentReceiptPath)}, $Json, [Text.UTF8Encoding]::new($false))`,
        '[IO.File]::WriteAllText([string]$Request.readyPath, ([string]$Request.workerId + "`n"), [Text.UTF8Encoding]::new($false))',
        'Start-Sleep -Seconds 5',
      ].join('\r\n'), { flag: 'wx' })

      await expect(launchNativeRollbackWorker({
        platform: 'win32', executablePath: process.execPath, workerPath: 'unused.js',
        windowsSupervisorTemplatePath: supervisorTemplate, windowsWorkerTemplatePath: fixtureTemplate,
        plan: nativeFixturePlan(rollbackPath), workerReadyTimeoutMs: 30_000,
        workerId: privateWorkerId, dependencies: nativeRollbackWorkerDependencies,
      })).resolves.toMatchObject({ workerId: privateWorkerId })

      const receiptBytes = await readFile(environmentReceiptPath)
      expect(receiptBytes.byteLength).toBeLessThanOrEqual(16 * 1024)
      const actual = JSON.parse(receiptBytes.toString('utf8')) as NodeJS.ProcessEnv
      const expected = createWindowsWorkerEnvironment(process.env)
      const expectedNames = new Set(Object.keys(expected).map(name => name.toUpperCase()))
      const constrainedActual = Object.fromEntries(Object.entries(actual).filter(([name]) => expectedNames.has(name.toUpperCase())))
      expect(sortedEnvironment(constrainedActual)).toEqual(sortedEnvironment(expected))
      expect(Object.keys(actual).filter(name => !expectedNames.has(name.toUpperCase())).map(name => name.toUpperCase()).sort())
        .toEqual(['PSEXECUTIONPOLICYPREFERENCE', 'PSMODULEPATH'])
      expect(actual.DEEPSEEK_API_KEY).toBeUndefined()
      expect(actual.DSH_SESSION_TOKEN).toBeUndefined()
      expect(actual.DSH_NATIVE_WMI_LAUNCH).toBeUndefined()
      expect(actual.DSH_NATIVE_UPDATE_LAUNCH_NONCE).toBeUndefined()
      expect(actual.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS).toBe('1')
      expect(actual.PSExecutionPolicyPreference).not.toBe(seeded.PSExecutionPolicyPreference)
      expect(actual.PSModulePath).not.toBe(seeded.PSModulePath)
      await waitForNoExactProcess(join(
        updatesDirectory, 'workers', `native-update-supervisor-${privateWorkerId}.exe`,
      ))
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 45_000)

  it('accepts the Main startup bound and terminates the owned candidate process tree', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const root = await mkdtemp(join(tmpdir(), 'harness-candidate-job-identity-'))
    const childScript = join(root, 'candidate.cjs')
    await writeFile(childScript, [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'setInterval(() => {}, 1000)',
    ].join('; '))
    try {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Job = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments(${powershellLiteral(process.execPath)}, ${powershellLiteral(childScript)})`,
        '$Candidate = [System.Diagnostics.Process]::GetProcessById($Job.ProcessId)',
        'try {',
        `  $Reference = New-StartedProcessReference $Candidate ${powershellLiteral(process.execPath)}`,
        "  $Reference | Add-Member -NotePropertyName launchNonce -NotePropertyValue '00112233445566778899aabbccddeeff'",
        '  $Reference | Add-Member -NotePropertyName job -NotePropertyValue $Job',
        '  $Reported = [pscustomobject]@{ processId = $Job.ProcessId; executablePath = $Reference.executablePath; startedBeforeMs = $Reference.startedBeforeMs + 10 }',
        '  $IdentityMatches = Test-ReportedCandidate $Reference $Reported',
        '  $Job.TerminateAndWait(5000)',
        '  [pscustomobject]@{ identityMatches = $IdentityMatches; jobEmpty = -not $Job.HasMembers } | ConvertTo-Json -Compress',
        '} finally { $Candidate.Dispose(); $Job.Dispose() }',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const result = JSON.parse(await successfulOutput(probe)) as {
        readonly identityMatches: boolean
        readonly jobEmpty: boolean
      }
      expect(result).toEqual({ identityMatches: true, jobEmpty: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects a recycled PID identity before an exact process handle can enter termination', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$Current = [System.Diagnostics.Process]::GetProcessById($PID)',
      'try {',
      '  $Path = [System.IO.Path]::GetFullPath($Current.MainModule.FileName)',
      '  $Searcher = [System.Management.ManagementObjectSearcher]::new(("SELECT CreationDate FROM Win32_Process WHERE ProcessId = {0}" -f $PID))',
      '  try { $Rows = $Searcher.Get(); $Row = @($Rows | Select-Object -First 1)[0]; $CreationDate = [string]$Row.CreationDate } finally { if ($null -ne $Rows) { $Rows.Dispose() }; $Searcher.Dispose() }',
      '  $RecycledCreationDate = $CreationDate.Substring(0, 20) + "001" + $CreationDate.Substring(23)',
      '  $MatchesOriginal = Test-BoundProcessIdentity $Current $Path $CreationDate',
      '  $MatchesRecycled = Test-BoundProcessIdentity $Current $Path $RecycledCreationDate',
      '  [pscustomobject]@{ matchesOriginal = $MatchesOriginal; matchesRecycled = $MatchesRecycled; stillAlive = -not $Current.HasExited } | ConvertTo-Json -Compress',
      '} finally { $Current.Dispose() }',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      matchesOriginal: true,
      matchesRecycled: false,
      stillAlive: true,
    })
  }, 15_000)

  it('bounds every WMI process search by the remaining termination deadline', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      "$First = New-BoundedManagementSearcher 'SELECT ProcessId FROM Win32_Process' 1234",
      "$Second = New-BoundedManagementSearcher 'SELECT ProcessId FROM Win32_Process' 25",
      '$RemainingAfterFirst = Get-RemainingProcessInspectionTimeout 900 1234',
      '$Expired = $false; try { [void](Get-RemainingProcessInspectionTimeout 1234 1234) } catch { $Expired = $true }',
      'try { [pscustomobject]@{ first = [int]$First.Options.Timeout.TotalMilliseconds; second = [int]$Second.Options.Timeout.TotalMilliseconds; remainingAfterFirst = $RemainingAfterFirst; expired = $Expired } | ConvertTo-Json -Compress } finally { $First.Dispose(); $Second.Dispose() }',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      first: 1234,
      second: 25,
      remainingAfterFirst: 334,
      expired: true,
    })
  }, 15_000)

  it('fails closed when a live descendant WMI row has missing identity fields', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$Messages = @()',
      "foreach ($Identity in @([pscustomobject]@{ executablePath = $null; creationDate = '20260828120000.000000+480' }, [pscustomobject]@{ executablePath = 'C:\\Harness Desktop\\child.exe'; creationDate = $null })) {",
      "  try { Assert-CompleteLiveProcessIdentity $Identity; $Messages += 'accepted' } catch { $Messages += $_.Exception.Message }",
      '}',
      '$Messages | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual([
      'Harness Desktop rollback worker cannot bind a live descendant identity',
      'Harness Desktop rollback worker cannot bind a live descendant identity',
    ])
  }, 15_000)

  it('fails closed when an exact handle has a mismatched live descendant identity', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
      "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
      'Invoke-Expression $Functions',
      '$Current = [System.Diagnostics.Process]::GetProcessById($PID)',
      "$Message = 'accepted'",
      'try { Assert-BoundLiveProcess $Current $false } catch { $Message = $_.Exception.Message } finally { $StillAlive = -not $Current.HasExited; $Current.Dispose() }',
      '[pscustomobject]@{ message = $Message; stillAlive = $StillAlive } | ConvertTo-Json -Compress',
    ].join('; ')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
      message: 'Harness Desktop rollback worker detected an unbound live descendant',
      stillAlive: true,
    })
  }, 15_000)

  it('captures a grandchild whose post-snapshot parent exits before the next process-tree scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-rescan-child-'))
    const childPidPath = join(root, 'child.pid')
    const triggerPath = join(root, 'spawn.trigger')
    const parent = spawn(process.execPath, ['-e', [
      "const { existsSync, writeFileSync } = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      `const trigger = ${JSON.stringify(triggerPath)}`,
      `const receipt = ${JSON.stringify(childPidPath)}`,
      'const timer = setInterval(() => {',
      '  if (!existsSync(trigger)) return',
      '  clearInterval(timer)',
      "  spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); writeFileSync(${JSON.stringify(receipt)}, String(grandchild.pid), 'utf8')`], { stdio: 'ignore' })",
      '}, 5)',
    ].join('; ')], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let childProcessId: number | undefined
    try {
      if (parent.pid === undefined) throw new Error('rescan fixture omitted parent pid')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Reference = [pscustomobject]@{ processId = ${String(parent.pid)}; executablePath = ${powershellLiteral(process.execPath)}; startedBeforeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 10000 }`,
        '$AfterSnapshot = {',
        `  [IO.File]::WriteAllText(${powershellLiteral(triggerPath)}, 'spawn')`,
        `  $Deadline = [System.Diagnostics.Stopwatch]::StartNew(); while (-not [IO.File]::Exists(${powershellLiteral(childPidPath)}) -and $Deadline.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 5 }; Start-Sleep -Milliseconds 100`,
        '}',
        'Stop-ExpectedProcess $Reference 10000 $AfterSnapshot',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await successfulOutput(probe)
      childProcessId = Number.parseInt(await readFile(childPidPath, 'utf8'), 10)
      expect(processIsAlive(parent.pid)).toBe(false)
      expect(processIsAlive(childProcessId)).toBe(false)
    } finally {
      parent.kill()
      if (childProcessId !== undefined) {
        try { process.kill(childProcessId) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 20_000)

  it('releases a healthy Electron-like job while Main and its expected helper remain alive', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const childScript = join(await mkdtemp(join(tmpdir(), 'harness-healthy-job-')), 'candidate.cjs')
    await writeFile(childScript, [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'setInterval(() => {}, 1000)',
    ].join('; '))
    let processIds: readonly number[] = []
    try {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Job = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments(${powershellLiteral(process.execPath)}, ${powershellLiteral(childScript)})`,
        '$Deadline = [DateTime]::UtcNow.AddSeconds(5)',
        'do { $Ids = @($Job.ProcessIds()); if ($Ids.Count -gt 1) { break }; Start-Sleep -Milliseconds 25 } while ([DateTime]::UtcNow -lt $Deadline)',
        'if ($Ids.Count -le 1) { throw "healthy candidate helper did not join the Job Object" }',
        '$MainId = $Job.ProcessId',
        '$Job.ReleaseHealthy()',
        'Start-Sleep -Milliseconds 100',
        '$HelperId = [int]($Ids | Where-Object { $_ -ne $MainId } | Select-Object -First 1)',
        '[pscustomobject]@{ memberCount = $Ids.Count; mainId = $MainId; helperId = $HelperId; mainAlive = Test-ProcessIdAlive $MainId; helperAlive = Test-ProcessIdAlive $HelperId } | ConvertTo-Json -Compress',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const result = JSON.parse(await successfulOutput(probe)) as {
        readonly memberCount: number
        readonly mainId: number
        readonly helperId: number
        readonly mainAlive: boolean
        readonly helperAlive: boolean
      }
      expect(result.memberCount).toBeGreaterThan(1)
      expect(result).toMatchObject({ mainAlive: true, helperAlive: true })
      processIds = [result.mainId, result.helperId]
    } finally {
      for (const id of processIds) {
        try { process.kill(id) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await rm(dirname(childScript), { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects healthy release after the Job leader exits first and terminates its helper', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const root = await mkdtemp(join(tmpdir(), 'harness-leader-first-job-'))
    const childScript = join(root, 'candidate.cjs')
    await writeFile(childScript, [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
      'child.unref()',
      'setTimeout(() => process.exit(0), 500)',
    ].join('; '))
    try {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Job = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments(${powershellLiteral(process.execPath)}, ${powershellLiteral(childScript)})`,
        '$MainId = $Job.ProcessId',
        '$Deadline = [DateTime]::UtcNow.AddSeconds(5)',
        'do { $Ids = @($Job.ProcessIds()); Start-Sleep -Milliseconds 25 } while ((Test-ProcessIdAlive $MainId) -and [DateTime]::UtcNow -lt $Deadline)',
        '$HelperId = [int]($Ids | Where-Object { $_ -ne $MainId } | Select-Object -First 1)',
        '$ReleaseRejected = $false',
        'try { $Job.ReleaseHealthy() } catch { $ReleaseRejected = $true }',
        '$Job.TerminateAndWait(5000)',
        '$Job.Dispose()',
        '[pscustomobject]@{ releaseRejected = $ReleaseRejected; helperCaptured = $HelperId -gt 0; helperAlive = Test-ProcessIdAlive $HelperId } | ConvertTo-Json -Compress',
      ].join('; ')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await expect(successfulOutput(probe).then((text): unknown => JSON.parse(text) as unknown)).resolves.toEqual({
        releaseRejected: true,
        helperCaptured: true,
        helperAlive: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 15_000)

  it('lets a released candidate Job and helper survive PowerShell and supervisor Job closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-supervised-candidate-'))
    const privateWorkerId = '88888888-8888-4888-8888-888888888888'
    const supervisorPath = join(root, `native-update-supervisor-${privateWorkerId}.exe`)
    const scriptPath = join(root, `native-rollback-worker-${privateWorkerId}.ps1`)
    const planPath = join(root, `native-rollback-plan-${privateWorkerId}.json`)
    const candidateScript = join(root, 'candidate.cjs')
    const resultPath = join(root, 'candidate-result.json')
    let processIds: readonly number[] = []
    try {
      await copyFile(supervisorTemplate, supervisorPath)
      await writeFile(planPath, '{}\n', { flag: 'wx' })
      await writeFile(candidateScript, [
        "const { spawn } = require('node:child_process')",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        'setInterval(() => {}, 1000)',
      ].join('; '), { flag: 'wx' })
      await writeFile(scriptPath, [
        'param([Parameter(Mandatory = $true)][string]$PlanPath)',
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$Job = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments(${powershellLiteral(process.execPath)}, ${powershellLiteral(candidateScript)})`,
        '$Deadline = [DateTime]::UtcNow.AddSeconds(5)',
        'do { $Ids = @($Job.ProcessIds()); if ($Ids.Count -gt 1) { break }; Start-Sleep -Milliseconds 25 } while ([DateTime]::UtcNow -lt $Deadline)',
        'if ($Ids.Count -le 1) { throw "candidate helper did not join its Job" }',
        '$MainId = $Job.ProcessId',
        '$Job.ReleaseHealthy()',
        '$HelperId = [int]($Ids | Where-Object { $_ -ne $MainId } | Select-Object -First 1)',
        `[pscustomobject]@{ mainId = $MainId; helperId = $HelperId } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${powershellLiteral(resultPath)} -Encoding ascii -NoNewline`,
      ].join('\r\n'), { flag: 'wx' })
      const supervisor = spawnOutsideCurrentJob(supervisorPath, [scriptPath, planPath, '30000'])
      await waitForObservedExit(supervisor)
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as { readonly mainId: number; readonly helperId: number }
      processIds = [result.mainId, result.helperId]
      expect(processIds.every(processIsAlive)).toBe(true)
    } finally {
      for (const id of processIds) {
        try { process.kill(id) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 20_000)

  it('lets the native stable relaunch survive PowerShell and supervisor Job closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-supervised-stable-'))
    const privateWorkerId = '99999999-9999-4999-8999-999999999999'
    const supervisorPath = join(root, `native-update-supervisor-${privateWorkerId}.exe`)
    const scriptPath = join(root, `native-rollback-worker-${privateWorkerId}.ps1`)
    const planPath = join(root, `native-rollback-plan-${privateWorkerId}.json`)
    const resultPath = join(root, 'stable-result.txt')
    let stableProcessId: number | undefined
    try {
      await copyFile(supervisorTemplate, supervisorPath)
      await writeFile(planPath, '{}\n', { flag: 'wx' })
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await writeFile(scriptPath, [
        'param([Parameter(Mandatory = $true)][string]$PlanPath)',
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        `$StableId = [HarnessDesktopUpdate.CandidateJob]::LaunchBreakaway(${powershellLiteral(powershell)})`,
        `Set-Content -LiteralPath ${powershellLiteral(resultPath)} -Value $StableId -Encoding ascii -NoNewline`,
      ].join('\r\n'), { flag: 'wx' })
      const supervisor = spawnOutsideCurrentJob(supervisorPath, [scriptPath, planPath, '30000'])
      await waitForObservedExit(supervisor)
      stableProcessId = Number.parseInt(await readFile(resultPath, 'utf8'), 10)
      expect(Number.isSafeInteger(stableProcessId) && processIsAlive(stableProcessId)).toBe(true)
    } finally {
      if (stableProcessId !== undefined) {
        try { process.kill(stableProcessId) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 20_000)

  it('keeps installer fixtures in supervisor ownership when the supervisor is terminated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-supervised-installer-'))
    const privateWorkerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const supervisorPath = join(root, `native-update-supervisor-${privateWorkerId}.exe`)
    const scriptPath = join(root, `native-rollback-worker-${privateWorkerId}.ps1`)
    const planPath = join(root, `native-rollback-plan-${privateWorkerId}.json`)
    const resultPath = join(root, 'installer-result.txt')
    let installerProcessId: number | undefined
    try {
      await copyFile(supervisorTemplate, supervisorPath)
      await writeFile(planPath, '{}\n', { flag: 'wx' })
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await writeFile(scriptPath, [
        'param([Parameter(Mandatory = $true)][string]$PlanPath)',
        `$Installer = Start-Process -FilePath ${powershellLiteral(powershell)} -PassThru -WindowStyle Hidden`,
        `Set-Content -LiteralPath ${powershellLiteral(resultPath)} -Value $Installer.Id -Encoding ascii -NoNewline`,
        '$Installer.WaitForExit()',
      ].join('\r\n'), { flag: 'wx' })
      const supervisor = spawnOutsideCurrentJob(supervisorPath, [scriptPath, planPath, '30000'])
      await waitForPresent(resultPath)
      installerProcessId = Number.parseInt(await readFile(resultPath, 'utf8'), 10)
      expect(processIsAlive(installerProcessId)).toBe(true)
      expect(supervisor.kill()).toBe(true)
      await waitForObservedExit(supervisor)
      await waitForProcessAbsent(installerProcessId)
    } finally {
      if (installerProcessId !== undefined) {
        try { process.kill(installerProcessId) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 20_000)

  it('terminates a suspended breakaway candidate when candidate Job assignment fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-candidate-assignment-failure-'))
    const candidatePath = join(root, 'candidate.exe')
    try {
      await copyFile(process.execPath, candidatePath)
      const command = [
        "$ErrorActionPreference = 'Stop'",
        '$Worker = Get-Content -LiteralPath ' + powershellLiteral(workerTemplate) + ' -Raw -Encoding UTF8',
        "$Functions = $Worker.Substring($Worker.IndexOf('$ErrorActionPreference'), $Worker.IndexOf('$CanCleanup = $false') - $Worker.IndexOf('$ErrorActionPreference'))",
        'Invoke-Expression $Functions',
        '$Flags = [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic',
        '$Method = [HarnessDesktopUpdate.CandidateJob].GetMethod("LaunchWithArgumentsCore", $Flags)',
        '$Message = "none"',
        `try { [void]$Method.Invoke($null, @(${powershellLiteral(candidatePath)}, "", $true)) } catch { $Message = if ($null -eq $_.Exception.InnerException) { $_.Exception.Message } else { $_.Exception.InnerException.Message } }`,
        '[Console]::Out.Write($Message)',
      ].join('; ')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await expect(successfulOutput(probe)).resolves.toBe('candidate Job assignment failed by test injection')
      await waitForNoExactProcess(candidatePath)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 15_000)

  it('waits for a timed-out real supervisor PowerShell tree to become absent before input cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-real-timeout-'))
    const updatesDirectory = join(directory, 'native-updates')
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const fixtureTemplate = join(directory, 'non-ready-worker.ps1')
    const workerProcessIdPath = join(directory, 'worker.pid')
    const descendantPath = join(directory, 'descendant.pid')
    const privateWorkerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    try {
      await mkdir(dirname(rollbackPath), { recursive: true })
      await writeFile(rollbackPath, 'rollback')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await writeFile(fixtureTemplate, [
        'param([Parameter(Mandatory = $true)][string]$PlanPath)',
        `Set-Content -LiteralPath ${powershellLiteral(workerProcessIdPath)} -Value $PID -Encoding ascii -NoNewline`,
        `$Child = Start-Process -FilePath ${powershellLiteral(powershell)} -PassThru -WindowStyle Hidden`,
        `Set-Content -LiteralPath ${powershellLiteral(descendantPath)} -Value $Child.Id -Encoding ascii -NoNewline`,
        'while ($true) { Start-Sleep -Seconds 1 }',
      ].join('\r\n'), { flag: 'wx' })
      const supervisorPath = join(updatesDirectory, 'workers', `native-update-supervisor-${privateWorkerId}.exe`)
      const cancelPath = join(updatesDirectory, 'workers', `native-update-cancel-${privateWorkerId}.req`)
      const drainedPath = join(updatesDirectory, 'workers', `native-update-drained-${privateWorkerId}.ack`)
      let workerProcessId = 0
      let descendantProcessId = 0
      let cancellationRecord = ''
      let proofChecks = 0
      const removed: string[] = []
      const dependencies: NativeRollbackWorkerDependencies = {
        ...nativeRollbackWorkerDependencies,
        remove: async (path) => {
          proofChecks += 1
          if (path !== drainedPath) {
            const requestRecord = await readFile(cancelPath, 'utf8')
            if (cancellationRecord === '') cancellationRecord = requestRecord
            else expect(requestRecord).toBe(cancellationRecord)
          }
          const drainedRecord = await readFile(drainedPath, 'utf8')
          expect(drainedRecord).toBe(cancellationRecord)
          expect(await nativeRollbackWorkerDependencies.isExactProcessImageRunning(supervisorPath)).toBe(false)
          expect(processIsAlive(workerProcessId)).toBe(false)
          expect(processIsAlive(descendantProcessId)).toBe(false)
          removed.push(path)
          await nativeRollbackWorkerDependencies.remove(path)
        },
      }
      const result = launchNativeRollbackWorker({
        platform: 'win32', executablePath: process.execPath, workerPath: 'unused.js',
        windowsSupervisorTemplatePath: supervisorTemplate, windowsWorkerTemplatePath: fixtureTemplate,
        plan: nativeFixturePlan(rollbackPath), workerReadyTimeoutMs: 30_000,
        workerId: privateWorkerId, dependencies,
      })
      await Promise.all([waitForPresent(workerProcessIdPath), waitForPresent(descendantPath)])
      workerProcessId = Number.parseInt(await readFile(workerProcessIdPath, 'utf8'), 10)
      descendantProcessId = Number.parseInt(await readFile(descendantPath, 'utf8'), 10)
      await expect(result).rejects.toThrow('did not become ready')
      expect(processIsAlive(descendantProcessId)).toBe(false)
      await waitForAbsent([
        supervisorPath,
        join(updatesDirectory, 'workers', `native-rollback-worker-${privateWorkerId}.ps1`),
        join(updatesDirectory, 'workers', `native-rollback-plan-${privateWorkerId}.json`),
      ])
      expect(removed.at(-1)).toBe(drainedPath)
      expect(proofChecks).toBe(removed.length)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 75_000)

  it('preserves every private input when a pre-existing drained entry blocks native proof', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-real-drained-collision-'))
    const updatesDirectory = join(directory, 'native-updates')
    const workersDirectory = join(updatesDirectory, 'workers')
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const privateWorkerId = 'abababab-abab-4bab-8bab-abababababab'
    const drainedPath = join(workersDirectory, `native-update-drained-${privateWorkerId}.ack`)
    try {
      await mkdir(dirname(rollbackPath), { recursive: true })
      await mkdir(workersDirectory, { recursive: true })
      await writeFile(rollbackPath, 'rollback')
      await writeFile(drainedPath, `${privateWorkerId}:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd\n`, { flag: 'wx' })
      const dependencies: NativeRollbackWorkerDependencies = {
        ...nativeRollbackWorkerDependencies,
      }
      await expect(launchNativeRollbackWorker({
        platform: 'win32', executablePath: process.execPath, workerPath: 'unused.js',
        windowsSupervisorTemplatePath: supervisorTemplate, windowsWorkerTemplatePath: workerTemplate,
        plan: nativeFixturePlan(rollbackPath), workerReadyTimeoutMs: 30_000,
        workerId: privateWorkerId, dependencies,
      })).rejects.toThrow('exact private')
      for (const path of [
        join(workersDirectory, `native-update-supervisor-${privateWorkerId}.exe`),
        join(workersDirectory, `native-rollback-worker-${privateWorkerId}.ps1`),
        join(workersDirectory, `native-rollback-plan-${privateWorkerId}.json`),
        drainedPath,
      ]) await expect(readFile(path)).resolves.toBeInstanceOf(Buffer)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 45_000)

  it('preserves live copied supervisor images and retires them after exact-image exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-real-retirement-'))
    const updatesDirectory = join(directory, 'native-updates')
    const rollbackPath = join(updatesDirectory, 'rollback', 'candidate.exe')
    const ids = [
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ] as const
    const parents: ReturnType<typeof spawn>[] = []
    try {
      await mkdir(dirname(rollbackPath), { recursive: true })
      await writeFile(rollbackPath, 'rollback')
      const dependencies: NativeRollbackWorkerDependencies = {
        ...nativeRollbackWorkerDependencies,
      }
      const launch = async (workerId: string): Promise<void> => {
        const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
        parents.push(parent)
        if (parent.pid === undefined) throw new Error('retirement fixture parent omitted its identity')
        await launchNativeRollbackWorker({
          platform: 'win32', executablePath: process.execPath, workerPath: 'unused.js',
          windowsSupervisorTemplatePath: supervisorTemplate, windowsWorkerTemplatePath: workerTemplate,
          plan: nativeFixturePlan(rollbackPath, parent.pid), workerReadyTimeoutMs: 30_000, workerId, dependencies,
        })
      }
      await launch(ids[0])
      const firstImage = join(updatesDirectory, 'workers', `native-update-supervisor-${ids[0]}.exe`)
      await launch(ids[1])
      await expect(readFile(firstImage)).resolves.toBeInstanceOf(Buffer)
      parents[0]!.kill(); parents[1]!.kill()
      await waitForNoExactProcess(firstImage)
      await launch(ids[2])
      await expect(readFile(firstImage)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const parent of parents) parent.kill()
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    }
  }, 45_000)
})

function nativeFixturePlan(rollbackPath: string, parentProcessId = process.pid) {
  return {
    schemaVersion: 1 as const,
    platform: 'win32' as const,
    parentProcess: { processId: parentProcessId, executablePath: process.execPath, startedBeforeMs: Date.now() + 10_000 },
    applicationPath: process.execPath,
    rollbackArtifactPath: rollbackPath,
    rollbackSha256: createHash('sha256').update('rollback').digest('hex'),
    rollbackFormat: 'nsis' as const,
    healthCheckTimeoutMs: 30_000,
  }
}

function sortedEnvironment(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name.toUpperCase()}=${value}`)
    .sort((left, right) => left.localeCompare(right, 'en'))
}

async function waitForAbsent(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const present = await Promise.all(paths.map(async path => await readFile(path).then(() => true).catch((error: unknown) => {
      if (isTransientReadError(error)) return false
      throw error
    })))
    if (present.every(value => !value)) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error('Windows native rollback worker did not clean its private files')
}

class OutsideJobChild extends EventEmitter implements NativeRollbackWorkerChild {
  private processId: number | undefined
  private poller: NodeJS.Timeout | undefined
  private provider: ReturnType<typeof spawn> | undefined

  get pid(): number | undefined { return this.processId }

  launch(command: string, arguments_: readonly string[]): void {
    const commandLine = [command, ...arguments_].map(quoteWindowsArgument).join(' ')
    const providerCommand = [
      "$ErrorActionPreference = 'Stop'",
      `try { $Result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellLiteral(commandLine)} } } catch { exit 70 }`,
      'if ($Result.ReturnValue -ne 0) { exit 71 }',
      '[Console]::Out.Write([string]$Result.ProcessId)',
    ].join('; ')
    const encoded = Buffer.from(providerCommand, 'utf16le').toString('base64')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    this.provider = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    this.provider.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    this.provider.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    this.provider.once('error', (error) => { this.emit('error', error) })
    this.provider.once('exit', (code) => {
      if (code !== 0) {
        this.emit('error', new Error(`outside-Job process provider failed: ${stderr}`))
        return
      }
      const processId = Number.parseInt(stdout, 10)
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        this.emit('error', new Error('outside-Job process provider omitted its process identity'))
        return
      }
      this.processId = processId
      this.emit('spawn')
      this.poller = setInterval(() => {
        if (this.processId !== undefined && !processIsAlive(this.processId)) {
          clearInterval(this.poller)
          this.poller = undefined
          this.emit('exit', null, null)
        }
      }, 25)
    })
  }

  kill(): boolean {
    if (this.processId === undefined) return false
    spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(this.processId), '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref()
    return true
  }

  unref(): void {
    this.provider?.unref()
    this.poller?.unref()
  }
}

function spawnOutsideCurrentJob(command: string, arguments_: readonly string[]): NativeRollbackWorkerChild {
  const child = new OutsideJobChild()
  child.launch(command, arguments_)
  return child
}

function waitForObservedExit(child: NativeRollbackWorkerChild): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', () => { resolveExit() })
  })
}

function processIsAlive(processId: number): boolean {
  try { process.kill(processId, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function processIsInJob(processId: number): Promise<boolean> {
  const source = [
    'using System;',
    'using System.ComponentModel;',
    'using System.Runtime.InteropServices;',
    'public static class HarnessJobMembershipProbe {',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);',
    '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
    '  public static bool Read(int processId) {',
    '    IntPtr process = OpenProcess(0x1000, false, processId);',
    '    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());',
    '    try { bool result; if (!IsProcessInJob(process, IntPtr.Zero, out result)) throw new Win32Exception(Marshal.GetLastWin32Error()); return result; }',
    '    finally { CloseHandle(process); }',
    '  }',
    '}',
  ].join(' ')
  const command = [
    `$Source = ${powershellLiteral(source)}`,
    'Add-Type -TypeDefinition $Source',
    `if ([HarnessJobMembershipProbe]::Read(${String(processId)})) { [Console]::Out.Write('1') } else { [Console]::Out.Write('0') }`,
  ].join('; ')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return await successfulOutput(probe) === '1'
}

async function waitForNoExactProcess(executablePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const command = [
      '$target = [Environment]::GetEnvironmentVariable("DSH_TEST_PROCESS_IMAGE")',
      'if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($target, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1) { exit 1 }',
    ].join('; ')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, DSH_TEST_PROCESS_IMAGE: executablePath }, windowsHide: true, stdio: 'ignore',
    })
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      probe.once('error', rejectExit); probe.once('exit', resolveExit)
    })
    if (code === 0) return
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 25) })
  }
  throw new Error('private native supervisor did not exit')
}

async function waitForPresent(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await readFile(path).then(() => true).catch(() => false)) return
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 25) })
  }
  throw new Error('fixture did not publish its process identity')
}

async function waitForProcessAbsent(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processIsAlive(processId)) return
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 25) })
  }
  throw new Error('supervisor-owned fixture process survived Job closure')
}

function quoteWindowsArgument(value: string): string {
  if (value.includes('"')) throw new Error('fixture path contains an unsupported quote')
  return `"${value}"`
}

/** @returns whether the worker is still opening or deleting its private readiness marker. */
function isTransientReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM'
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

async function compileHarmlessWindowsExecutable(
  outputPath: string,
  source = 'public static class InstallerSnapshotFixture { public static int Main(string[] arguments) { return 0; } }',
): Promise<void> {
  const command = `Add-Type -TypeDefinition ${powershellLiteral(source)} -OutputAssembly ${powershellLiteral(outputPath)} -OutputType ConsoleApplication`
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await successfulOutput(probe)
}

function successfulOutput(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`PowerShell probe exited with ${String(code)}: ${stderr}`))
    })
  })
}
