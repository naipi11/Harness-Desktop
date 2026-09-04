import { createHash, generateKeyPairSync } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as tar from 'tar'
import {
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpointKey,
  standaloneCliUpdateTarget,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'
import {
  digestStandaloneTree,
  nativeModuleLoadPaths,
  verifyCliStandalone,
  verifyInHostileAmbientLoaderEnvironment,
  verifyLinuxNativeClosure,
  verifyStandaloneReleasePolicy,
} from './verify-cli-standalone.ts'

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

describe('standalone CLI native module verification', () => {
  it('probes the Koffi package loader once while retaining both Linux libc variants in the archive closure', () => {
    const root = 'payload/current/cli/package/node_modules'

    expect(nativeModuleLoadPaths([
      `${root}/@img/sharp-linux-x64/lib/sharp-linux-x64.node`,
      `${root}/@koromix/koffi-linux-x64/linux_x64/koffi.node`,
      `${root}/@koromix/koffi-linux-x64/musl_x64/koffi.node`,
      `${root}/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node`,
    ])).toEqual([
      `${root}/@img/sharp-linux-x64/lib/sharp-linux-x64.node`,
      `${root}/koffi`,
      `${root}/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node`,
    ])
  })

  it('requires Linux node-pty and both Koffi libc variants from an extracted archive', () => {
    const root = 'payload/current/cli/package/node_modules'
    expect(verifyLinuxNativeClosure('linux', 'x64', [
      `${root}/koffi/index.js`,
      `${root}/@koromix/koffi-linux-x64/linux_x64/koffi.node`,
    ])).toEqual([
      'standalone CLI: Linux node-pty closure omits a linux-x64 pty.node binding',
      'standalone CLI: Linux Koffi native closure omits musl_x64/koffi.node',
    ])
  })

  it('accepts the complete Linux node-pty and Koffi native closure', () => {
    const root = 'payload/current/cli/package/node_modules'
    expect(verifyLinuxNativeClosure('linux', 'x64', [
      `${root}/node-pty/prebuilds/linux-x64/pty.node`,
      `${root}/koffi/index.js`,
      `${root}/@koromix/koffi-linux-x64/linux_x64/koffi.node`,
      `${root}/@koromix/koffi-linux-x64/musl_x64/koffi.node`,
    ])).toEqual([])
  })
})

describe('standalone CLI release policy verification', () => {
  it('requires a rollback endpoint for the CLI version embedded in the archive', async () => {
    const extraction = await mkdtemp(join(tmpdir(), 'harness-cli-policy-'))
    const archiveDirectory = await mkdtemp(join(tmpdir(), 'harness-cli-policy-archive-'))
    const target = standaloneCliUpdateTarget(process.platform, process.arch)
    if (target === undefined) throw new Error('test host does not support standalone CLI archives')
    const origin = 'https://updates.example.invalid'
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const policy = {
      schemaVersion: 3,
      applicationId: productMetadata.appId,
      trust: { allowedOrigins: [origin], publicKeys: { release: publicKey } },
      healthCheckTimeoutMs: 120_000,
      nativeWorkerReadyTimeoutMs: 300_000,
      manifestEndpoints: {
        [releaseManifestEndpointKey(target)]: `${origin}/candidate.json`,
      },
      rollbackManifestEndpoints: {
        [releaseRollbackManifestEndpointKey({ ...target, currentVersion: process.versions.node })]: `${origin}/rollback-node-version.json`,
      },
    }
    try {
      await writeFile(join(extraction, 'update-policy.json'), `${JSON.stringify(policy)}\n`)
      const nodePath = target.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node'
      const launchers = target.platform === 'win32' ? ['harness.cmd', 'dsh.cmd'] : ['harness', 'dsh']
      const node = join(extraction, ...nodePath.split('/'))
      await mkdir(dirname(node), { recursive: true })
      await copyFile(process.execPath, node)
      await chmod(node, 0o755)
      for (const launcher of launchers) {
        const path = join(extraction, launcher)
        await writeFile(path, target.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n')
        await chmod(path, 0o755)
      }
      const files = await digestStandaloneTree(extraction, new Set(['manifest.json']))
      await writeFile(join(extraction, 'manifest.json'), `${JSON.stringify({
        version: 2,
        target: { platform: target.platform, arch: target.arch },
        node: { version: process.versions.node, filename: 'node', sha256: '0'.repeat(64), executable: nodePath },
        cli: { name: '@harness-desktop/cli', version: '1.0.0' },
        launchers,
        executablePaths: [nodePath, ...launchers].toSorted(),
        nativeModules: [],
        files,
      })}\n`)
      const members = [...Object.keys(files), 'manifest.json'].toSorted()
      const stem = `harness-cli-1.0.0-${target.platform}-${target.arch}`
      const archiveName = `${stem}.${target.format}`
      const archivePath = join(archiveDirectory, archiveName)
      if (target.format === 'zip') {
        const entries = Object.fromEntries(await Promise.all(members.map(async path => [
          path, await readFile(join(extraction, ...path.split('/'))),
        ] as const)))
        await writeFile(archivePath, zipSync(entries))
      } else {
        await tar.c({ cwd: extraction, file: archivePath, gzip: true, portable: true, strict: true }, members)
      }
      const archiveBytes = await readFile(archivePath)
      await writeFile(join(archiveDirectory, `${stem}.sha256`), [
        `${createHash('sha256').update(archiveBytes).digest('hex')}  ${archiveName}`,
        '',
      ].join('\n'))

      await expect(verifyCliStandalone({
        platform: target.platform,
        arch: target.arch,
        nodeVersion: process.versions.node,
        cliVersion: '1.0.0',
        archiveDirectory,
      })).resolves.toContain('standalone CLI: release update policy omits this archive rollback target')

      policy.rollbackManifestEndpoints = {
        [releaseRollbackManifestEndpointKey({ ...target, currentVersion: '1.0.0' })]: `${origin}/rollback-1.0.0.json`,
      }
      await writeFile(join(extraction, 'update-policy.json'), `${JSON.stringify(policy)}\n`)
      await expect(verifyStandaloneReleasePolicy(extraction, {
        platform: target.platform,
        arch: target.arch,
        nodeVersion: process.versions.node,
        cliVersion: '1.0.0',
        archiveDirectory,
      }, '1.0.0')).resolves.toEqual([])
    } finally {
      await Promise.all([
        rm(extraction, { recursive: true, force: true }),
        rm(archiveDirectory, { recursive: true, force: true }),
      ])
    }
  }, 30_000)
})
