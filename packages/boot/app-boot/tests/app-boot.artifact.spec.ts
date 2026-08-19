/** Built-provider Loader regression; run after `pnpm run build` supplies package artifacts. */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import { credentialRef } from '@harness-desktop/dsh-credentials'
import { createLocalRuntimePlugin } from '@harness-desktop/dsh-host-local-runtime'
import { boot } from '../src/index.ts'

const NAME = 'dsh-artifact-boot'
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const artifact = (path: string): string => {
  const target = join(repository, path)
  if (!existsSync(target)) throw new Error(`app-boot artifact coverage requires ${target}; run pnpm run build first`)
  return pathToFileURL(target).href
}

describe('boot built durable providers', () => {
  it('mounts all base durable roots under one injected Harness home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-app-boot-artifact-'))
    const provider = createLocalRuntimePlugin({ env: { HARNESS_HOME: join(dir, 'home') } })
    const modules = {
      agentSpine: artifact('packages/examples/agent-spine-demo/lib/index.js'),
      attachments: artifact('packages/attachment/attachment-local/lib/index.js'),
      credentials: artifact('packages/credentials/credentials-local/lib/index.js'),
      persistence: artifact('packages/session/session-persistence-jsonl/lib/index.js'),
      settings: artifact('packages/settings/settings-file/lib/index.js'),
    }
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: settings', `  name: ${modules.settings}`, '  config:', '    harnessHome: !!js harnessHome', '    watch: false',
      '- id: credentials', `  name: ${modules.credentials}`, '  config:', '    harnessHome: !!js harnessHome', '    watch: false',
      '- id: session-persistence-jsonl', `  name: ${modules.persistence}`, '  config:', "    root: !!js harnessHomePath('sessions')",
      '- id: attachment-local', `  name: ${modules.attachments}`, '  config:', '    harnessHome: !!js harnessHomeProvider',
      '- id: agent-spine', `  name: ${modules.agentSpine}`, '  config:', '    harnessHome: !!js harnessHome', '    workspaceContext:', '      maxBytes: 1024', '    skills:', '      filesystem:', '        watch: false',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, undefined, undefined, provider)
    try {
      expect(ctx).toBeInstanceOf(Context)
      expect(ctx.harnessHomeProvider).toBe(provider)
      for (const id of ['settings', 'credentials', 'session-persistence-jsonl', 'attachment-local', 'agent-spine']) {
        expect(ctx.loader.entries().find(entry => entry.options.id === id)?.fiber).toBeDefined()
      }
      expect((ctx.get('attachments') as { root?: string } | undefined)?.root).toBe(provider.path('attachments', 'v1'))
      await ctx.settings.prepareDocument()
      await ctx.credentials.set(credentialRef('HARNESS_ARTIFACT_TEST'), 'present')
      await ctx.attachments.saveImage({
        data: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')),
        mediaType: 'image/png',
      })
      expect(readFileSync(provider.path('settings.yaml'), 'utf8')).toBe('')
      expect(readFileSync(provider.path('.credentials.yaml'), 'utf8')).toContain('HARNESS_ARTIFACT_TEST: present')
      expect(existsSync(provider.path('attachments', 'v1'))).toBe(true)
      expect(ctx.get('sessionPersistence')?.locate({ cwd: dir, id: 'artifact-root' } as never)).toMatchObject({
        path: expect.stringContaining(provider.path('sessions')),
      })
      expect((ctx.get('shellEnv')?.collect({} as never) as Record<string, string> | undefined)?.HARNESS_HOME).toBe(provider.home)
      expect(ctx.get('skills')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
