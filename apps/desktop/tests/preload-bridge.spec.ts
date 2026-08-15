import { productMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { expect, it, vi } from 'vitest'
import { createDesktopBridge } from '../src/preload/bridge.ts'
import { desktopChannels } from '../src/shared/desktop-api.ts'

it('requests product metadata through the narrow desktop channel', async () => {
  const invoke = vi.fn().mockResolvedValue(productMetadata)

  await expect(createDesktopBridge(invoke).getProductMetadata()).resolves.toBe(productMetadata)
  expect(invoke).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledWith('desktop:get-product-metadata')
  expect(desktopChannels.productMetadata).toBe('desktop:get-product-metadata')
})
