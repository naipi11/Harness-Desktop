/** Atomic single-owner lock for one Harness home. */

import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessHome } from './data-root.ts'
import {
  currentProcessIdentity,
  systemProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from './process-identity.ts'

const execFileAsync = promisify(execFile)

/** Runtime ownership record beneath `HARNESS_HOME`. */
export const RUNTIME_LOCK_FILENAME = 'runtime.lock'

/** Evidence that a path is restricted by its platform policy. */
export type PrivatePathEvidence =
  | { readonly kind: 'current-user-only'; readonly platform: 'win32'; readonly verified: true; readonly userSid: string }
  | { readonly kind: 'current-user-only'; readonly platform: string; readonly mode: number }

/** Injectable owner-only path policy used before private records are published. */
export interface PrivatePathPolicy {
  /** @param path - directory that contains private Runtime files. @returns verified platform evidence. */
  protectDirectory(path: string): Promise<PrivatePathEvidence>
  /** @param path - unpublished private file. @returns verified platform evidence. */
  protectFile(path: string): Promise<PrivatePathEvidence>
  /** @param path - published private file. @returns verified platform evidence. */
  verifyFile(path: string): Promise<PrivatePathEvidence>
}

/** Acquired ownership resource; release removes only this owner's unchanged record. */
export interface RuntimeLock {
  readonly process: ProcessIdentity
  /** Release this lock after all Runtime-owned state is quiescent. */
  release(): Promise<void>
}

/** Result of an atomic ownership attempt. */
export type RuntimeLockResult =
  | { readonly kind: 'acquired'; readonly lock: RuntimeLock; readonly recoveredStaleOwner: boolean }
  | { readonly kind: 'owned-by-live-runtime'; readonly process: ProcessIdentity }
  | { readonly kind: 'ownership-unverified' }

/** Dependencies injectable at process and filesystem policy boundaries. */
export interface AcquireRuntimeLockDependencies {
  readonly identity?: ProcessIdentity
  readonly processProbe?: ProcessIdentityProbe
  readonly privatePathPolicy?: PrivatePathPolicy
}

/** Default platform policy used for lock and endpoint files. */
export const runtimePrivatePathPolicy: PrivatePathPolicy = {
  async protectDirectory(path) {
    if (process.platform === 'win32') return protectWindowsPath(path, 'directory')
    await chmod(path, 0o700)
    return verifyPosixMode(path, 0o700)
  },
  async protectFile(path) {
    if (process.platform === 'win32') return protectWindowsPath(path, 'file')
    await chmod(path, 0o600)
    return verifyPosixMode(path, 0o600)
  },
  async verifyFile(path) {
    if (process.platform === 'win32') return verifyWindowsPath(path, 'file')
    return verifyPosixMode(path, 0o600)
  },
}

/**
 * Exclusively acquire ownership of one Harness home before stateful services mount.
 * An existing record is removed only when its PID is absent or its start identity
 * differs from the process currently using that PID. Probe failures preserve it.
 * @param home - resolved Harness data root.
 * @returns the acquired resource or a typed non-owner result.
 */
export async function acquireRuntimeLock(home: HarnessHome): Promise<RuntimeLockResult> {
  return acquireRuntimeLockWithDependencies(home)
}

/**
 * Acquire ownership with injected process and permission dependencies.
 * This module-private testing entry is excluded from the package exports.
 * @param home - resolved Harness data root.
 * @param dependencies - injected identity, process probe, and private-path policy.
 * @returns the acquired resource or a typed non-owner result.
 */
export async function acquireRuntimeLockWithDependencies(
  home: HarnessHome,
  dependencies: AcquireRuntimeLockDependencies = {},
): Promise<RuntimeLockResult> {
  const probe = dependencies.processProbe ?? systemProcessIdentityProbe
  const identity = dependencies.identity ?? await currentProcessIdentity(probe)
  const policy = dependencies.privatePathPolicy ?? runtimePrivatePathPolicy
  const lockPath = join(home, RUNTIME_LOCK_FILENAME)
  const content = serializeIdentity(identity)
  let recoveredStaleOwner = false

  await mkdir(home, { recursive: true, mode: 0o700 })
  await policy.protectDirectory(home)

  for (;;) {
    let created = false
    try {
      await writeFile(lockPath, content, { flag: 'wx', mode: 0o600 })
      created = true
    } catch (error) {
      if (!isEEXIST(error)) throw error
    }
    if (created) {
      try {
        await policy.protectFile(lockPath)
      } catch (error) {
        try {
          await rm(lockPath)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'host-local-runtime: lock protection and rollback both failed')
        }
        throw error
      }
      return {
        kind: 'acquired',
        recoveredStaleOwner,
        lock: createRuntimeLock(lockPath, identity, content),
      }
    }

    const observed = await readLockRecord(lockPath)
    if (observed === undefined) continue
    const process = parseIdentity(observed)
    if (process === undefined) return { kind: 'ownership-unverified' }
    const status = await probe.probe(process.pid)
    if (status.kind === 'unknown') return { kind: 'ownership-unverified' }
    if (status.kind === 'running' && status.startedAt === process.startedAt) {
      return { kind: 'owned-by-live-runtime', process }
    }

    const confirmed = await readLockRecord(lockPath)
    if (confirmed !== observed) continue
    const stalePath = `${lockPath}.stale-${identity.pid}-${Date.now()}`
    try {
      await rename(lockPath, stalePath)
    } catch (error) {
      if (isENOENT(error)) continue
      throw error
    }
    await rm(stalePath, { force: true })
    recoveredStaleOwner = true
  }
}

