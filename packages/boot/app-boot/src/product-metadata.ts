import metadata from '../product.json' with { type: 'json' }

/** Stable product names shared by launchers, clients, packaging, and verification. */
export interface ProductMetadata {
  readonly productName: string
  readonly commandName: string
  readonly legacyCommandName: string
  readonly repository: string
  readonly repositoryUrl: string
  readonly appId: string
  readonly npmPackage: string
  readonly dataNamespace: string
}

/** Command names accepted by the shared CLI implementation. */
export type ProductCommandName = 'harness' | 'dsh'

/** Frozen product metadata loaded from the package-owned JSON source. */
export const productMetadata: Readonly<ProductMetadata> = Object.freeze({ ...metadata })
