/** Shared command dispatch for the primary Harness CLI and its `dsh` alias. */

import { readFileSync } from 'node:fs'
import type { ProductCommandName } from '@harness-desktop/dsh-app-boot/product-metadata'
import { createRuntimeConnector, type RuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import { parseProductArgs, ProductArgumentError, type ProductInvocation } from './args.ts'
import { createProcessTerminalIO, runTerminalInvocation, type TerminalIO } from './terminal-client.ts'

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
 * Dispatch terminal invocations to the shared Runtime client. Later product
 * tasks own the Web and Desktop branches.
 * @param invocation - the parsed product command.
 * @param io - terminal resources owned by this process.
 * @param connector - token-encapsulating shared Runtime connector.
 * @returns the exact public CLI exit code.
 */
export function dispatchInvocation(
  invocation: ProductInvocation,
  io: TerminalIO,
  connector: RuntimeConnector,
): Promise<number> {
  switch (invocation.mode) {
    case 'interactive':
    case 'run':
      return runTerminalInvocation(invocation, io, connector)
    case 'web':
    case 'desktop':
      return Promise.resolve(0)
    default:
      invocation satisfies never
      throw new Error(`unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * Parse and dispatch one primary or compatible CLI invocation.
 * @param commandName - the entry name shown in launcher-owned output.
 * @param argv - arguments after the entrypoint.
 * @param dependencies - optional Runtime and terminal boundaries for tests.
 * @returns the exact public CLI exit code after the command settles.
 */
export function runCli(
  commandName: CliCommandName,
  argv: readonly string[] = process.argv.slice(2),
  dependencies: { readonly io?: TerminalIO; readonly connector?: RuntimeConnector } = {},
): Promise<number> {
  const io = dependencies.io ?? createProcessTerminalIO()
  const connector = dependencies.connector ?? createRuntimeConnector()
  try {
    return dispatchInvocation(parseProductArgs(argv, commandName, readVersion()), io, connector)
  } catch (error) {
    if (error instanceof ProductArgumentError) {
      io.stderr.write(`${commandName}: ${error.message}\n${error.correction}\n`)
      return Promise.resolve(2)
    }
    throw error
  }
}
