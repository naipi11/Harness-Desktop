import { appendFileSync } from 'node:fs'

const trace = process.env.HARNESS_RUNTIME_EXEC_ARGV_TRACE
if (trace !== undefined) appendFileSync(trace, `${String(process.pid)}\n`)
