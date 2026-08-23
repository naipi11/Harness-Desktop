/** Node-only built CLI launcher for cross-client Runtime acceptance. */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import type {
  CrossClientAppContext,
  CrossClientCliAdapter,
  CrossClientCliResult,
} from '@harness-desktop/dsh-cross-client-runtime'

const CLI_TIMEOUT_MS = 45_000

class BuiltCliAdapterError extends Error {}

/** One strictly parsed CLI JSONL object with optional event fields used by app acceptance. */
export interface CliJsonLine extends Record<string, unknown> {
  readonly kind?: unknown
  readonly sessionId?: unknown
  readonly text?: unknown
}

/**
 * Parse CLI JSONL without accepting a missing record; only one final line terminator is ignored.
 * @param stdout - complete captured CLI stdout.
 * @returns decoded object records in their original order.
 * @throws when a physical record is blank, malformed, or not a JSON object.
 */
export function parseCliJsonLines(stdout: string): readonly CliJsonLine[] {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) throw new Error(`CLI stdout line ${String(index + 1)} is blank`)
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError('record must be an object')
      }
      return parsed as CliJsonLine
    } catch (error) {
      throw new Error(`CLI stdout line ${String(index + 1)} is not a JSON object`, { cause: error })
    }
  })
}

function builtEntry(command: 'harness' | 'dsh'): string {
  return fileURLToPath(new URL(command === 'harness' ? '../../lib/bin.js' : '../../lib/dsh-bin.js', import.meta.url))
}

function isolatedCliEnvironment(context: CrossClientAppContext): NodeJS.ProcessEnv {
  const temporary = join(context.platformHome, 'tmp')
  const roots: NodeJS.ProcessEnv = {
    HARNESS_HOME: context.home,
    HOME: context.platformHome,
    USERPROFILE: context.platformHome,
    APPDATA: join(context.platformHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(context.platformHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(context.platformHome, '.config'),
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
  }
  if (process.platform !== 'win32') {
    return { ...roots, PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: temporary }
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return {
    ...roots,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    Path: [
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      systemRoot,
    ].join(';'),
    TEMP: temporary,
    TMP: temporary,
  }
}

/**
 * Create an adapter for one physical built CLI entry under plain current Node.
 * @param command - exact product bin to execute.
 * @returns a bounded adapter that preserves captured stdout and stderr byte-for-byte as strings.
 * @throws when the selected build is absent or the child cannot settle with an exit code.
 */
export function createBuiltCliAdapter(command: 'harness' | 'dsh'): CrossClientCliAdapter {
  const entry = builtEntry(command)
  return {
    async run(args, context): Promise<CrossClientCliResult> {
      try {
        await access(entry, constants.R_OK)
      } catch (_missingBuiltEntry) {
        throw new BuiltCliAdapterError('built CLI acceptance requires the selected app entry; run pnpm run build first')
      }

      let result
      try {
        result = await execa(process.execPath, [entry, ...args], {
          cwd: context.workspace,
          env: isolatedCliEnvironment(context),
          extendEnv: false,
          input: '',
          timeout: CLI_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          reject: false,
          stripFinalNewline: false,
          windowsHide: true,
        })
      } catch (_launchFailure) {
        throw new BuiltCliAdapterError('built CLI acceptance could not execute the selected app entry')
      }
      if (result.timedOut) throw new BuiltCliAdapterError('built CLI acceptance exceeded its process deadline')
      if (result.exitCode === undefined) {
        throw new BuiltCliAdapterError('built CLI acceptance ended without a checked exit code')
      }
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
  }
}
