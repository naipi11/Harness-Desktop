/** Resolve the auto-selected browse picker from its declaring Web bundle in source e2e. */

import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const modules = new Map([
  ['@harness-desktop/dsh-host-directory-picker-browse', process.env.HARNESS_DESKTOP_BROWSE_HOST],
  ['@harness-desktop/dsh-client-ui-directory-picker-browse', process.env.HARNESS_DESKTOP_BROWSE_CLIENT],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const path = modules.get(specifier)
    if (path !== undefined) return { url: pathToFileURL(path).href, format: 'module', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
