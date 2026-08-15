import { productMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DesktopShell } from '../src/renderer/src/DesktopShell.tsx'

it('renders the initial Harness Desktop shell', () => {
  const html = renderToStaticMarkup(<DesktopShell metadata={productMetadata} />)
  expect(html).toMatchInlineSnapshot(`
    "<main class=\"desktop-shell\"><header><p>Local coding agent</p><h1>Harness Desktop</h1></header><section aria-label=\"Workspace\"><p>Open a workspace to begin.</p></section></main>"
  `)
})
