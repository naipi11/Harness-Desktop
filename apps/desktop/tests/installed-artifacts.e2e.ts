/** Native installed-or-mounted Desktop acceptance on the matching runner. */

import { expect, test } from '@playwright/test'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepareInstalledDesktopArtifacts } from './support/installed-artifact-fixture.ts'

const releaseDirectory = fileURLToPath(new URL('../release', import.meta.url))
test.setTimeout(180_000)

test('launches native installed artifacts after authenticated Dashboard boot and preserves HARNESS_HOME', async () => {
  const artifacts = await prepareInstalledDesktopArtifacts({
    platform: process.platform,
    releaseDirectory,
  })
  expect(artifacts.length).toBeGreaterThan(0)
  for (const artifact of artifacts) {
    const fixture = await artifact.launch()
    try {
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
      await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
      await expect.poll(() => fixture.desktopOutput().split(/\r?\n/u).filter(
        line => line === '{"kind":"desktop-dashboard-ready","version":1}',
      ).length).toBe(1)
      await artifact.writeSentinel(fixture.runtime.harnessHome)
      await artifact.verifyGeneratedIcon()
    } finally {
      await fixture.close({ preserveRuntimeRoot: true })
    }
    try {
      await artifact.remove()
      await expect(access(artifact.sentinelPath)).resolves.toBeUndefined()
    } finally {
      await artifact.cleanup()
    }
  }
})
