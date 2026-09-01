/** Detached Electron-as-Node entry point for a verified native rollback. */

import { rm, writeFile } from 'node:fs/promises'

import {
  executeNativeRollback,
  nativeUpdateAppliedPath,
  nativeUpdateRolledBackPath,
  prepareNativeRollbackArtifacts,
  superviseNativeUpdate,
  type PreparedNativeRollbackArtifacts,
} from './native-rollback.ts'
import { parseNativeRollbackWorkerRequest } from './native-rollback-request.ts'

const argument = process.argv[2]
const value = argument === undefined ? undefined : parseArgument(argument)
const request = parseNativeRollbackWorkerRequest(value)

if (request === undefined) {
  process.exitCode = 1
} else {
  let ready = false
  let prepared: PreparedNativeRollbackArtifacts | undefined
  try {
    prepared = await prepareNativeRollbackArtifacts(request.plan)
    await writeFile(request.readyPath, `${request.workerId}\n`, { flag: 'wx', mode: 0o600 })
    ready = true
    if ('journalPath' in request.plan) {
      const outcome = await superviseNativeUpdate(request.plan, undefined, prepared)
      if (outcome === 'applied') {
        await writeFile(nativeUpdateAppliedPath(request.plan.rollbackArtifactPath, request.plan.transactionId), `${request.plan.transactionId}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
      }
    } else {
      const rollbackTransactionId = request.plan.transactionId
      await executeNativeRollback(request.plan, undefined, prepared, rollbackTransactionId === undefined
        ? undefined
        : async () => {
          await writeFile(nativeUpdateRolledBackPath(request.plan.rollbackArtifactPath, rollbackTransactionId), `${rollbackTransactionId}\n`, {
            flag: 'wx',
            mode: 0o600,
          })
        })
    }
  } catch {
    process.exitCode = 1
  } finally {
    if (ready) await rm(request.readyPath, { force: true })
    if (prepared !== undefined) {
      await prepared.dispose().catch(() => {
        // A terminal native decision is already durable; stale private snapshots are harmless cleanup residue.
      })
    }
  }
}

function parseArgument(argument: string): unknown {
  try { return JSON.parse(argument) as unknown } catch { return undefined }
}
