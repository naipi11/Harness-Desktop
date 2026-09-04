/** Keyless transcript for side-effect-free Web Runtime status discovery. */

import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import {
  DesktopNotInstalledError,
  runDesktopInvocation,
  type DesktopDiagnosticId,
} from '../src/desktop.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harnessSourceBin = join(repoRoot, 'apps/cli/src/bin.ts')
const harnessBuiltBin = join(repoRoot, 'apps/cli/lib/bin.js')

/** Run the source tree by default and the built artifact when snapshot mode asks for it. */
function cliCommand(): { args: string[]; executable: string } {
  if (process.env.DSH_EXAMPLE_MODE === 'lib') return { executable: process.execPath, args: [harnessBuiltBin] }
  return { executable: process.execPath, args: ['--import', 'tsx/esm', harnessSourceBin] }
}

describe('Web Runtime status snapshot', () => {
  it('reports absence without creating the selected Harness home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-web-status-'))
    const home = join(root, 'missing-home')
    try {
      const command = cliCommand()
      const result = await execa(command.executable, [...command.args, 'web', '--status'], {
        env: { ...process.env, HARNESS_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
        extendEnv: false,
        input: '',
        reject: false,
      })
      const transcript = {
        code: result.exitCode ?? -1,
        stderr: result.stderr.replace(/Diagnostic: [0-9a-f-]+/u, 'Diagnostic: <diagnostic-id>'),
        stdout: result.stdout,
      }
      expect(transcript).toMatchInlineSnapshot(`
        {
          "code": 3,
          "stderr": "The local Harness Runtime is not running.
        Start Harness again, or retry after the existing Runtime becomes available.
        Diagnostic: <diagnostic-id>",
          "stdout": "",
        }
      `)
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders an installed-Desktop absence without private activation details', async () => {
    const stderr = new PassThrough()
    let errors = ''
    stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
    const code = await runDesktopInvocation({
      activate: async () => {
        throw new DesktopNotInstalledError(
          'Install Harness Desktop with the Linux Deb package from GitHub Releases.',
          '11111111-1111-4111-8111-111111111111' as DesktopDiagnosticId,
        )
      },
    }, { stderr })

    expect({ code, stderr: errors, stdout: '' }).toMatchInlineSnapshot(`
      {
        "code": 3,
        "stderr": "Harness Desktop is not installed.
      Install Harness Desktop with the Linux Deb package from GitHub Releases.
      Diagnostic: 11111111-1111-4111-8111-111111111111
      ",
        "stdout": "",
      }
    `)
  })
})
