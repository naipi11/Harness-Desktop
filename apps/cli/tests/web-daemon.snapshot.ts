/** Keyless transcript for daemon help, which must remain parent-owned. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harnessSourceBin = join(repoRoot, 'apps/cli/src/bin.ts')
const harnessBuiltBin = join(repoRoot, 'apps/cli/lib/bin.js')

/** Run the source tree by default and the built artifact when snapshot mode asks for it. */
function cliCommand(): { args: string[]; executable: string } {
  if (process.env.DSH_EXAMPLE_MODE === 'lib') return { executable: process.execPath, args: [harnessBuiltBin] }
  return { executable: process.execPath, args: ['--import', 'tsx/esm', harnessSourceBin] }
}

describe('web daemon help snapshot', () => {
  it('shows both detached aliases without launching a child', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-daemon-help-'))
    try {
      const command = cliCommand()
      const result = await execa(command.executable, [...command.args, 'web', '--daemon', '--help'], {
        env: { ...process.env, HARNESS_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
        extendEnv: false,
        input: '',
        reject: false,
      })
      const transcript = { code: result.exitCode ?? -1, stderr: result.stderr, stdout: result.stdout }
      expect(transcript).toMatchInlineSnapshot(`
        {
          "code": 0,
          "stderr": "",
          "stdout": "Usage: dsh --profile web [options]

        Serve the Harness Desktop browser UI.

        Options:
          --host <host>                  bind host
          --port <port>                  listen port; pass 0 to let the OS pick a free
                                         one
          --trusted-host <authority...>  extra authority the /api browser-trust fence
                                         accepts (host or host:port; repeatable)
          -h, --help                     show this help

        Examples:
          dsh --profile web                          serve on the composed host and port
          dsh --profile web --port 8080              serve on another port
          dsh web --daemon                           start the web server in the background
          dsh web --background                       alias for --daemon
        ",
        }
      `)
      expect(transcript.stdout).toContain('dsh web --daemon')
      expect(transcript.stdout).toContain('dsh web --background')
      expect(transcript.stdout).not.toContain('dsh web: started detached process')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
