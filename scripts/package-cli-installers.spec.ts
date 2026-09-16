import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDebianTree, innoScript, packageName } from './package-cli-installers.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('CLI installer packaging', () => {
  it('uses stable package names', () => {
    expect(packageName('deb', '0.1.7')).toBe('dsh_0.1.7_amd64.deb')
    expect(packageName('deb', '0.1.7', 'arm64')).toBe('dsh_0.1.7_arm64.deb')
    expect(packageName('windows', '0.1.7')).toBe('dsh-0.1.7-win-x64-setup.exe')
  })

  it('creates a Debian tree with executable dsh and valid metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-'))
    roots.push(root)
    const input = join(root, 'dsh.exe')
    writeFileSync(input, 'binary')
    const tree = join(root, 'tree')
    await createDebianTree(input, '0.1.7', tree)
    expect(readFileSync(join(tree, 'DEBIAN', 'control'), 'utf8')).toContain('Architecture: amd64')
    expect(readFileSync(join(tree, 'usr', 'bin', 'dsh'), 'utf8')).toBe('binary')
    expect(existsSync(join(tree, 'DEBIAN', 'conffiles'))).toBe(true)

    const armTree = join(root, 'arm-tree')
    await createDebianTree(input, '0.1.7', armTree, 'arm64')
    expect(readFileSync(join(armTree, 'DEBIAN', 'control'), 'utf8')).toContain('Architecture: arm64')
  })

  it('emits an Inno Setup script with install and uninstall structure', () => {
    const script = innoScript('C:/input/dsh.exe', '0.1.7', 'C:/output')
    expect(script).toContain('AppId={{D8A4A2A7-7BD5-4D34-BA3D-D2F1B4A4D5C1}}')
    expect(script).toContain('Source: "C:/input/dsh.exe"; DestDir: "{app}"')
    expect(script).toContain('DestName: "dsh.exe"')
    expect(script).toContain('[UninstallDelete]')
    expect(script).toContain('Type: filesandordirs')
  })
})
