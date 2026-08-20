/** Process-start identity probes used to distinguish a live owner from PID reuse. */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Process identifier paired with an operating-system process-start identity. */
export interface ProcessIdentity {
  readonly pid: number
  readonly startedAt: string
}

/** Result of asking the operating system about one PID. */
export type ProcessIdentityProbeResult =
  | { readonly kind: 'running'; readonly startedAt: string }
  | { readonly kind: 'dead' }
  | { readonly kind: 'unknown' }

/** Injectable process probe used by ownership recovery. */
export interface ProcessIdentityProbe {
  /**
   * Probe one PID without treating permission or platform failures as death.
   * @param pid - positive operating-system process identifier.
   * @returns a start identity, proven death, or an unverifiable result.
   */
  probe(pid: number): Promise<ProcessIdentityProbeResult>
}

/** Default process probe for the current platform. */
export const systemProcessIdentityProbe: ProcessIdentityProbe = {
  async probe(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unknown' }
    if (process.platform === 'linux') return probeLinux(pid)
    if (process.platform === 'win32') return probeWindows(pid)
    return probePs(pid)
  },
}

/**
 * Read the calling process's stable start identity.
 * @param probe - injected platform probe.
 * @returns the PID and platform start identity.
 * @throws when the platform cannot verify the calling process.
 */
export async function currentProcessIdentity(
  probe: ProcessIdentityProbe = systemProcessIdentityProbe,
): Promise<ProcessIdentity> {
  const result = await probe.probe(process.pid)
  if (result.kind !== 'running') {
    throw new Error('host-local-runtime: cannot verify the current process start identity')
  }
  return { pid: process.pid, startedAt: result.startedAt }
}

/** Linux exposes boot-relative start ticks in field 22 of `/proc/<pid>/stat`. */
async function probeLinux(pid: number): Promise<ProcessIdentityProbeResult> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = text.lastIndexOf(')')
    const fields = commandEnd < 0 ? [] : text.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) return { kind: 'unknown' }
    return { kind: 'running', startedAt: `linux:${startTicks}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'dead' }
    return classifyWithSignal(pid)
  }
}

/** Windows exposes a UTC start instant through the built-in process API. */
async function probeWindows(pid: number): Promise<ProcessIdentityProbeResult> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$process = Get-Process -Id $env:HARNESS_RUNTIME_PROBE_PID -ErrorAction Stop',
    "$process.StartTime.ToUniversalTime().ToString('O')",
  ].join('; ')
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, HARNESS_RUNTIME_PROBE_PID: String(pid) },
    })
    const startedAt = stdout.trim()
    return startedAt.length === 0 ? { kind: 'unknown' } : { kind: 'running', startedAt: `win32:${startedAt}` }
  } catch {
    return classifyWithSignal(pid)
  }
}

/** macOS and other supported POSIX hosts expose a stable start string via ps. */
async function probePs(pid: number): Promise<ProcessIdentityProbeResult> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    const startedAt = stdout.trim().replace(/\s+/g, ' ')
    return startedAt.length === 0 ? classifyWithSignal(pid) : { kind: 'running', startedAt: `${process.platform}:${startedAt}` }
  } catch {
    return classifyWithSignal(pid)
  }
}

/** A missing PID is proof of death; every other signal failure is unknown. */
function classifyWithSignal(pid: number): ProcessIdentityProbeResult {
  try {
    process.kill(pid, 0)
    return { kind: 'unknown' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'dead' } : { kind: 'unknown' }
  }
}
