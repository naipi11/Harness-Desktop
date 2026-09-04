import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyNodeRuntimeArchive,
  type NodeRuntimeChecksumAllowlist,
} from './verify-node-runtime-archive.ts'

const roots: string[] = []
const candidateHelper = resolve(import.meta.dirname, 'select-release-candidate-operation.mjs')
const candidateEnvironmentNames = [
  'SIGN_WINDOWS',
  'NOTARIZE_MACOS',
  'SIGN_UPDATE_MANIFESTS',
  'PUBLISH_NPM',
  'CREATE_GITHUB_RELEASE',
] as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('verifyNodeRuntimeArchive', () => {
  it('accepts only the selected repository-allowlisted filename and SHA-256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-node-runtime-verify-'))
    roots.push(root)
    const filename = 'node-fixture.zip'
    const bytes = Buffer.from('fixture node runtime')
    await writeFile(join(root, filename), bytes)
    const allowlist: NodeRuntimeChecksumAllowlist = {
      '24.19.0': { win32: { x64: { filename, sha256: createHash('sha256').update(bytes).digest('hex') } } },
    }
    const input = {
      runtimeRoot: root,
      filename,
      version: '24.19.0',
      runnerOS: 'Windows',
      runnerArch: 'X64',
    } as const

    await expect(verifyNodeRuntimeArchive(input, allowlist)).resolves.toBeUndefined()
    await expect(verifyNodeRuntimeArchive({ ...input, filename: 'other.zip' }, allowlist)).rejects.toThrow(
      'filename does not match',
    )
    await writeFile(join(root, filename), 'tampered runtime')
    await expect(verifyNodeRuntimeArchive(input, allowlist)).rejects.toThrow('checksum mismatch')
  })
})

describe('selectReleaseCandidateOperation', () => {
  it.each(candidateEnvironmentNames)('selects the sole true %s operation', async (selected) => {
    const environment = Object.fromEntries(candidateEnvironmentNames.map(name => [
      name,
      name === selected ? 'true' : 'false',
    ]))
    const result = await execa(process.execPath, [candidateHelper], { env: environment, extendEnv: false })
    expect(result.stdout).toContain('this workflow performs no release action')
  })

  it('rejects zero or multiple selections', async () => {
    const none = Object.fromEntries(candidateEnvironmentNames.map(name => [name, 'false']))
    await expect(execa(process.execPath, [candidateHelper], { env: none, extendEnv: false })).rejects.toThrow('exactly one')
    await expect(execa(process.execPath, [candidateHelper], {
      env: { ...none, SIGN_WINDOWS: 'true', PUBLISH_NPM: 'true' },
      extendEnv: false,
    })).rejects.toThrow('exactly one')
  })

  it('parses only explicit true and false workflow environment values', async () => {
    const environment = Object.fromEntries(candidateEnvironmentNames.map(name => [name, 'false']))
    await expect(execa(process.execPath, [candidateHelper], {
      env: { ...environment, SIGN_WINDOWS: '1' },
      extendEnv: false,
    })).rejects.toThrow('SIGN_WINDOWS must be true or false')
  })
})
