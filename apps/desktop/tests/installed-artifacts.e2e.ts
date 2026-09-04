/** Native installed-or-mounted Desktop acceptance on the matching runner. */

import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import {
  prepareInstalledDesktopArtifacts,
  runInstalledArtifactCollection,
} from './support/installed-artifact-fixture.ts'

const releaseDirectory = fileURLToPath(new URL('../release', import.meta.url))
test.setTimeout(180_000)

test('launches native installed artifacts after authenticated Dashboard boot and preserves HARNESS_HOME', async () => {
  const artifacts = await prepareInstalledDesktopArtifacts({
    platform: process.platform,
    releaseDirectory,
  })
  expect(artifacts.length).toBeGreaterThan(0)
  await runInstalledArtifactCollection(artifacts, async (artifact, fixture) => {
    try {
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
    } catch (error) {
      const pageText = await fixture.page.locator('body').innerText().catch(() => '')
      const bootManifest = await fixture.page.evaluate(() => {
        const value = (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
        if (typeof value !== 'object' || value === null) return value
        const record = value as { plugins?: unknown; modules?: unknown }
        return { modules: record.modules, plugins: record.plugins }
      }).catch(() => undefined)
      const diagnostic = [
        `artifact=${artifact.name}`,
        `desktop-output=${redactDiagnostic(fixture.desktopOutput())}`,
        `renderer-errors=${redactDiagnostic(fixture.rendererErrors.join('\n'))}`,
        `boot-manifest=${redactDiagnostic(JSON.stringify(bootManifest) ?? 'undefined')}`,
        `page-text=${redactDiagnostic(pageText)}`,
      ].join('\n')
      throw new Error(`installed Desktop Dashboard did not become ready\n${diagnostic}`, { cause: error })
    }
    await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
    await expect.poll(() => fixture.desktopOutput().split(/\r?\n/u).filter(
      line => line === '{"kind":"desktop-dashboard-ready","version":1}',
    ).length).toBe(1)
    await artifact.writeSentinel(fixture.runtime.harnessHome)
    await artifact.verifyGeneratedIcon()
  })
})

function redactDiagnostic(value: string): string {
  return value
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .slice(-4_096)
}
