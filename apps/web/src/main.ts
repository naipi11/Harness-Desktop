/** Cookie-authenticated Web entry over the shared Runtime Dashboard. */
import { AppWebEntry } from '@harness-desktop/dsh-client-web'

const RECOVERY_MESSAGE = 'Dashboard connection expired. Run harness web to reconnect.'

/** Safe failure for an absent Runtime session or a non-clean Dashboard URL. */
export class DashboardHandoffError extends Error {
  override readonly name = 'DashboardHandoffError'

  constructor() {
    super(RECOVERY_MESSAGE)
  }
}

/**
 * Verify the clean cookie carrier before mounting any protected Dashboard state.
 * @param root - the Web shell mount point.
 * @returns after the authenticated Dashboard has started.
 */
export async function startDashboard(root: HTMLElement): Promise<void> {
  root.removeAttribute('data-harness-dashboard-ready')
  if (location.href !== `${location.origin}/`) throw new DashboardHandoffError()
  let response: Response
  try {
    response = await fetch('/_harness/dashboard-control', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"operation":"get-legacy-migration"}',
    })
  } catch {
    // Network and Runtime settlement failures share the reconnect instruction.
    throw new DashboardHandoffError()
  }
  if (!response.ok) throw new DashboardHandoffError()
  const booted = await new AppWebEntry(root).run()
  if (!booted) return
  root.dataset.harnessDashboardReady = 'true'
}

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
void startDashboard(el).catch((error: unknown) => {
  if (!(error instanceof DashboardHandoffError)) throw error
  el.replaceChildren(document.createTextNode(error.message))
})
