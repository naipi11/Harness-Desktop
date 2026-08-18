import type { ProductMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'

/** Props for the initial Desktop shell. */
export interface DesktopShellProps {
  /** Product identity displayed by the shell. */
  metadata: ProductMetadata
}

/** Renders the initial Desktop workspace shell. */
export function DesktopShell({ metadata }: DesktopShellProps): React.JSX.Element {
  return (
    <main className="desktop-shell">
      <header>
        <p>Local coding agent</p>
        <h1>{metadata.productName}</h1>
      </header>
      <section aria-label="Workspace">
        <p>Open a workspace to begin.</p>
      </section>
    </main>
  )
}
