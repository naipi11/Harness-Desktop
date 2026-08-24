/** Real schema-harvest coverage for the generated tool catalog. */

import { describe, expect, it } from 'vitest'
import { collectToolCatalog } from './gen-tool-catalog.ts'

describe('tool catalog schema harvest', () => {
  it('mounts the shell tool entries with every required configuration fact', async () => {
    const catalog = await collectToolCatalog()

    expect(catalog.find(entry => entry.pkg === '@harness-desktop/dsh-tool-bash')?.schemas.map(schema => schema.name))
      .toContain('bash')
    expect(catalog.find(entry => entry.pkg === '@harness-desktop/dsh-tool-pwsh')?.schemas.map(schema => schema.name))
      .toContain('pwsh')
  })
})
