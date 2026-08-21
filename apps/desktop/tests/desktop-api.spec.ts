import { describe, expect, it } from 'vitest'
import {
  isAllowedDesktopExternalLink,
  isDesktopNotification,
  isFolderSelectionResult,
  type DesktopRecoveryDiagnostic,
  type DesktopStartupResult,
} from '../src/shared/desktop-api.ts'

const dataRoot = 'C:\\Users\\fixture\\.harness-secret-root'
const diagnostic: DesktopRecoveryDiagnostic = {
  code: 'dashboard-unavailable',
  subject: 'Dashboard',
  message: 'The Harness Dashboard is unavailable.',
  correction: 'Retry the operation.',
  diagnosticId: 'diagnostic-api-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
}

describe('Desktop renderer-safe API', () => {
  it('serializes only the five-field diagnostic and discriminated recovery result', () => {
    const recovery: DesktopStartupResult = { kind: 'recovery', diagnostic }
    const serializedDiagnostic = JSON.stringify(diagnostic)
    const serializedRecovery = JSON.stringify(recovery)

    expect(Object.keys(diagnostic).sort()).toEqual([
      'code',
      'correction',
      'diagnosticId',
      'message',
      'subject',
    ])
    expect(Object.keys(recovery).sort()).toEqual(['diagnostic', 'kind'])
    for (const forbidden of [
      'handoff',
      'token',
      'authorization',
      'HARNESS_HOME',
      'process',
      dataRoot,
    ]) {
      expect(serializedDiagnostic).not.toContain(forbidden)
      expect(serializedRecovery).not.toContain(forbidden)
    }
  })

  it('accepts only exact selected-folder or cancellation results', () => {
    expect(isFolderSelectionResult({ kind: 'selected', path: 'C:\\projects\\harness' })).toBe(true)
    expect(isFolderSelectionResult({ kind: 'cancelled' })).toBe(true)
    expect(isFolderSelectionResult({ kind: 'selected', path: '' })).toBe(false)
    expect(isFolderSelectionResult({ kind: 'selected', path: dataRoot, dataRoot })).toBe(false)
    expect(isFolderSelectionResult({ kind: 'cancelled', path: dataRoot })).toBe(false)
  })

  it('accepts notifications with only bounded title and body fields', () => {
    expect(isDesktopNotification({ title: 'x'.repeat(120), body: 'y'.repeat(1_000) })).toBe(true)
    expect(isDesktopNotification({ title: '', body: 'Task finished.' })).toBe(false)
    expect(isDesktopNotification({ title: 'x'.repeat(121), body: 'Task finished.' })).toBe(false)
    expect(isDesktopNotification({ title: 'Harness', body: 'y'.repeat(1_001) })).toBe(false)
    expect(isDesktopNotification({ title: 'Harness', body: 'Task finished.', icon: dataRoot })).toBe(false)
  })

  it('allows only default-port HTTPS links on the fixed host allowlist', () => {
    for (const url of [
      'https://deepseek.com/',
      'https://www.deepseek.com/',
      'https://api-docs.deepseek.com/news/news0802/',
      'https://github.com/deepseek-ai/deepseek-harness',
    ]) expect(isAllowedDesktopExternalLink(url)).toBe(true)

    for (const url of [
      'http://github.com/deepseek-ai',
      'https://github.com:444/deepseek-ai',
      'https://user:password@github.com/deepseek-ai',
      'https://github.com.evil.example/deepseek-ai',
      'https://subdomain.github.com/deepseek-ai',
      'file:///etc/passwd',
      'not a URL',
    ]) expect(isAllowedDesktopExternalLink(url)).toBe(false)
  })
})
