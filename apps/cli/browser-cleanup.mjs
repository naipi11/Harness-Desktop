#!/usr/bin/env node
/** Detached expiry owner for one CLI browser bootstrap document. */

import { lstat, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const [documentPath, expiryText, ...extra] = process.argv.slice(2)
const expiresAt = Number(expiryText)
if (documentPath === undefined || extra.length !== 0
  || basename(documentPath) !== 'index.html'
  || !basename(dirname(documentPath)).startsWith('harness-bootstrap-')
  || !Number.isSafeInteger(expiresAt)
  || typeof process.send !== 'function') {
  process.exitCode = 2
} else {
  const timer = setTimeout(() => {
    void removeOwnedBootstrap(documentPath).catch(() => { process.exitCode = 1 })
  }, Math.max(0, expiresAt - Date.now()))
  process.send({ kind: 'ready' }, () => {
    // Ready is committed once delivered; the parent then intentionally disconnects IPC.
  })
}

async function removeOwnedBootstrap(documentPath) {
  const entry = await lstat(documentPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (entry !== undefined) {
    if (entry.isDirectory()) throw new Error('browser bootstrap document path must not be a directory')
    await unlink(documentPath)
  }
  await rmdir(dirname(documentPath)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}
