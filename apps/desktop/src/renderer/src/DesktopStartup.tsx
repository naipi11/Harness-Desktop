import { useEffect, useState } from 'react'
import type { ProductMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import type { DesktopBridge } from '../../shared/desktop-api.ts'
import { DesktopShell } from './DesktopShell.tsx'

interface DesktopStartupProps {
  readonly bridge: DesktopBridge
}

/**
 * Resolves product identity before rendering the Desktop shell.
 * @param props - Narrow preload bridge used for startup metadata.
 * @returns The loading, failure, or ready renderer state.
 */
export function DesktopStartup({ bridge }: DesktopStartupProps): React.JSX.Element {
  const [metadata, setMetadata] = useState<ProductMetadata>()
  const [startupFailed, setStartupFailed] = useState(false)

  useEffect(() => {
    let active = true
    void bridge.getProductMetadata().then(
      (value) => {
        if (active) {
          document.title = value.productName
          setMetadata(value)
        }
      },
      () => {
        if (active) setStartupFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [bridge])

  if (startupFailed) {
    return <main className="desktop-shell"><p role="alert">Unable to start.</p></main>
  }
  if (metadata === undefined) {
    return <main className="desktop-shell"><p>Starting…</p></main>
  }
  return <DesktopShell metadata={metadata} />
}
