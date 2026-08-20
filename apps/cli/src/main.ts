/** Shared command dispatch for the primary Harness CLI and its `dsh` alias. */

import { readFileSync } from 'node:fs'
import type { ProductCommandName } from '@harness-desktop/dsh-app-boot/product-metadata'
import { parseProductArgs, ProductArgumentError, type ProductInvocation } from './args.ts'

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
 * Reserve product invocation dispatch for the Runtime clients supplied by later
 * tasks in this plan.
 * @param invocation - the parsed product command.
 * @returns after accepting the invocation.
 */
function dispatchInvocation(invocation: ProductInvocation): void {
  switch (invocation.mode) {
    case 'interactive':
    case 'run':
    case 'web':
    case 'desktop':
      return
    default:
      invocation satisfies never
      throw new Error(`unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * Parse and dispatch one primary or compatible CLI invocation.
 * @param commandName - the entry name shown in launcher-owned output.
 * @param argv - arguments after the entrypoint.
 * @returns after the selected product command finishes.
 */
export function runCli(
  commandName: CliCommandName,
  argv: readonly string[] = process.argv.slice(2),
): void {
  try {
    dispatchInvocation(parseProductArgs(argv, commandName, readVersion()))
  } catch (error) {
    if (error instanceof ProductArgumentError) {
      process.stderr.write(`${commandName}: ${error.message}\n${error.correction}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
}
