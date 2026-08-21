import type { RedactedRuntimeDiagnostic } from '@harness-desktop/dsh-host-local-runtime'

const notificationTitleLimit = 120
const notificationBodyLimit = 1_000
const externalLinkHosts = new Set([
  'api-docs.deepseek.com',
  'deepseek.com',
  'github.com',
  'www.deepseek.com',
])

/** IPC channels available to the sandboxed Desktop renderer. */
export const desktopChannels = {
  readRecoveryDiagnostic: 'desktop:read-recovery-diagnostic',
  retryDashboard: 'desktop:retry-dashboard',
  copyRecoveryDiagnostic: 'desktop:copy-recovery-diagnostic',
  selectFolder: 'desktop:select-folder',
  showNotification: 'desktop:show-notification',
  openExternalLink: 'desktop:open-external-link',
} as const

/** Five-field diagnostic permitted across Desktop IPC. */
export type DesktopRecoveryDiagnostic = Readonly<Pick<
  RedactedRuntimeDiagnostic,
  'code' | 'subject' | 'message' | 'correction' | 'diagnosticId'
>>

/** Dashboard startup state permitted across Desktop IPC. */
export type DesktopStartupResult =
  | { readonly kind: 'dashboard-loaded' }
  | { readonly kind: 'recovery'; readonly diagnostic: DesktopRecoveryDiagnostic }

/** Exact user decisions offered when Desktop-owned UI work is active during close. */
export type DesktopCloseChoice =
  | 'minimize-to-tray'
  | 'safely-stop-own-ui-work'
  | 'cancel'

/** User-selected project directory or an explicit cancellation. */
export type FolderSelectionResult =
  | { readonly kind: 'selected'; readonly path: string }
  | { readonly kind: 'cancelled' }

/** Bounded native notification content. */
export interface DesktopNotification {
  /** Nonblank title of at most 120 UTF-16 code units. */
  readonly title: string
  /** Body of at most 1,000 UTF-16 code units. */
  readonly body: string
}

/** Renderer API exposed through the isolated preload context. */
export interface DesktopBridge {
  /** Version of the literal Desktop IPC API. */
  readonly version: 1
  /** @returns Main's current renderer-safe diagnostic, when recovery is active. */
  readRecoveryDiagnostic(this: void): Promise<DesktopRecoveryDiagnostic | undefined>
  /** @returns the result of a user-initiated Dashboard retry. */
  retryDashboard(this: void): Promise<DesktopStartupResult>
  /** Copies Main's current renderer-safe diagnostic or rejects when none is active. */
  copyRecoveryDiagnostic(this: void): Promise<void>
  /** @returns a focused-window directory choice or cancellation. */
  selectFolder(this: void): Promise<FolderSelectionResult>
  /**
   * Shows a native notification after bounded-field validation.
   * @param notification - Exact title and body fields.
   */
  showNotification(this: void, notification: DesktopNotification): Promise<void>
  /**
   * Opens an HTTPS URL on the fixed Desktop host allowlist.
   * @param url - External URL requested by the renderer.
   */
  openExternalLink(this: void, url: string): Promise<void>
}

/** Typed Electron invocation accepted by the Desktop preload bridge. */
export interface DesktopInvoke {
  (channel: typeof desktopChannels.readRecoveryDiagnostic): Promise<DesktopRecoveryDiagnostic | undefined>
  (channel: typeof desktopChannels.retryDashboard): Promise<DesktopStartupResult>
  (channel: typeof desktopChannels.copyRecoveryDiagnostic): Promise<void>
  (channel: typeof desktopChannels.selectFolder): Promise<FolderSelectionResult>
  (channel: typeof desktopChannels.showNotification, notification: DesktopNotification): Promise<void>
  (channel: typeof desktopChannels.openExternalLink, url: string): Promise<void>
}

/**
 * Checks the exact selected-directory result permitted across Desktop IPC.
 * @param value - IPC result to validate.
 * @returns whether the value has only the selected path or cancellation fields.
 */
export function isFolderSelectionResult(value: unknown): value is FolderSelectionResult {
  if (!isRecord(value)) return false
  if (value.kind === 'cancelled') return hasExactKeys(value, ['kind'])
  return value.kind === 'selected'
    && typeof value.path === 'string'
    && value.path.trim().length > 0
    && hasExactKeys(value, ['kind', 'path'])
}

/**
 * Checks bounded native notification input without accepting extra fields.
 * @param value - Renderer value to validate.
 * @returns whether the value is an exact title/body notification.
 */
export function isDesktopNotification(value: unknown): value is DesktopNotification {
  return isRecord(value)
    && typeof value.title === 'string'
    && value.title.trim().length > 0
    && value.title.length <= notificationTitleLimit
    && typeof value.body === 'string'
    && value.body.length <= notificationBodyLimit
    && hasExactKeys(value, ['body', 'title'])
}

/**
 * Checks an external URL against Desktop's fixed HTTPS host allowlist.
 * @param value - Renderer value to validate.
 * @returns whether the URL uses HTTPS, the default port, no credentials, and an allowed host.
 */
export function isAllowedDesktopExternalLink(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && externalLinkHosts.has(url.hostname)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}
