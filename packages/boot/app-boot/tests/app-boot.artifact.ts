/** Built-only regression for every Harness-home consumer in the shipped base profile. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const builtDshBin = join(repository, 'apps/cli/lib/dsh-bin.js')
const requiredBaseRows = [
  'timer',
  'settings',
  'credentials',
  'session-persistence-jsonl',
  'attachment-local',
  'shell-env',
  'agent-instructions',
  'skill-filesystem',
]

interface Evidence {
  readonly activeRows: string[]
  readonly attachmentRoot: string
  readonly harnessHome: string
  readonly providerHome: string
  readonly sessionPath: string | undefined
  readonly settingsPath: string
  readonly shellEnvironment: Record<string, string>
  readonly skillNames: string[]
}

/** Enumerate every file below a directory using paths relative to that directory. */
function filesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1))
}

describe('built base-profile durable writers', () => {
  it('writes every durable artifact and reads every host-local source through one resolved Harness home', async () => {
    expect(existsSync(builtDshBin), `missing built CLI ${builtDshBin}; run pnpm run build:lib:host`).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'dsh-base-artifact-'))
    const home = join(root, 'resolved-home')
    const profileDir = join(home, 'profiles', 'artifact-root')
    const evidencePath = join(root, 'evidence.json')
    const failurePath = join(root, 'failure.txt')
    const probePath = join(profileDir, 'base-root-probe.mjs')
    try {
      mkdirSync(profileDir, { recursive: true })
      mkdirSync(join(home, 'skills', 'artifact-home-skill'), { recursive: true })
      writeFileSync(join(home, 'skills', 'artifact-home-skill', 'SKILL.md'), [
        '---',
        'name: artifact-home-skill',
        'description: Proves the shipped skill provider reads the resolved Harness home.',
        '---',
        'Artifact root evidence.',
        '',
      ].join('\n'))
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-artifact-root',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@harness-desktop/dsh-base'] } },
      }, undefined, 2) + '\n')
      writeFileSync(join(profileDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: base-root-probe',
        `      name: ${pathToFileURL(probePath).href}`,
        '',
      ].join('\n'))
      writeFileSync(probePath, [
        "import { writeFileSync } from 'node:fs'",
        "export const name = 'base-root-probe'",
        "export const inject = ['settings', 'credentials', 'sessionPersistence', 'attachments', 'skills', 'shellEnv']",
        'export function apply(ctx) {',
        '  void ctx.loader.await().then(async () => {',
        '    try {',
        '      await ctx.settings.prepareDocument()',
        "      await ctx.credentials.set('HARNESS_ARTIFACT_TEST', 'present')",
        '      await ctx.attachments.saveImage({',
        "        data: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')),",
        "        mediaType: 'image/png',",
        '      })',
        "      const meta = { version: 0, id: 'artifact-root', createdAt: 1, cwd: process.cwd() }",
        '      await ctx.sessionPersistence.create(meta)',
        '      await ctx.sessionPersistence.append(meta.id, [',
        "        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },",
        "        { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },",
        '      ])',
        "      const { getOrCreateAnonymousUserId } = await import('@harness-desktop/dsh-anonymous-user-id')",
        '      getOrCreateAnonymousUserId(ctx.harnessHomeProvider.home)',
        '      const skills = await ctx.skills.list({ cwd: process.cwd() })',
        '      const evidence = {',
        '        activeRows: [...ctx.loader.entries()].filter(entry => entry.fiber !== undefined).map(entry => entry.options.id),',
        '        attachmentRoot: ctx.attachments.root,',
        '        harnessHome: ctx.harnessHome,',
        '        providerHome: ctx.harnessHomeProvider.home,',
        '        sessionPath: ctx.sessionPersistence.locate(meta)?.path,',
        '        settingsPath: ctx.settings.documentPath,',
        '        shellEnvironment: ctx.shellEnv.collect({}),',
        '        skillNames: skills.map(skill => skill.name),',
        '      }',
        '      writeFileSync(process.env.ARTIFACT_EVIDENCE, JSON.stringify(evidence))',
        "      const exit = ctx.get('appExit')",
        "      if (typeof exit !== 'function') throw new Error('base-root-probe: appExit is unavailable')",
        '      exit(0)',
        '    } catch (error) {',
        '      writeFileSync(process.env.ARTIFACT_FAILURE, error instanceof Error ? error.stack ?? error.message : String(error))',
        "      const exit = ctx.get('appExit')",
        "      if (typeof exit === 'function') exit(1)",
        '    }',
        '  })',
        '}',
        '',
      ].join('\n'))

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HARNESS_HOME: home,
        DSH_AGENTS_HOME: join(root, 'agents-home'),
        DSH_TELEMETRY_DISABLED: '1',
        ARTIFACT_EVIDENCE: evidencePath,
        ARTIFACT_FAILURE: failurePath,
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      }
      delete env.DSH_HOME
      delete env.DEEPSEEK_API_KEY
      delete env.DEEPSEEK_BASE_URL
      const result = await execa(process.execPath, [builtDshBin, '--profile', 'artifact-root'], {
        cwd: root,
        env,
        input: '',
        reject: false,
        timeout: 60_000,
      })

      expect(result.exitCode, [result.stderr, existsSync(failurePath) ? readFileSync(failurePath, 'utf8') : ''].filter(Boolean).join('\n')).toBe(0)
      expect(result.stderr).toBe('')
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence
      expect(evidence.harnessHome).toBe(home)
      expect(evidence.providerHome).toBe(home)
      expect(evidence.shellEnvironment).toMatchObject({ HARNESS_HOME: home, DSH_SHELL: '1' })
      expect(evidence.shellEnvironment).not.toHaveProperty('DSH_HOME')
      expect(evidence.settingsPath).toBe(join(home, 'settings.yaml'))
      expect(evidence.attachmentRoot).toBe(join(home, 'attachments', 'v1'))
      expect(evidence.sessionPath).toContain(join(home, 'sessions'))
      expect(evidence.skillNames).toContain('artifact-home-skill')
      expect(evidence.activeRows).toEqual(expect.arrayContaining(requiredBaseRows))

      expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe('')
      expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toContain('HARNESS_ARTIFACT_TEST: present')
      expect(filesBelow(join(home, 'attachments', 'v1')).some(path => /[0-9a-f]{64}$/u.test(path))).toBe(true)
      expect(filesBelow(join(home, 'sessions')).some(path => path.endsWith('.jsonl.zstd'))).toBe(true)
      expect(readFileSync(join(home, '.anonymous-user-id'), 'utf8').trim()).toMatch(/^[0-9a-f-]{36}$/u)
      expect(existsSync(join(root, '.sessions'))).toBe(false)
      expect(existsSync(join(root, '.dsh'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 70_000)
})
