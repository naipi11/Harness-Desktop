import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { useEffect } from 'react'
import { DesktopShell } from './DesktopShell.tsx'

/** Renders the temporary local Desktop document with build-owned product identity. */
export function DesktopStartup(): React.JSX.Element {
  useEffect(() => {
    document.title = productMetadata.productName
  }, [])
  return <DesktopShell metadata={productMetadata} />
}
