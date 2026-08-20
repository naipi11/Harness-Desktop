/** Private Runtime-process entry used by future local launchers. */

import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { createLocalRuntimePlugin } from './data-root.ts'
import { startRuntime } from './runtime.ts'

const harnessHome = createLocalRuntimePlugin({ env: process.env })
const runtime = await startRuntime({
  harnessHome,
  idleTimeoutMs: 60_000,
  async boot() {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    return ctx
  },
})
process.stderr.write(`harness-runtime: ready ${JSON.stringify(runtime.status())}\n`)
