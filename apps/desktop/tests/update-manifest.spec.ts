/** Desktop Main-process shared update policy consumption. */

import { describe, expect, it } from 'vitest'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { EMPTY_UPDATE_TRUST } from '@harness-desktop/dsh-update-policy'
import type { UpdateManifestPolicy } from '@harness-desktop/dsh-update-policy'

describe('Desktop Main update policy consumer', () => {
  it('constructs an unconfigured policy from the shared package entry', () => {
    const policy: UpdateManifestPolicy = {
      appId: productMetadata.appId,
      currentVersion: '1.0.0',
      channel: 'stable',
      consumer: 'desktop',
      platform: process.platform,
      arch: process.arch,
      ...EMPTY_UPDATE_TRUST,
    }

    expect(policy.allowedOrigins).toEqual([])
    expect(policy.publicKeys).toEqual({})
  })
})
