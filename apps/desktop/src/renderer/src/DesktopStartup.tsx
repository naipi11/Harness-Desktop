import { useEffect, useState } from 'react'
import type { DesktopBridge, DesktopRecoveryDiagnostic } from '../../shared/desktop-api.ts'
import { DesktopRecovery } from './DesktopRecovery.tsx'

/** Props for the local recovery bootstrap. */
export interface DesktopStartupProps {
  /** Sandboxed Main bridge used only to read the current recovery diagnostic. */
  readonly bridge: DesktopBridge
}

/**
 * Reads Main's current diagnostic without initiating Dashboard startup.
 * @param props - Sandboxed bridge used to read renderer-safe recovery state.
 * @returns the recovery page when Main has a current diagnostic, otherwise no local UI.
 */
export function DesktopStartup({ bridge }: DesktopStartupProps): React.JSX.Element | null {
  const [diagnostic, setDiagnostic] = useState<DesktopRecoveryDiagnostic>()

  useEffect(() => {
    let mounted = true
    void bridge.readRecoveryDiagnostic().then((nextDiagnostic) => {
      if (mounted) setDiagnostic(nextDiagnostic)
    }).catch(() => {
      // A rejected Main diagnostic read has no renderer-safe details to display.
    })
    return () => {
      mounted = false
    }
  }, [bridge])

  return diagnostic === undefined ? null : <DesktopRecovery bridge={bridge} diagnostic={diagnostic} />
}
