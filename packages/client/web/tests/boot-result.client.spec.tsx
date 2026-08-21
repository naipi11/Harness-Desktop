// @vitest-environment jsdom
/** AppWebEntry reports whether plugin boot reached the settled application UI. */

import { act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DshWindow } from '@harness-desktop/dsh-client-modules/client'
import { AppWebEntry } from '../src/boot.tsx'

const dshWindow = window as DshWindow
let entry: AppWebEntry | undefined

afterEach(() => {
  entry?.dispose()
  entry = undefined
  delete dshWindow.__DSH_BOOT__
  delete dshWindow.__DSH_MODULES__
  delete dshWindow.__ModuleLoader__
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

it('resolves false when plugin boot renders its failure report', async () => {
  dshWindow.__DSH_BOOT__ = { rev: 'failure', entries: [] }
  const root = document.createElement('div')
  root.dataset.harnessDashboardReady = 'true'
  document.body.appendChild(root)
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  entry = new AppWebEntry(root)
  let booted: unknown

  await act(async () => { booted = await entry?.run() })

  expect(booted).toBe(false)
  expect(root.hasAttribute('data-harness-dashboard-ready')).toBe(false)
  expect(consoleError).toHaveBeenCalledOnce()
  expect(root.textContent).toContain('Failed to load plugins')
})

it('clears the authenticated ready marker when the application entry is disposed', () => {
  const root = document.createElement('div')
  root.dataset.harnessDashboardReady = 'true'
  entry = new AppWebEntry(root)

  entry.dispose()

  expect(root.hasAttribute('data-harness-dashboard-ready')).toBe(false)
})
