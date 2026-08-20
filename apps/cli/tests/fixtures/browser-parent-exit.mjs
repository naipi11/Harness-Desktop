#!/usr/bin/env node
/** Natural-exit fixture for the built production browser transport. */

const [browserModuleUrl, expiryText, ...extra] = process.argv.slice(2)
const expiresAt = Number(expiryText)
if (browserModuleUrl === undefined || extra.length !== 0 || !Number.isSafeInteger(expiresAt)) {
  throw new Error('browser parent fixture needs one module URL and expiry')
}

const { createBrowserHandoffTransport } = await import(browserModuleUrl)
let dispatchedUrl = ''
await createBrowserHandoffTransport({
  dispatch: async (url) => { dispatchedUrl = url },
}).open({
  origin: 'http://127.0.0.1:43123',
  handoff: {
    id: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
    expiresAt,
  },
})
process.stdout.write(dispatchedUrl)
