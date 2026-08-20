/** Product command parsing for the `harness` command and its `dsh` alias. */

import { Command } from 'commander'
import type { CliCommandName } from './main.ts'

/** Start an interactive terminal session, optionally seeded with one task. */
export interface InteractiveInvocation {
  mode: 'interactive'
  initialTask: string | undefined
}

/** Run one task without the interactive terminal. */
export interface RunInvocation {
  mode: 'run'
  task: string
  json: boolean
}

/** Open, inspect, or release the product Web client. */
export interface WebInvocation {
  mode: 'web'
  open: boolean
  lease: 'none' | 'background'
  operation: 'open' | 'status' | 'stop'
}

/** Activate the installed desktop client. */
export interface DesktopInvocation {
  mode: 'desktop'
}

/** One public Harness Desktop product command. */
export type ProductInvocation = InteractiveInvocation | RunInvocation | WebInvocation | DesktopInvocation

/** A syntax error paired with the product command that corrects it. */
export class ProductArgumentError extends Error {
  /** @param message - the invalid input diagnostic. @param correction - the command syntax that fixes it. */
  constructor(message: string, readonly correction: string) {
    super(message)
    this.name = 'ProductArgumentError'
  }
}

/** Examples shared by the primary binary and its compatibility alias. */
function helpExamples(commandName: CliCommandName): string {
  return `
Examples:
  ${commandName}                                      start an interactive terminal
  ${commandName} "fix the tests"                      start with an initial task
  ${commandName} run "fix the tests" --json           run one task as JSONL
  ${commandName} web --background                      open Web and retain its lease
  ${commandName} web --status                          inspect an existing Runtime
  ${commandName} desktop                               activate the installed desktop app
`
}

/** Product syntax shown alongside every parse error. */
function productSyntax(commandName: CliCommandName): string {
  return `Use \`${commandName} [task]\`, \`${commandName} run <task> [--json]\`, \`${commandName} web\`, or \`${commandName} desktop\`.`
}

/** Build the Commander-owned help and version handler. */
function createProgram(commandName: CliCommandName, version: string): Command {
  return new Command()
    .name(commandName)
    .version(version, '-V, --version', 'output the version number')
    .description(`${commandName}: Harness Desktop product client.`)
    .addHelpText('after', helpExamples(commandName))
}

/** Reject the removed public profile syntax wherever it appears. */
function rejectProfile(argv: readonly string[], commandName: CliCommandName): void {
  if (argv.some(argument => argument === '--profile' || argument.startsWith('--profile='))) {
    throw new ProductArgumentError(
      '--profile is no longer a public product option',
      productSyntax(commandName),
    )
  }
}

/** Resolve the flags and operation under `web`. */
function parseWebArgs(argv: readonly string[], commandName: CliCommandName): WebInvocation {
  let open = true
  let lease: WebInvocation['lease'] = 'none'
  let operation: WebInvocation['operation'] = 'open'
  let operationFlag: '--status' | '--stop' | undefined

  for (const argument of argv) {
    switch (argument) {
      case '--open':
        open = true
        break
      case '--no-open':
        open = false
        break
      case '--daemon':
      case '--background':
        lease = 'background'
        break
      case '--status':
      case '--stop':
        if (operationFlag !== undefined) {
          throw new ProductArgumentError('web accepts only one of --status or --stop', productSyntax(commandName))
        }
        operationFlag = argument
        operation = argument === '--status' ? 'status' : 'stop'
        open = false
        break
      default:
        throw new ProductArgumentError(`web does not accept ${JSON.stringify(argument)}`, productSyntax(commandName))
    }
  }

  if (operation !== 'open' && lease !== 'none') {
    throw new ProductArgumentError(`${operationFlag} cannot be combined with a background lease`, productSyntax(commandName))
  }
  if (operation !== 'open') open = false
  return { mode: 'web', open, lease, operation }
}

/** Resolve the flags and single task under `run`. */
function parseRunArgs(argv: readonly string[], commandName: CliCommandName): RunInvocation {
  let json = false
  const tasks: string[] = []
  for (const argument of argv) {
    if (argument === '--json') {
      if (json) throw new ProductArgumentError('run accepts --json at most once', productSyntax(commandName))
      json = true
    } else if (argument.startsWith('-')) {
      throw new ProductArgumentError(`run does not accept ${JSON.stringify(argument)}`, productSyntax(commandName))
    } else {
      tasks.push(argument)
    }
  }
  const task = tasks.at(0)
  if (tasks.length !== 1 || task === undefined) {
    throw new ProductArgumentError('run needs exactly one task', `Use \`${commandName} run <task> [--json]\`.`)
  }
  return { mode: 'run', task, json }
}

/**
 * Parse one public product command.
 * @param argv - arguments after the executable name.
 * @param commandName - binary name used only in help and corrections.
 * @param version - version shown by Commander for `--version`.
 * @returns the resolved product invocation.
 */
export function parseProductArgs(
  argv: readonly string[],
  commandName: CliCommandName = 'harness',
  version = '0.0.0',
): ProductInvocation {
  const program = createProgram(commandName, version)
  rejectProfile(argv, commandName)
  if (argv.includes('--help') || argv.includes('-h')) program.help()
  if (argv.includes('--version') || argv.includes('-V')) program.parse(['--version'], { from: 'user' })

  const [command, ...rest] = argv
  switch (command) {
    case undefined:
      return { mode: 'interactive', initialTask: undefined }
    case 'run':
      return parseRunArgs(rest, commandName)
    case 'web':
      return parseWebArgs(rest, commandName)
    case 'desktop':
      if (rest.length > 0) {
        throw new ProductArgumentError('desktop takes no arguments', `Use \`${commandName} desktop\`.`)
      }
      return { mode: 'desktop' }
    default:
      if (command.startsWith('-')) {
        throw new ProductArgumentError(`unknown option ${JSON.stringify(command)}`, productSyntax(commandName))
      }
      if (rest.length > 0) {
        throw new ProductArgumentError('interactive mode accepts at most one initial task', `Use \`${commandName} [task]\`.`)
      }
      return { mode: 'interactive', initialTask: command }
  }
}
