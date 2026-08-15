// @vitest-environment jsdom
import { productMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DesktopStartup } from '../src/renderer/src/DesktopStartup.tsx'
import type { DesktopBridge } from '../src/shared/desktop-api.ts'

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

it('uses neutral bootstrap copy and adopts the metadata product name after startup', async () => {
  let resolveMetadata: ((value: typeof productMetadata) => void) | undefined
  const bridge: DesktopBridge = {
    getProductMetadata: () => new Promise((resolve) => {
      resolveMetadata = resolve
    }),
  }
  const metadata = { ...productMetadata, productName: 'Renamed Product' }
  document.title = 'Desktop'

  flushSync(() => {
    root.render(createElement(DesktopStartup, { bridge }))
  })

  expect(container.textContent).toBe('Starting…')
  expect(document.body.textContent).not.toContain('Harness Desktop')
  expect(document.title).toBe('Desktop')
  if (resolveMetadata === undefined) throw new Error('Metadata request did not start.')
  const resolve = resolveMetadata
  resolve(metadata)
  await new Promise(resolveUpdate => setTimeout(resolveUpdate, 0))

  expect(container.querySelector('h1')?.textContent).toBe('Renamed Product')
  expect(document.title).toBe('Renamed Product')
})

it('renders a neutral startup error when product metadata cannot be loaded', async () => {
  const bridge: DesktopBridge = {
    getProductMetadata: () => Promise.reject(new Error('metadata unavailable')),
  }

  flushSync(() => {
    root.render(createElement(DesktopStartup, { bridge }))
  })
  await new Promise(resolveUpdate => setTimeout(resolveUpdate, 0))

  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unable to start.')
  expect(document.body.textContent).not.toContain('Harness Desktop')
})
