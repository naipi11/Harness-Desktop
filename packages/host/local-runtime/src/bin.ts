#!/usr/bin/env node
/** Private Runtime-process entry used by future local launchers. */

import { once } from 'node:events'
import { createLocalRuntimePlugin } from './data-root.ts'
import { startCanonicalRuntime } from './runtime.ts'

let restoreOutput = (): void => {}
try {
  restoreOutput = silenceStartupOutput()
  const harnessHome = createLocalRuntimePlugin({ env: process.env })
  const runtime = await startCanonicalRuntime({
    harnessHome,
    idleTimeoutMs: 60_000,
  })
  restoreOutput()
  process.stderr.write(`harness-runtime: ready ${JSON.stringify(runtime.status())}\n`)
  if (process.env.HARNESS_RUNTIME_TEST_MODE === 'stdin-lifetime') {
    process.stdin.resume()
    await once(process.stdin, 'end')
    await runtime.dispose()
  }
} catch {
  restoreOutput()
  process.stderr.write('harness-runtime: startup failed\n')
  process.exitCode = 1
}

/** Suppress partial Loader output until startup either commits or rejects. */
function silenceStartupOutput(): () => void {
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  let restored = false
  return () => {
    if (restored) return
    restored = true
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
}
