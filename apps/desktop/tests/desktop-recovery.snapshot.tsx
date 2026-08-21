import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { DesktopRecovery } from '../src/renderer/src/DesktopRecovery.tsx'
import type { DesktopBridge, DesktopRecoveryDiagnostic } from '../src/shared/desktop-api.ts'

const diagnostic: DesktopRecoveryDiagnostic = {
  code: 'dashboard-unavailable',
  subject: 'Dashboard',
  message: 'The Harness Dashboard is unavailable.',
  correction: 'Retry the operation.',
  diagnosticId: 'diagnostic-snapshot-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
}

it('renders only the renderer-safe Dashboard recovery page', () => {
  const html = renderToStaticMarkup(<DesktopRecovery bridge={createBridge()} diagnostic={diagnostic} />)

  expect(html).toMatchInlineSnapshot(`
    "<main class=\"desktop-recovery\"><section class=\"recovery-card\" role=\"alert\" aria-labelledby=\"recovery-title\"><p class=\"recovery-eyebrow\">Local recovery</p><h1 id=\"recovery-title\">Dashboard unavailable</h1><p class=\"recovery-message\">The Harness Dashboard is unavailable.</p><dl class=\"recovery-details\"><div><dt>Code</dt><dd><code>dashboard-unavailable</code></dd></div><div><dt>Correction</dt><dd>Retry the operation.</dd></div><div><dt>Diagnostic ID</dt><dd><code>diagnostic-snapshot-fixture</code></dd></div></dl><div class=\"recovery-actions\"><button type=\"button\">Retry Dashboard</button><button type=\"button\" class=\"secondary-action\">Copy diagnostic</button></div><p class=\"recovery-status\" role=\"status\" aria-live=\"polite\"></p></section></main>"
  `)
  for (const forbidden of [
    'fixture-runtime-token',
    'C:\\Users\\fixture\\.harness-secret-root',
    'DEEPSEEK_API_KEY=fixture-credential',
  ]) expect(html).not.toContain(forbidden)
})

function createBridge(): DesktopBridge {
  return {
    version: 1,
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic),
    retryDashboard: vi.fn().mockResolvedValue({ kind: 'dashboard-loaded' }),
    copyRecoveryDiagnostic: vi.fn().mockResolvedValue(undefined),
    selectFolder: vi.fn().mockResolvedValue({ kind: 'cancelled' }),
    showNotification: vi.fn().mockResolvedValue(undefined),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
  }
}
