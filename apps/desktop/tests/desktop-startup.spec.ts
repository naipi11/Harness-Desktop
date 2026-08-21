// @vitest-environment jsdom
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DesktopStartup } from '../src/renderer/src/DesktopStartup.tsx'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  document.title = ''
})

it('renders build-owned product identity without requesting it through native IPC', () => {
  document.title = 'Desktop'

  flushSync(() => {
    root.render(createElement(DesktopStartup))
  })

  expect(container.querySelector('h1')?.textContent).toBe(productMetadata.productName)
  expect(document.title).toBe(productMetadata.productName)
})
