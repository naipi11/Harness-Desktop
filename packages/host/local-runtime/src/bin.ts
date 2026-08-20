/** Private Runtime-process entry used by future local launchers. */

import { createLocalRuntimePlugin } from './data-root.ts'
import { startCanonicalRuntime } from './runtime.ts'

const harnessHome = createLocalRuntimePlugin({ env: process.env })
try {
  const runtime = await startCanonicalRuntime({
    harnessHome,
    idleTimeoutMs: 60_000,
  })
  process.stderr.write(`harness-runtime: ready ${JSON.stringify(runtime.status())}\n`)
} catch {
  process.stderr.write('harness-runtime: startup failed\n')
  process.exitCode = 1
}
