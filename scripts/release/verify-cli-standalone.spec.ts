import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { verifyInHostileAmbientLoaderEnvironment } from './verify-cli-standalone.ts'

const ambientEnvironmentKeys = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'TSX_TSCONFIG_PATH',
  'TS_NODE_PROJECT',
] as const

describe('standalone CLI hostile ambient loader verification', () => {
  it('reports a child that inherits the verifier parent environment', async () => {
    const originalEnvironment = Object.fromEntries(
      ambientEnvironmentKeys.map(name => [name, process.env[name]]),
    )

    const violations = await verifyInHostileAmbientLoaderEnvironment(async () => {
      const child = await execa(process.execPath, ['--eval', 'process.stdout.write("child ran")'], {
        reject: false,
      })
      expect(child).toMatchObject({ exitCode: 0, stdout: 'child ran' })
      return []
    })

    expect(violations).toEqual([
      'standalone CLI: archive child inherited hostile ambient Node loader',
    ])
    expect(Object.fromEntries(
      ambientEnvironmentKeys.map(name => [name, process.env[name]]),
    )).toEqual(originalEnvironment)
  })

  it('restores the parent environment and probe directory when verification rejects', async () => {
    const originalEnvironment = Object.fromEntries(
      ambientEnvironmentKeys.map(name => [name, process.env[name]]),
    )
    let hostileRoot: string | undefined

    await expect(verifyInHostileAmbientLoaderEnvironment(async () => {
      const loaderOption = process.env.NODE_OPTIONS
      expect(loaderOption).toMatch(/^--import=file:/u)
      if (loaderOption === undefined) throw new Error('hostile loader option is absent')
      hostileRoot = dirname(fileURLToPath(loaderOption.slice('--import='.length)))
      throw new Error('archive verification rejected')
    })).rejects.toThrow('archive verification rejected')

    expect(Object.fromEntries(
      ambientEnvironmentKeys.map(name => [name, process.env[name]]),
    )).toEqual(originalEnvironment)
    if (hostileRoot === undefined) throw new Error('hostile loader root was not recorded')
    await expect(access(hostileRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