/** Create an idempotent release that cannot delete a replacement owner's record. */
function createRuntimeLock(path: string, processIdentity: ProcessIdentity, content: string): RuntimeLock {
  let released = false
  return Object.freeze({
    process: processIdentity,
    async release() {
      if (released) return
      const observed = await readLockRecord(path)
      if (observed !== undefined && observed !== content) {
        throw new Error('host-local-runtime: Runtime lock ownership changed before release')
      }
      if (observed === content) await rm(path)
      released = true
    },
  })
}

/** Parse only the exact durable process identity fields. */
function parseIdentity(text: string): ProcessIdentity | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined
    if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) return undefined
    return { pid: record.pid as number, startedAt: record.startedAt }
  } catch {
    return undefined
  }
}

function serializeIdentity(identity: ProcessIdentity): string {
  return JSON.stringify({ pid: identity.pid, startedAt: identity.startedAt }) + '\n'
}

async function readLockRecord(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function verifyPosixMode(path: string, expected: number): Promise<PrivatePathEvidence> {
  const mode = (await stat(path)).mode & 0o777
  if (mode !== expected) throw new Error(`host-local-runtime: ${path} must have mode ${expected.toString(8)}`)
  return { kind: 'current-user-only', platform: process.platform, mode }
}

/** Replace inherited Windows access with one full-control ACE for the current user. */
async function protectWindowsPath(path: string, kind: 'directory' | 'file'): Promise<PrivatePathEvidence> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$acl=if($env:HARNESS_RUNTIME_PRIVATE_KIND-eq'directory'){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}",
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true,$false)',
    "$inherit=if($env:HARNESS_RUNTIME_PRIVATE_KIND-eq'directory'){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}",
    '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($rule)',
    "if($env:HARNESS_RUNTIME_PRIVATE_KIND-eq'directory'){[IO.Directory]::SetAccessControl($env:HARNESS_RUNTIME_PRIVATE_PATH,$acl)}else{[IO.File]::SetAccessControl($env:HARNESS_RUNTIME_PRIVATE_PATH,$acl)}",
  ].join('; ')
  await runPowerShell(script, path, kind)
  return verifyWindowsPath(path, kind)
}

/** Verify that the protected DACL contains only the current user's allow ACE. */
async function verifyWindowsPath(path: string, kind: 'directory' | 'file'): Promise<PrivatePathEvidence> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$acl=if($env:HARNESS_RUNTIME_PRIVATE_KIND-eq'directory'){[IO.Directory]::GetAccessControl($env:HARNESS_RUNTIME_PRIVATE_PATH)}else{[IO.File]::GetAccessControl($env:HARNESS_RUNTIME_PRIVATE_PATH)}",
    '$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value',
    '$trustees=@($acl.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Select-Object -Unique)',
    "if($owner-ne$sid-or$acl.AreAccessRulesProtected-ne$true-or$trustees.Count-ne1-or$trustees[0]-ne$sid){throw 'path is not restricted to the current user'}",
    '$sid',
  ].join('; ')
  const userSid = (await runPowerShell(script, path, kind)).trim()
  if (userSid.length === 0) throw new Error(`host-local-runtime: Windows ACL verification returned no user SID for ${path}`)
  return { kind: 'current-user-only', platform: 'win32', verified: true, userSid }
}

async function runPowerShell(script: string, path: string, kind: 'directory' | 'file'): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_RUNTIME_PRIVATE_PATH: path,
      HARNESS_RUNTIME_PRIVATE_KIND: kind,
    },
  })
  return stdout
}
