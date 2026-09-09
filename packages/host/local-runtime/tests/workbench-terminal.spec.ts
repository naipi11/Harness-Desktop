/** Real local shell acceptance: no LLM or fixture executor handles the command. */
import { expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import LocalSubprocessRuntime from '@harness-desktop/dsh-subprocess-local'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbenchService } from '../src/workbench.ts'

it('executes local commands and retains directory changes until the shell closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-real-shell-'))
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime).await()
  const service = createWorkbenchService({ workspacePath: () => root, subprocess: ctx.subprocess })
  try {
    await mkdir(join(root, 'nested'))
    const terminal = await service.openTerminal('test', 'workspace')
    const command = process.platform === 'win32'
      ? "Write-Output ('WORKBENCH_' + 'EXECUTED')\r"
      : "printf '%s%s\\n' 'WORKBENCH_' 'EXECUTED'\r"
    await service.writeTerminal('test', terminal.id, command)
    await expect.poll(() => service.readTerminal('test', terminal.id).output, { timeout: 15_000 }).toContain('WORKBENCH_EXECUTED')
    await service.writeTerminal('test', terminal.id, 'cd nested\r')
    await service.writeTerminal('test', terminal.id, process.platform === 'win32' ? '(Get-Location).Path\r' : 'pwd\r')
    await expect.poll(() => service.readTerminal('test', terminal.id).output, { timeout: 15_000 }).toContain(join(root, 'nested'))
    await service.closeOwner('test')
    expect(() => service.readTerminal('test', terminal.id)).toThrow('Unknown terminal')
  } finally {
    await service.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
