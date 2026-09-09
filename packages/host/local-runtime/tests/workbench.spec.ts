/** Authenticated workbench lists actual workspace files, not picker-only directory rows. */
import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@harness-desktop/cordis'
import LocalSubprocessRuntime from '@harness-desktop/dsh-subprocess-local'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchService } from '../src/workbench.ts'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('lists files and directories in a registered workspace and refuses parent traversal', async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-files-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, '说明.txt'), 'fixture')
  const service = createWorkbenchService({
    workspacePath: id => id === 'workspace' ? root : undefined,
  })
  const listing = await service.listFiles('workspace', '')
  expect(listing.entries).toEqual([
    { name: 'src', path: join(root, 'src'), directory: 'src', kind: 'directory' },
    { name: '说明.txt', path: join(root, '说明.txt'), directory: '说明.txt', kind: 'file' },
  ])
  await expect(service.listFiles('missing', '')).rejects.toThrow('Unknown workspace')
  await expect(service.listFiles('workspace', '..')).rejects.toThrow('outside the workspace')
  await service.close()
})

it('skips broken links while listing valid files and rejecting outside links', async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-broken-link-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(join(workspace, 'visible.txt'), 'fixture')
  await symlink(join(root, 'missing'), join(workspace, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(outside, join(workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const service = createWorkbenchService({ workspacePath: () => workspace })
  try {
    expect((await service.listFiles('workspace', '')).entries.map(item => item.name)).toEqual(['visible.txt'])
  } finally { await service.close() }
})

it('sends commands to a persistent owned shell, never a model prompt', async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-shell-'))
  const output = new PassThrough()
  const input = new PassThrough()
  let written = ''
  input.on('data', (chunk) => { written += String(chunk) })
  const terminate = vi.fn(() => { output.end() })
  const spawn = vi.fn(() => ({
    pid: 42, stdin: input, stdout: output, stderr: new PassThrough(), terminate,
    collected: {}, waitForExit: async () => true,
    done: new Promise<never>(() => {}),
  }))
  const service = createWorkbenchService({
    workspacePath: id => id === 'workspace' ? root : undefined,
    subprocess: { spawn, resolveExecutable: async () => 'powershell.exe' },
  })
  const terminal = await service.openTerminal('owner', 'workspace')
  expect(spawn).toHaveBeenCalledOnce()
  await service.writeTerminal('owner', terminal.id, 'Get-Location\r')
  expect(written).toContain('Get-Location\n')
  await expect(service.writeTerminal('other', terminal.id, 'bad')).rejects.toThrow('Unknown terminal')
  output.write('shell-output\r\n')
  expect(service.readTerminal('owner', terminal.id).output).toContain('shell-output')
  await service.closeOwner('owner')
  expect(terminate).toHaveBeenCalledOnce()
  expect(() => service.readTerminal('owner', terminal.id)).toThrow('Unknown terminal')
})

it('releases failed shell startups without unhandled pipe errors or consuming terminal capacity', async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-start-failure-'))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime).await()
  const service = createWorkbenchService({
    workspacePath: () => root,
    subprocess: { spawn: ctx.subprocess.spawn.bind(ctx.subprocess), resolveExecutable: async () => join(root!, 'missing.exe') },
    maxTerminals: 1,
  })
  try {
    await expect(service.openTerminal('test', 'workspace')).rejects.toThrow()
    await expect(service.openTerminal('test', 'workspace')).rejects.not.toThrow('Terminal limit reached')
  } finally { await service.close(); await ctx.fiber.dispose() }
})

it('contains pipe errors when a write races shell exit', async () => {
  let fail = false
  const input = new Writable({ write(_chunk, _encoding, callback) { callback(fail ? new Error('EPIPE') : null) } })
  const service = createWorkbenchService({ workspacePath: () => process.cwd(), subprocess: {
    resolveExecutable: async () => 'shell',
    spawn: () => ({ pid: 1, stdin: input, stdout: new PassThrough(), stderr: new PassThrough(),
      collected: {}, terminate() {}, waitForExit: async () => true, done: new Promise<never>(() => {}) }),
  } })
  try {
    const shell = await service.openTerminal('owner', 'workspace')
    expect(() => input.emit('error', new Error('EPIPE'))).not.toThrow()
    fail = true
    await expect(service.writeTerminal('owner', shell.id, 'command\n')).rejects.toThrow()
  } finally { await service.close() }
})

it('reclaims exited shell capacity before restarting the same workspace', async () => {
  const outcomes: ReturnType<typeof Promise.withResolvers<{ exitCode: number; signal: null; timedOut: boolean; aborted: boolean }>>[] = []
  const service = createWorkbenchService({ workspacePath: () => process.cwd(), maxTerminals: 1, subprocess: {
    resolveExecutable: async () => 'shell',
    spawn: () => {
      const done = Promise.withResolvers<{ exitCode: number; signal: null; timedOut: boolean; aborted: boolean }>()
      outcomes.push(done)
      return { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        collected: {}, terminate() {}, waitForExit: async () => true, done: done.promise }
    },
  } })
  try {
    for (let index = 0; index < 3; index += 1) {
      const shell = await service.openTerminal('owner', 'workspace')
      outcomes[index]!.resolve({ exitCode: 0, signal: null, timedOut: false, aborted: false })
      await outcomes[index]!.promise
      await Promise.resolve()
      expect(service.readTerminal('owner', shell.id).exited).toBe(true)
    }
  } finally { await service.close() }
})
