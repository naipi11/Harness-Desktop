import { useState } from 'react'
import type { DesktopBridge, DesktopRecoveryDiagnostic } from '../../shared/desktop-api.ts'

/** Props for the renderer-safe local recovery page. */
export interface DesktopRecoveryProps {
  /** Sandboxed Main bridge for explicit recovery actions. */
  readonly bridge: DesktopBridge
  /** Five-field redacted diagnostic displayed to the user. */
  readonly diagnostic: DesktopRecoveryDiagnostic
}

type PendingAction = 'copy' | 'retry'

/**
 * Renders Main's redacted diagnostic and explicit recovery actions.
 * @param props - Main bridge and the current renderer-safe diagnostic.
 * @returns the local recovery page.
 */
export function DesktopRecovery({ bridge, diagnostic }: DesktopRecoveryProps): React.JSX.Element {
  const [visibleDiagnostic, setVisibleDiagnostic] = useState(diagnostic)
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const [status, setStatus] = useState('')
  const controlsDisabled = pendingAction !== undefined

  async function retryDashboard(): Promise<void> {
    setPendingAction('retry')
    setStatus('')
    try {
      const result = await bridge.retryDashboard()
      if (result.kind === 'recovery') setVisibleDiagnostic(result.diagnostic)
    } catch {
      // Main exposes retry failures only as stable IPC rejection codes; retain the actionable diagnostic.
    } finally {
      setPendingAction(undefined)
    }
  }

  async function copyDiagnostic(): Promise<void> {
    setPendingAction('copy')
    setStatus('')
    try {
      await bridge.copyRecoveryDiagnostic()
      setStatus('Diagnostic copied')
    } catch {
      // Main keeps clipboard and diagnostic details private; retain the existing diagnostic on failure.
    } finally {
      setPendingAction(undefined)
    }
  }

  return (
    <main className="desktop-recovery">
      <section className="recovery-card" role="alert" aria-labelledby="recovery-title">
        <p className="recovery-eyebrow">Local recovery</p>
        <h1 id="recovery-title">{visibleDiagnostic.subject} unavailable</h1>
        <p className="recovery-message">{visibleDiagnostic.message}</p>
        <dl className="recovery-details">
          <div>
            <dt>Code</dt>
            <dd><code>{visibleDiagnostic.code}</code></dd>
          </div>
          <div>
            <dt>Correction</dt>
            <dd>{visibleDiagnostic.correction}</dd>
          </div>
          <div>
            <dt>Diagnostic ID</dt>
            <dd><code>{visibleDiagnostic.diagnosticId}</code></dd>
          </div>
        </dl>
        <div className="recovery-actions">
          <button type="button" disabled={controlsDisabled} onClick={() => void retryDashboard()}>
            Retry Dashboard
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={controlsDisabled}
            onClick={() => void copyDiagnostic()}
          >
            Copy diagnostic
          </button>
        </div>
        <p className="recovery-status" role="status" aria-live="polite">{status}</p>
      </section>
    </main>
  )
}
