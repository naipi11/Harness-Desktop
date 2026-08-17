/**
 * Shared command dispatch for the primary Harness CLI and its `dsh` alias.
 * @module @harness-desktop/cli/main
 */

import { readFileSync } from 'node:fs'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import type { ProductCommandName } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { parseDshArgs, type DshInvocation } from './args.ts'

/** Command names accepted by the shared CLI implementation. */
export type CliCommandName = ProductCommandName

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/** Dispatch one parsed invocation while retaining the compatibility data namespace. */
async function dispatchInvocation(commandName: CliCommandName, invocation: DshInvocation): Promise<void> {
  switch (invocation.mode) {
    case 'profile': {
      const web = invocation.profile === 'web'
        ? (await import('./web-daemon.ts')).resolveWebDaemonInvocation(invocation.args)
        : undefined
      if (web?.detached) {
        const { launchWebDaemon } = await import('./web-daemon.ts')
        const launched = await launchWebDaemon({
          runtimeArgs: process.execArgv,
          entry: process.argv[1] ?? '',
          patches: invocation.patches,
          args: web.args,
        })
        process.stdout.write(`${commandName} web: started detached process ${String(launched.pid)}; log: ${launched.logPath}\n`)
        break
      }
      const { runProfile } = await import('./profile-boot.ts')
      await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: web?.args ?? invocation.args,
      })
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(runPlugin(commandName, invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`${commandName}: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * Parse and dispatch one primary or compatible CLI invocation.
 * @param commandName - the entry name shown in launcher-owned output.
 * @param argv - arguments after the entrypoint.
 * @returns after the selected profile, plugin command, or config dump finishes.
 */
export async function runCli(
  commandName: CliCommandName,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const invocation = parseDshArgs(argv, readVersion(), commandName)
  await dispatchInvocation(commandName, invocation)
}
