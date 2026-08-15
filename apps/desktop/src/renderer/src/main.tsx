import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ProductMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { DesktopShell } from './DesktopShell.tsx'
import './styles.css'

function DesktopStartup(): React.JSX.Element {
  const [metadata, setMetadata] = useState<ProductMetadata>()
  const [startupFailed, setStartupFailed] = useState(false)

  useEffect(() => {
    let active = true
    void window.harnessDesktop.getProductMetadata().then(
      (value) => {
        if (active) setMetadata(value)
      },
      () => {
        if (active) setStartupFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [])

  if (startupFailed) {
    return <main className="desktop-shell"><p role="alert">Harness Desktop could not start.</p></main>
  }
  if (metadata === undefined) {
    return <main className="desktop-shell"><p>Starting Harness Desktop…</p></main>
  }
  return <DesktopShell metadata={metadata} />
}

const root = document.getElementById('root')
if (root === null) throw new Error('Desktop renderer root element is missing.')
createRoot(root).render(<DesktopStartup />)
