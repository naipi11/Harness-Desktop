/** Shared command dispatch for the primary Harness CLI and its `dsh` alias. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProductCommandName } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  createRuntimeConnector,
  type BrowserHandoffTransport,
  type RuntimeConnector,
} from '@harness-desktop/dsh-host-local-runtime'
import { parseProductArgs, ProductArgumentError, type ProductInvocation } from './args.ts'
import { createBrowserHandoffTransport } from './browser.ts'
import {
  createInstalledDesktopActivator,
  runDesktopInvocation,
  type InstalledDesktopActivator,
} from './desktop.ts'
import { createProcessTerminalIO, runTerminalInvocation, type TerminalIO } from './terminal-client.ts'
import { runWebInvocation } from './web-daemon.ts'
import { runUpdateInvocation } from './update.ts'

/** Command names accepted by the shared CLI implementation. */
export type CliCommandName = ProductCommandName

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * Dispatch terminal and Web invocations to independent shared-Runtime attachments.
 * @param invocation - the parsed product command.
 * @param io - terminal resources owned by this process.
 * @param connector - token-encapsulating shared Runtime connector.
 * @param opener - launcher-owned browser handoff transport.
 * @param activator - installed Desktop application activator.
 * @returns the exact public CLI exit code.
 */
export function dispatchInvocation(
  invocation: ProductInvocation,
  io: TerminalIO,
  connector: RuntimeConnector,
  opener: BrowserHandoffTransport,
  activator: InstalledDesktopActivator,
): Promise<number> {
  switch (invocation.mode) {
    case 'interactive':
    case 'run':
      return runTerminalInvocation(invocation, io, connector)
    case 'web':
      return runWebInvocation(invocation, connector, opener, io)
    case 'desktop':
      return runDesktopInvocation(activator, io)
    case 'update':
      return runUpdateInvocation({ entryPath: fileURLToPath(import.meta.url), version: readVersion(), stdout: io.stdout })
        .then(result => settleUpdateResult(result, io))
    default:
      invocation satisfies never
      throw new Error(`unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * Parse and dispatch one primary or compatible CLI invocation.
 * @param commandName - the entry name shown in launcher-owned output.
 * @param argv - arguments after the entrypoint.
 * @param dependencies - optional Runtime, browser, Desktop, and terminal boundaries for tests.
 * @returns the exact public CLI exit code after the command settles.
 */
export function runCli(
  commandName: CliCommandName,
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    readonly io?: TerminalIO
    readonly connector?: RuntimeConnector
    readonly opener?: BrowserHandoffTransport
    readonly activator?: InstalledDesktopActivator
  } = {},
): Promise<number> {
  const io = dependencies.io ?? createProcessTerminalIO()
  try {
    const invocation = parseProductArgs(argv, commandName, readVersion())
    if (invocation.mode === 'update') {
      return runUpdateInvocation({ entryPath: fileURLToPath(import.meta.url), version: readVersion(), stdout: io.stdout })
        .then(result => settleUpdateResult(result, io))
    }
    const connector = dependencies.connector ?? createRuntimeConnector()
    const opener = dependencies.opener ?? createBrowserHandoffTransport()
    const activator = dependencies.activator ?? createInstalledDesktopActivator()
    return dispatchInvocation(invocation, io, connector, opener, activator)
  } catch (error) {
    if (error instanceof ProductArgumentError) {
      io.stderr.write(`${commandName}: ${error.message}\n${error.correction}\n`)
      return Promise.resolve(2)
    }
    throw error
  }
}

/** Render only stable update settlements after the transaction has erased raw release inputs. */
function settleUpdateResult(
  result: Awaited<ReturnType<typeof runUpdateInvocation>>,
  io: TerminalIO,
): number {
  switch (result.kind) {
    case 'managed-by-npm':
      return 0
    case 'up-to-date':
      io.stdout.write('No update available.\n')
      return 0
    case 'staged':
      io.stdout.write('CLI update staged.\n')
      return 0
    case 'applied':
      io.stdout.write('CLI update applied.\n')
      return 0
    case 'rolled-back':
      io.stderr.write('CLI update rolled back.\n')
      return 1
    case 'failed':
      io.stderr.write('CLI update failed.\n')
      return 1
    default:
      result satisfies never
      throw new Error('unhandled update result')
  }
}
