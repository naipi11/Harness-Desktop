/** Process-level observation and failure injection for the Runtime bin tests. */

import fs, { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { Server } from 'node:net'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tracePath = process.env.HARNESS_RUNTIME_TEST_TRACE

function record(event, fields = {}) {
  if (tracePath === undefined) return
  appendFileSync(tracePath, JSON.stringify({ event, ...fields }) + '\n')
}

const originalListen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address()
    if (address !== null && typeof address !== 'string') {
      record('listener-open', { address: address.address, port: address.port })
      if (process.env.HARNESS_RUNTIME_TEST_PROBE_DESCENDANT_ENV === '1') {
        execFile(process.execPath, ['-e', "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? 'absent')"], {
          windowsHide: true,
        }, (error, stdout) => {
          record('descendant-environment', {
            value: error === null ? stdout : `error:${error.name}`,
          })
        })
      }
    }
  })
  this.once('close', () => record('listener-close'))
  return originalListen.apply(this, args)
}

const originalRename = fs.promises.rename.bind(fs.promises)
fs.promises.rename = async (from, to) => {
  const result = await originalRename(from, to)
  if (basename(String(from)) === 'runtime-endpoint.json') record('endpoint-retired')
  return result
}

const originalRm = fs.promises.rm.bind(fs.promises)
fs.promises.rm = async (path, options) => {
  const result = await originalRm(path, options)
  if (basename(String(path)) === 'runtime.lock') record('lock-released')
  return result
}

const originalOpen = fs.promises.open.bind(fs.promises)
fs.promises.open = async (path, ...args) => {
  const handle = await originalOpen(path, ...args)
  if (String(path).includes(`${sep}sessions${sep}`)) {
    const originalSync = handle.sync.bind(handle)
    handle.sync = async () => {
      const result = await originalSync()
      record('session-synced')
      return result
    }
  }
  return handle
}

syncBuiltinESMExports()
process.once('exit', code => record('process-exit', { code }))

const deniedRoot = process.env.HARNESS_RUNTIME_TEST_DENY_WORKSPACE_LIB_ROOT
const observedRoot = deniedRoot ?? process.env.HARNESS_RUNTIME_TEST_OBSERVE_WORKSPACE_ROOT
const failureMatch = process.env.HARNESS_RUNTIME_TEST_FAIL_IMPORT
const failureMessage = process.env.HARNESS_RUNTIME_TEST_FAILURE_MESSAGE
const workspaceSources = deniedRoot === undefined ? new Map() : discoverWorkspaceSources(deniedRoot)

function discoverWorkspaceSources(root) {
  const sources = new Map()
  const packagesRoot = `${root}${sep}packages`
  for (const group of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupPath = `${packagesRoot}${sep}${group.name}`
    for (const entry of fs.readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageRoot = `${groupPath}${sep}${entry.name}`
      const manifestPath = `${packageRoot}${sep}package.json`
      if (!fs.existsSync(manifestPath)) continue
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') sources.set(manifest.name, packageRoot)
    }
  }
  return sources
}

function resolveWorkspaceSource(specifier) {
  if (!specifier.startsWith('@harness-desktop/')) return undefined
  const slash = specifier.indexOf('/', '@harness-desktop/'.length)
  const packageName = slash === -1 ? specifier : specifier.slice(0, slash)
  const packageRoot = workspaceSources.get(packageName)
  if (packageRoot === undefined) return undefined
  const subpath = slash === -1 ? '' : specifier.slice(slash + 1)
  const candidates = subpath === ''
    ? [`${packageRoot}${sep}src${sep}index.ts`]
    : [
        `${packageRoot}${sep}src${sep}${subpath}.ts`,
        `${packageRoot}${sep}src${sep}${subpath}${sep}index.ts`,
      ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

function workspaceLib(url) {
  if (observedRoot === undefined || !url.startsWith('file:')) return false
  const path = fileURLToPath(url)
  if (!isAbsolute(observedRoot)) throw new Error('Runtime workspace observation root must be absolute')
  const local = relative(observedRoot, path)
  if (local.startsWith('..') || isAbsolute(local)) return false
  const segments = local.split(sep)
  return segments[0] === 'packages' && segments.includes('lib')
}

if (observedRoot !== undefined || failureMatch !== undefined) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const sourcePath = resolveWorkspaceSource(specifier)
      if (sourcePath !== undefined) {
        const url = pathToFileURL(sourcePath).href
        record('workspace-source-resolved', { specifier, url })
        return { url, format: 'module', shortCircuit: true }
      }
      const resolved = nextResolve(specifier, context)
      if (resolved.url.startsWith('file:') && observedRoot !== undefined) {
        const path = fileURLToPath(resolved.url)
        const local = relative(observedRoot, path)
        if (!local.startsWith('..') && !isAbsolute(local) && local.split(sep)[0] === 'packages') {
          record('workspace-module', {
            url: resolved.url,
            plane: local.split(sep).includes('lib') ? 'lib' : local.split(sep).includes('src') ? 'src' : 'other',
          })
        }
      }
      if (resolved.url.includes('/packages/host/local-runtime/') && /\/runtime\.(?:ts|js)$/.test(resolved.url)) {
        record('runtime-module', { url: resolved.url })
      }
      if (deniedRoot !== undefined && workspaceLib(resolved.url)) {
        const builtPath = fileURLToPath(resolved.url)
        const sourcePath = builtPath.replace(`${sep}lib${sep}`, `${sep}src${sep}`).replace(/\.js$/, '.ts')
        if (fs.existsSync(sourcePath)) {
          const url = pathToFileURL(sourcePath).href
          record('workspace-lib-redirected', { from: resolved.url, url })
          return { ...resolved, url, format: 'module' }
        }
        record('workspace-lib-denied', { url: resolved.url })
        throw new Error(`Runtime source process resolved a workspace build artifact: ${resolved.url}`)
      }
      if (failureMatch !== undefined && resolved.url.includes(failureMatch)) {
        throw new Error(failureMessage ?? 'injected Runtime provider failure')
      }
      return resolved
    },
  })
}
