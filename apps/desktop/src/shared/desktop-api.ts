import type { ProductMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'

/** IPC channels available to the sandboxed Desktop renderer. */
export const desktopChannels = {
  productMetadata: 'desktop:get-product-metadata',
} as const

/** Renderer API exposed through the isolated preload context. */
export interface DesktopBridge {
  /** Returns the product metadata owned by the main process. */
  getProductMetadata(): Promise<ProductMetadata>
}

/** Main-process invocation accepted by the Desktop preload bridge. */
export type DesktopInvoke = (
  channel: typeof desktopChannels.productMetadata,
) => Promise<ProductMetadata>
