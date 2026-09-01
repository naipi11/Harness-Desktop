import { describe, expect, it } from 'vitest'
import {
  resolveSelfUpdateInstallation,
  type SelfUpdateInstallationOperations,
  type SelfUpdateInstallationOptions,
} from '../src/main/update/self-installation.ts'

const macExecutable = '/Applications/Harness Desktop.app/Contents/MacOS/harness-desktop'
const appImage = '/opt/Harness Desktop.AppImage'
const appDirectory = '/tmp/.mount_Harness'
const appImageExecutable = '/tmp/.mount_Harness/usr/bin/harness-desktop'
const linuxStartStat = `42 (harness) ${['R', ...Array.from({ length: 18 }, () => '0'), '22'].join(' ')}\n`

function operations(overrides: Partial<SelfUpdateInstallationOperations> = {}): SelfUpdateInstallationOperations {
  return {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpath: async path => path,
    mkdtemp: async prefix => `${prefix}probe`,
    rename: async () => {},
    remove: async () => {},
    readText: async path => path === '/proc/self/stat'
      ? linuxStartStat
      : `42 21 0:38 / ${appDirectory} rw - fuse.AppImage /dev/fuse rw\n`,
    ...overrides,
  }
}

function installation(platform: NodeJS.Platform, values: Partial<SelfUpdateInstallationOptions> = {}): SelfUpdateInstallationOptions {
  return {
    platform,
    executablePath: values.executablePath ?? macExecutable,
    appImagePath: values.appImagePath,
    appDirectory: values.appDirectory,
  }
}

describe('resolveSelfUpdateInstallation', () => {
  it('lets Windows and a writable installed macOS application own canonical replacement paths', async () => {
    await expect(resolveSelfUpdateInstallation(installation('win32'), operations())).resolves.toEqual({
      applicationPath: macExecutable,
    })
    await expect(resolveSelfUpdateInstallation(installation('darwin'), operations())).resolves.toEqual({
      applicationPath: macExecutable,
    })
  })

  it('rejects a read-only macOS application location before a worker can request Main shutdown', async () => {
    await expect(resolveSelfUpdateInstallation(installation('darwin'), operations({
      mkdtemp: async () => { throw new Error('read-only volume') },
    }))).resolves.toBeUndefined()
  })

  it('permits Linux automatic replacement only for a writable mounted AppImage runtime', async () => {
    await expect(resolveSelfUpdateInstallation(installation('linux', {
      executablePath: appImageExecutable,
      appImagePath: appImage,
      appDirectory,
    }), operations())).resolves.toEqual({
      applicationPath: appImageExecutable,
      appImagePath: appImage,
    })
  })

  it('rejects missing or relative AppImage launch data', async () => {
    await expect(resolveSelfUpdateInstallation(installation('linux'), operations())).resolves.toBeUndefined()
    await expect(resolveSelfUpdateInstallation(installation('linux', {
      executablePath: appImageExecutable,
      appImagePath: 'Harness Desktop.AppImage',
      appDirectory,
    }), operations())).resolves.toBeUndefined()
  })

  it('rejects a Debian executable with spoofed AppImage environment paths', async () => {
    await expect(resolveSelfUpdateInstallation(installation('linux', {
      executablePath: '/opt/Harness Desktop/harness-desktop',
      appImagePath: appImage,
      appDirectory,
    }), operations())).resolves.toBeUndefined()
  })

  it('rejects an AppImage whose target volume cannot create a private sibling probe', async () => {
    await expect(resolveSelfUpdateInstallation(installation('linux', {
      executablePath: appImageExecutable,
      appImagePath: appImage,
      appDirectory,
    }), operations({
      mkdtemp: async () => { throw new Error('read-only parent') },
    }))).resolves.toBeUndefined()
  })

  it('rejects an installation parent that cannot atomically rename a private sibling probe', async () => {
    await expect(resolveSelfUpdateInstallation(installation('darwin'), operations({
      rename: async () => { throw new Error('rename denied') },
    }))).resolves.toBeUndefined()
  })
})
