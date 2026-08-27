/** Bounded subprocess execution for installed-artifact test cleanup. */

import { execa } from 'execa'

const defaultCleanupCommandTimeoutMs = 10_000
const cleanupCommandForceKillAfterMs = 1_000

interface BoundedTestCommandOptions {
  readonly env?: Readonly<Partial<Record<string, string>>>
  readonly failure: string
  readonly timeoutMs?: number
}

interface BoundedTestCommandResult {
  readonly exitCode: number | undefined
  readonly stdout: string
}

/**
 * Run one test-owned cleanup command and return only fields its caller validates.
 * @param executable - exact command selected by the test fixture.
 * @param arguments_ - exact arguments for that command.
 * @param options - bounded execution and redacted timeout failure.
 * @returns exit status and standard output after the child settles.
 */
export async function runBoundedTestCommand(
  executable: string,
  arguments_: readonly string[],
  options: BoundedTestCommandOptions,
): Promise<BoundedTestCommandResult> {
  const result = await execa(executable, [...arguments_], {
    ...(options.env === undefined ? {} : { env: options.env }),
    timeout: options.timeoutMs ?? defaultCleanupCommandTimeoutMs,
    killSignal: 'SIGKILL',
    forceKillAfterDelay: cleanupCommandForceKillAfterMs,
    reject: false,
    windowsHide: true,
  })
  if (result.timedOut) throw new Error(`${options.failure} timed out`)
  return { exitCode: result.exitCode, stdout: result.stdout }
}

/**
 * Return exact Windows process identifiers through one bounded WMI query.
 * @param executablePath - exact installed executable selected by the fixture.
 * @param environment - constrained environment inherited by the provider.
 * @param dependencies - system tool and command runner owned by the test.
 * @returns positive safe process identifiers reported for the exact executable.
 */
export async function exactWindowsTestProcessIds(
  executablePath: string,
  environment: Readonly<Partial<Record<string, string>>>,
  dependencies: WindowsTestProcessCleanupDependencies = windowsTestProcessCleanupDependencies,
): Promise<readonly number[]> {
  const powerShell = dependencies.systemTool('WindowsPowerShell\\v1.0\\powershell.exe')
  const result = await dependencies.run(powerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$target = [Environment]::GetEnvironmentVariable("DSH_NATIVE_UPDATE_E2E_EXECUTABLE"); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { $_.ProcessId }',
  ], {
    env: { ...environment, DSH_NATIVE_UPDATE_E2E_EXECUTABLE: executablePath },
    failure: 'native update e2e: process inspection',
  })
  if (result.exitCode !== 0) throw new Error('native update e2e: process inspection failed')
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const value = Number(line.trim())
    return Number.isSafeInteger(value) && value > 0 ? [value] : []
  })
}

/** Test-owned dependencies for exact Windows process cleanup. */
export interface WindowsTestProcessCleanupDependencies {
  readonly run: typeof runBoundedTestCommand
  systemTool(relativePath: string): string
}

const windowsTestProcessCleanupDependencies: WindowsTestProcessCleanupDependencies = {
  run: runBoundedTestCommand,
  systemTool(relativePath) {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined || systemRoot === '') throw new Error('native update e2e: Windows system root is unavailable')
    return `${systemRoot}\\System32\\${relativePath}`
  },
}
