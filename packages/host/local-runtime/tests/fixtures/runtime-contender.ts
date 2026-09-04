import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveHarnessHome } from '../../src/data-root.ts'

const label = process.env.HARNESS_RUNTIME_CONTENDER_LABEL
if (label === undefined) throw new Error('HARNESS_RUNTIME_CONTENDER_LABEL is required')
const home = resolveHarnessHome({ env: process.env, homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '' }).path
const lockPath = join(home, 'runtime.lock')
const commands = createInterface({ input: process.stdin })
const mutablePromises = fs.promises as typeof fs.promises & { rename: typeof fs.promises.rename }
const originalRename = mutablePromises.rename.bind(mutablePromises)
let continueRename!: () => void
let continueRelease!: () => void
const renameAllowed = new Promise<void>((resolve) => { continueRename = resolve })
const releaseAllowed = new Promise<void>((resolve) => { continueRelease = resolve })

commands.on('line', (line) => {
  if (line === 'RENAME') continueRename()
  if (line === 'RELEASE') continueRelease()
})

mutablePromises.rename = async (source, target) => {
  if (String(source) === lockPath) {
    process.stdout.write(`RENAME_READY ${label}\n`)
    await renameAllowed
  }
  await originalRename(source, target)
}
syncBuiltinESMExports()

try {
  const {
    acquireRuntimeLockWithDependencies,
  } = await import('../../src/instance-lock.ts')
  const result = await acquireRuntimeLockWithDependencies(home, {
    identity: { pid: process.pid, startedAt: `contender-${label}` },
    processProbe: {
      async probe(pid) {
        if (pid === 4242) return { kind: 'dead' }
        const record = JSON.parse(await fs.promises.readFile(lockPath, 'utf8')) as { pid: number; startedAt: string }
        return record.pid === pid ? { kind: 'running', startedAt: record.startedAt } : { kind: 'unknown' }
      },
    },
    privatePathPolicy: {
      async protectDirectory() { return { kind: 'current-user-only', platform: 'test', mode: 0o700 } },
      async protectFile() { return { kind: 'current-user-only', platform: 'test', mode: 0o600 } },
      async verifyFile() { return { kind: 'current-user-only', platform: 'test', mode: 0o600 } },
    },
  })
  mutablePromises.rename = originalRename
  syncBuiltinESMExports()
  process.stdout.write(`RESULT ${label} ${result.kind}\n`)
  if (result.kind === 'acquired') {
    await releaseAllowed
    await result.lock.release()
  }
  process.exit(0)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}
