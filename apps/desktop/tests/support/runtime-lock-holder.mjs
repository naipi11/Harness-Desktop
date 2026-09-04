/** Hold the real Runtime ownership lock without publishing an endpoint. */

import { once } from 'node:events'
import {
  acquireRuntimeLock,
  createLocalRuntimePlugin,
} from '@harness-desktop/dsh-host-local-runtime'

const harnessHome = createLocalRuntimePlugin({ env: process.env })
const result = await acquireRuntimeLock(harnessHome.home)
if (result.kind !== 'acquired') throw new Error(`Desktop lock holder failed: ${result.kind}`)
process.stderr.write('desktop-runtime-lock-holder: ready\n')
process.stdin.resume()
await once(process.stdin, 'end')
await result.lock.release()
