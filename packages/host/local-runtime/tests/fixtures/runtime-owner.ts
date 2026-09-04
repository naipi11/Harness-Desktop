import { acquireRuntimeLock } from '../../src/instance-lock.ts'
import { resolveHarnessHome } from '../../src/data-root.ts'

const home = resolveHarnessHome({ env: process.env, homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '' }).path
const result = await acquireRuntimeLock(home)
if (result.kind !== 'acquired') throw new Error(`fixture could not acquire Runtime lock: ${result.kind}`)
const lock = result.lock

process.stdout.write('READY\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => { void releaseAndExit() })

async function releaseAndExit(): Promise<never> {
  await lock.release()
  process.exit(0)
}
