/** Windows Credential Manager adapter; local-machine persistence, never a plaintext vault. */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { PlatformCredentialAdapter } from './index.ts'
import type { CredentialRef, ResolvedCredential } from '@harness-desktop/dsh-credentials'

/** WinCred's maximum generic blob size, fixed by the Windows API. */
const MAX_BLOB_BYTES = 5 * 512
const NOT_FOUND = 1168

async function loadBindings() {
  const koffi = (await import('koffi')).default
  const credential = koffi.struct({
    Flags: 'uint32', Type: 'uint32', TargetName: 'str16', Comment: 'str16',
    LastWritten: koffi.array('uint32', 2), CredentialBlobSize: 'uint32', CredentialBlob: 'void *',
    Persist: 'uint32', AttributeCount: 'uint32', Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  })
  const advapi = koffi.load('Advapi32.dll')
  const kernel = koffi.load('Kernel32.dll')
  return {
    koffi, credential,
    read: advapi.func('__stdcall', 'CredReadW', 'bool', ['str16', 'uint32', 'uint32', 'void *']),
    write: advapi.func('__stdcall', 'CredWriteW', 'bool', [koffi.pointer(credential), 'uint32']),
    remove: advapi.func('__stdcall', 'CredDeleteW', 'bool', ['str16', 'uint32', 'uint32']),
    free: advapi.func('__stdcall', 'CredFree', 'void', ['void *']),
    error: kernel.func('__stdcall', 'GetLastError', 'uint32', []),
  }
}
let bindings: ReturnType<typeof loadBindings> | undefined
const failure = (): Error => new Error('Windows credential storage is unavailable or rejected the operation')

/**
 * Create a writable OS adapter, with environment values as an explicit fallback.
 * @param home - existing Harness home; its canonical path namespaces OS entries.
 * @param fallback - read-only launch environment.
 * @returns adapter whose mutable bytes never enter files or diagnostics.
 */
export function createWindowsCredentialAdapter(home: string, fallback: PlatformCredentialAdapter): PlatformCredentialAdapter {
  let namespace: Promise<string> | undefined
  const target = async (ref: CredentialRef): Promise<string> => {
    namespace ??= realpath(home).then(path => createHash('sha256').update(path.toLowerCase()).digest('hex'))
    return `HarnessDesktop/credentials/v1/${await namespace}/${createHash('sha256').update(ref).digest('hex')}`
  }
  const load = (): ReturnType<typeof loadBindings> => bindings ??= loadBindings()
  return {
    writable: true,
    async resolve(ref): Promise<ResolvedCredential | undefined> {
      let value: string | undefined
      try {
        const api = await load()
        const name = await target(ref)
        const out = Buffer.alloc(api.koffi.sizeof('void *'))
        if (!api.read(name, 1, 0, out)) {
          if (api.error() !== NOT_FOUND) throw failure()
        } else {
          const pointer: unknown = api.koffi.decode(out, 'void *')
          try {
            const record = api.koffi.decode(pointer, api.credential) as { CredentialBlobSize: number; CredentialBlob: unknown }
            if (record.CredentialBlobSize < 1 || record.CredentialBlobSize > MAX_BLOB_BYTES) throw failure()
            const bytes = Buffer.from(api.koffi.decode(record.CredentialBlob, 'uint8', record.CredentialBlobSize) as Uint8Array)
            try { value = bytes.toString('utf8') } finally { bytes.fill(0) }
          } finally { api.free(pointer) }
        }
      } catch { throw failure() }
      return value === undefined ? fallback.resolve(ref) : { value, source: 'platform' }
    },
    async set(ref, value): Promise<void> {
      const bytes = Buffer.from(value, 'utf8')
      try {
        if (bytes.length > MAX_BLOB_BYTES) throw new Error('Credential is too large for Windows storage')
        if (bytes.length === 0) throw new Error('Credential must not be empty')
        const api = await load()
        const name = await target(ref)
        const ok: unknown = api.write({
          Flags: 0, Type: 1, TargetName: name, Comment: null, LastWritten: [0, 0],
          CredentialBlobSize: bytes.length, CredentialBlob: bytes, Persist: 2,
          AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: null,
        }, 0)
        if (!ok) throw failure()
      } catch {
        if (bytes.length > MAX_BLOB_BYTES) throw new Error('Credential is too large for Windows storage')
        throw failure()
      } finally { bytes.fill(0) }
    },
    async unset(ref): Promise<void> {
      try {
        const api = await load()
        const name = await target(ref)
        if (!api.remove(name, 1, 0) && api.error() !== NOT_FOUND) throw failure()
      } catch { throw failure() }
    },
  }
}
