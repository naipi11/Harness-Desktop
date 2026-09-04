# Harness Desktop Runtime Host Implementation Plan

English | [中文](2026-08-18-harness-desktop-runtime-host.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed Electron application start or attach to the shared local Runtime and display the real Harness Dashboard, while keeping Runtime authority, credentials, tokens, and process handles outside the renderer.

**Architecture:** Electron Main is a client of the shared Runtime discovery and Dashboard-control APIs. It retains the endpoint token, consumes the Foundation-owned attachment and one-time handoff protocol, and gives its `DashboardNavigation` only to a Main-owned bootstrap transport. That transport opens a local bootstrap document whose file URL, launch arguments, and logs are secret-free while its HTML body has the hidden handoff field, submits that field only in a form body from its opaque file origin, and follows the Runtime's clean `303` navigation to the loopback Dashboard origin. The Electron renderer is either that existing Dashboard or a small local recovery document; its versioned preload bridge is literal and fail-closed, exposing three recovery operations plus user-initiated folder selection, notifications, and allowlisted external-link opening.

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`, TypeScript 6, Electron 43, electron-vite, React 18, existing `@harness-desktop/dsh-client-web` Dashboard, Runtime discovery/control client, Vitest, Playwright, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md`

## Global Constraints

- One Runtime instance owns one `HARNESS_HOME`; Desktop is a client and never creates a Desktop-private Runtime, persistence database, credential store, or session format.
- Main starts or attaches through the shared Runtime discovery API; it may use the opaque endpoint token only for private loopback control calls.
- The renderer never receives the Runtime token, endpoint record, `HARNESS_HOME`, credential-provider values, child-process handles, or unredacted diagnostic data.
- A high-entropy, short-lived, one-time handoff (at most 60 seconds) is never placed in a URL, hash, query, header, history entry, referrer, browser storage, log, diagnostic, transcript, IPC result, or Renderer value. Main gives the Foundation `DashboardNavigation` only to its private `BrowserHandoffTransport`, which creates an owner-only local-file bootstrap directory and document, verifies POSIX modes or the Windows current-user ACL, and rejects a broader-access location. Its file URL, launch arguments, and logs are secret-free, while its HTML body contains the hidden handoff field. The document posts the handoff exactly once in a form body from its opaque origin to the exact Runtime target. An idempotent launcher cleanup timer bound to `expiresAt` removes the owned document and directory exactly once after dispatch failure, exchange success or failure, or expiry, including a never-dispatched document, then follows the no-CORS clean `303` Dashboard navigation. The exchange handler does not require Origin equality: it authenticates only the atomically consumed body handoff. Foundation owns the post-exchange randomized or signed session credential, which appears only in Runtime `Set-Cookie`, browser `Cookie` request headers, and the browser HttpOnly cookie jar; it uses `HttpOnly; SameSite=Strict; Path=/` with no expiry attribute and is never exposed to Dashboard JavaScript, Renderer IPC, script storage, app persistence, logs, diagnostics, snapshots, or transcripts.
- Electron uses `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, a restrictive CSP, denied child-window creation, Main-only allowlisted external opening, and loopback-origin navigation checks.
- The loaded UI is the existing `@harness-desktop/dsh-client-web` Dashboard composition. Do not embed, duplicate, or maintain a Desktop chat, workspace, session, settings, credential, or approval implementation.
- A Runtime or Dashboard failure displays a local recovery page with Retry and a copyable redacted diagnostic. It never displays the welcome shell or an empty agent-ready surface.
- All copyable diagnostics name the failed subject, stable code, correction, and diagnostic identifier, and redact secrets, authorization headers, endpoint tokens, and data-root paths.
- Source, built, and unpacked-package paths all consume the same Main/preload code, regenerate `out/` and `release/` from a clean output tree, and prove the Dashboard's exact WebSocket CSP in each relevant lifecycle path; the icon/release plan owns installed-artifact smoke coverage.
- Every new product-visible state has focused keyless coverage through the real Dashboard composition or an Electron end-to-end test; tests do not assert a replacement welcome shell.
- Main emits one redacted process-observable `DesktopReadyAcknowledgement` only after the clean exact-origin Dashboard has completed authenticated boot. Source, built, unpacked, and installed smoke consume that same acknowledgement; it is a synchronization signal, never a renderer API.

---

## Required shared Runtime input

The Runtime-foundation plan supplies the exact public, Node-only `RuntimeClient.attachDashboard(): Promise<DashboardAttachment>` API before this plan begins. Desktop imports the Foundation-owned `RuntimeClient`, `DashboardAttachment`, `DashboardNavigation`, `DashboardOrigin`, `BrowserHandoff`, `RedactedRuntimeDiagnostic`, `ActiveWorkStatus`, `OwnUiWorkStopResult`, and `normalizeRecoveryDiagnostic`; it does not redeclare or wrap competing client types. The API is shared by CLI, Web launcher, and Electron Main, is not an Electron package, and never exports a token-bearing value to browser code.

`RuntimeClient.attachDashboard()` creates a Desktop-owned `DashboardAttachment`. `DashboardAttachment.createBrowserHandoff(): Promise<DashboardNavigation>` returns `{ origin: DashboardOrigin; handoff: BrowserHandoff }`, where `BrowserHandoff` is exactly `{ id: Branded<'BrowserHandoffId'>; expiresAt: number }`. Main gives that transient result only to `BrowserHandoffTransport.open(navigation)`, and calls `DashboardAttachment.close()` when that attachment is replaced or its window is finally destroyed. Main calls `RuntimeClient.close()` during application shutdown after its attachments close. These release only this Desktop client's attachments and client connection; they never stop the Runtime, cancel active work, release another client's lease, or terminate another client. All attachment, bootstrap transport, or startup failures pass through `normalizeRecoveryDiagnostic` before reaching Main state or IPC.

`DashboardNavigation.handoff` is Main-only transient data. `BrowserHandoffTransport.open(navigation)` creates a one-time private bootstrap HTML document with a hidden form value for `handoff.id` in a verified owner-only directory, opens it through a clean local file URL, and immediately posts the form from its opaque origin only to `${origin}/_harness/handoff`. The file URL, launch arguments, and logs contain no handoff; the document body intentionally contains the hidden form value. The transport rejects a broader-access location, binds exactly one idempotent cleanup timer to `expiresAt`, and deletes its owned document and directory once after dispatch failure, exchange success or failure, or expiry, including a never-dispatched document. Foundation does not require Origin equality, authenticates only the single-use, unexpired body value, emits no CORS permission, redacts its capture, sets the session cookie, and returns `303` to the clean `${origin}/` Dashboard URL. No Desktop shared type, IPC result, test snapshot, log, preload value, renderer prop, initial navigation request, request URL or header, referrer, history entry, browser storage entry, diagnostic, or transcript contains the handoff.

The Runtime-foundation plan owns the loopback static host, private native-control routes, the Dashboard control protocol (the opaque-file-origin body-only handoff exchange, atomic single-use/60-second enforcement, no-CORS clean `303`, redacted body capture, session cookie, and exact-origin API/event authentication), Dashboard response CSP, `normalizeRecoveryDiagnostic`, `observeActiveWork()`, and `stopOwnUiWork()`. The CLI/Web plan owns the launcher bootstrap transport for ordinary browsers and the keyless Runtime-hosted Dashboard fixture. This Desktop plan owns the Electron-specific private bootstrap transport, renderer-safe diagnostic projection, readiness acknowledgement, Dashboard workbench implementation, and Desktop lifecycle; it does not modify Runtime authentication, cookie, CSP, static-host code, or browser recovery behavior.

### Task 1: Add the Main-only Runtime Dashboard controller

**Files:**

- Create: `apps/desktop/src/main/runtime-dashboard.ts`
- Create: `apps/desktop/src/main/browser-handoff-transport.ts`
- Create: `apps/desktop/src/main/readiness.ts`
- Create: `apps/desktop/tests/runtime-dashboard.spec.ts`
- Create: `apps/desktop/tests/browser-handoff-transport.spec.ts`
- Create: `apps/desktop/tests/desktop-ready.spec.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**

- Consumes: Foundation-owned `RuntimeClient.attachDashboard(): Promise<DashboardAttachment>`, `DashboardAttachment.createBrowserHandoff(): Promise<DashboardNavigation>`, `DashboardAttachment.close()`, `RuntimeClient.close()`, and `normalizeRecoveryDiagnostic`.
- Produces: `RuntimeDashboardController.open(window): Promise<DesktopStartupResult>` and `RuntimeDashboardController.retryAfterUserAction(window): Promise<DesktopStartupResult>`.
- Produces: `DesktopStartupResult = { kind: 'dashboard-loaded' } | { kind: 'recovery'; diagnostic: DesktopRecoveryDiagnostic }`; the renderer-safe result has no URL, handoff, token, port, PID, or data-root field.
- Produces: Main-only `BrowserHandoffTransport.open(navigation: DashboardNavigation): Promise<void>` and `DesktopReadyAcknowledgement = { readonly kind: 'desktop-dashboard-ready'; readonly version: 1 }`, written once as one JSONL record to the launched Desktop process stdout.

- [ ] **Step 1: Write failing controller tests**

Create `apps/desktop/tests/runtime-dashboard.spec.ts` with a fake Foundation `RuntimeClient`, `DashboardAttachment`, `BrowserHandoffTransport`, and window. Require an attachment failure to normalize to the exact redacted diagnostic and make no navigation. Then require concurrent `open()` calls to share one attachment, call `createBrowserHandoff()` once, and pass the unchanged Foundation `DashboardNavigation` exactly once to the transport. Require an explicit `retryAfterUserAction()` to close the replaced attachment, create a fresh attachment and navigation, cover both its successful bootstrap and its normalized redacted recovery result, and prove that no retry occurs before the user action. Require window destruction to close its attachment, app quit to close the Runtime client after attachments, and neither operation to invoke Runtime stop, lease release, or work cancellation.

Create `browser-handoff-transport.spec.ts` to inspect every `loadFile`/navigation value and captured request: verify the bootstrap directory and file's owner-only POSIX modes or current-user Windows ACL and reject a broader-access location; the bootstrap file URL, launch arguments, clean Dashboard URL, URL/hash/query, referrer, history, request headers other than the authenticated session `Cookie`, script storage, logs, and diagnostic capture exclude fixture handoff text, while only the bootstrap HTML body has its hidden form value. Exactly one form `POST /_harness/handoff` from an opaque file origin contains it only in the body, its response emits no CORS permission, and that capture is redacted. Advance a never-dispatched document to `expiresAt`; dispatch failure and both exchange outcomes must use the same exactly-once cleanup of the owned document and directory. Prove that a wrong, expired, or second use fails, and require non-`127.0.0.1` targets, an origin with a query/fragment/userinfo, a second dispatch, and a failed `303` to yield a normalized redacted recovery result. Create `desktop-ready.spec.ts` to require exactly `{"kind":"desktop-dashboard-ready","version":1}` followed by one newline only after a clean expected Dashboard origin and its authenticated `data-harness-dashboard-ready="true"` marker are observed; recovery, bootstrap, an unauthenticated URL, a failed marker, or a duplicate navigation emits nothing or a duplicate acknowledgement.

- [ ] **Step 2: Run the focused test and confirm the controller is absent**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/browser-handoff-transport.spec.ts apps/desktop/tests/desktop-ready.spec.ts
```

Expected: FAIL because `src/main/runtime-dashboard.ts` does not exist.

- [ ] **Step 3: Implement the smallest Main-only controller**

Create `RuntimeDashboardController` with a constructor dependency of the Foundation `RuntimeClient` and Main-only `BrowserHandoffTransport`. It owns the current `DashboardAttachment`, calls `attachment.createBrowserHandoff()`, and passes its unchanged `DashboardNavigation` to `transport.open()`. The transport validates the branded target origin after conversion to a URL (protocol `http:`, hostname `127.0.0.1`, no username, password, query, or fragment, and a nonempty port), creates and verifies a one-use owner-only bootstrap directory and document, rejects a broader-access location, and never interpolates `handoff.id` into a URL. The file URL, launch arguments, and logs are secret-free, while the document body has the hidden form value. Bind exactly one idempotent cleanup timer to `expiresAt`; dispatch failure, exchange success or failure, expiry, and no dispatch each remove the owned document and directory once. Its top-level form POST is intentionally cross-origin from the opaque file origin; Foundation authenticates only the body handoff and returns no CORS permission. Await the clean Dashboard redirect and the non-secret authenticated-ready marker before returning `dashboard-loaded`; then emit the one constant acknowledgement to `process.stdout`. On replacement, destruction, or app quit, close each owned attachment exactly once; close the Runtime client only during app shutdown. Convert an invalid origin, handoff, bootstrap transport, attachment, marker, or load rejection through `normalizeRecoveryDiagnostic`; never include the rejected URL in a renderer result.

- [ ] **Step 4: Wire first start into Main without exposing control data**

After `ready-to-show`, Main alone creates the controller and calls `open(window)` once; it leaves the local recovery document loaded on a recovery result. It creates attachments, mints handoffs, navigates, and releases attachments only through that controller, never from preload or Renderer. Do not pass the attachment object through `webContents.send`, command-line arguments, renderer globals, or environment variables. Store only the current redacted diagnostic in Main for the read-only recovery IPC handler introduced in Task 2. Wire `BrowserWindow` destruction and `before-quit`/`will-quit` so owned attachments then the Desktop client close; closing a window with active work instead follows Task 6's explicit user choice and never terminates shared Runtime work.

- [ ] **Step 5: Run the focused Main and type checks**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
```

Expected: no navigation URL contains a fragment or handoff; the exchange is the single redacted opaque-file-origin form POST body with no CORS permission; the process acknowledgement follows authenticated Dashboard boot and contains only its constant kind/version; recovery results contain only redacted fields; attachment/client close is local and cannot stop shared Runtime work.

- [ ] **Step 6: Commit the controller work**

```powershell
git add apps/desktop/src/main apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(desktop): attach Main to the local Runtime"
```

### Task 2: Replace metadata IPC with a versioned, fail-closed native bridge

**Files:**

- Modify: `apps/desktop/src/shared/desktop-api.ts`
- Modify: `apps/desktop/src/preload/bridge.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/src/global.d.ts`
- Modify: `apps/desktop/tests/preload-bridge.spec.ts`
- Create: `apps/desktop/tests/desktop-api.spec.ts`

**Interfaces:**

- Consumes: Foundation `RedactedRuntimeDiagnostic`, Main-owned `toDesktopRecoveryDiagnostic(diagnostic)`, `DesktopStartupResult`, Main-owned `copyText(text): Promise<void>` adapter, Electron `dialog`, `Notification`, and `shell.openExternal`.
- Produces: `DesktopBridge` version 1 with three recovery operations—`readRecoveryDiagnostic()`, `retryDashboard()`, `copyRecoveryDiagnostic()`—and three native operations—`selectFolder()`, `showNotification(notification)`, `openExternalLink(url)`.
- Produces exactly six literal `desktopChannels` entries: `'desktop:read-recovery-diagnostic'`, `'desktop:retry-dashboard'`, `'desktop:copy-recovery-diagnostic'`, `'desktop:select-folder'`, `'desktop:show-notification'`, and `'desktop:open-external-link'`.

- [ ] **Step 1: Write failing privilege-boundary tests**

Replace the metadata-channel assertions with tests that invoke each of the six exact channels once and reject all unknown channels and malformed payloads. Add `desktop-api.spec.ts` which serializes the read-only recovery diagnostic and a recovery result, asserts the latter has exactly `kind` and `diagnostic` at the top level, and asserts both serialized texts exclude `handoff`, `token`, `authorization`, `HARNESS_HOME`, `process`, and a fixture data-root path. Test that folder selection returns only a user-selected project path or cancellation, notification input has bounded literal fields, and external opening accepts only the documented `https:` allowlist.

- [ ] **Step 2: Run the tests and observe the old bridge contract fail**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts
```

Expected: FAIL because the current bridge exposes `getProductMetadata()` instead of the versioned six-operation bridge.

- [ ] **Step 3: Define the discriminated, renderer-safe API**

In `desktop-api.ts`, type-import only Foundation's `RedactedRuntimeDiagnostic`; do not import an endpoint record, control client, handoff, or token-bearing type into this shared module. Define the renderer payload as the exact field projection `DesktopRecoveryDiagnostic = Readonly<Pick<RedactedRuntimeDiagnostic, 'code' | 'subject' | 'message' | 'correction' | 'diagnosticId'>>`. Main alone implements the pure `toDesktopRecoveryDiagnostic(diagnostic)` mapper by copying those five fields and nothing else before IPC serialization. `DesktopStartupResult` uses that projection; it never carries or reconstructs `DashboardNavigation`, `BrowserHandoff`, an origin, or a token. `DesktopBridge` has version `1` and contains only:

```ts ignore-check
import type { RedactedRuntimeDiagnostic } from '@harness-desktop/dsh-host-local-runtime'

type DesktopRecoveryDiagnostic = Readonly<Pick<
  RedactedRuntimeDiagnostic,
  'code' | 'subject' | 'message' | 'correction' | 'diagnosticId'
>>

type DesktopStartupResult =
  | { readonly kind: 'dashboard-loaded' }
  | { readonly kind: 'recovery'; readonly diagnostic: DesktopRecoveryDiagnostic }

interface DesktopBridge {
  readonly version: 1;
  readRecoveryDiagnostic(): Promise<DesktopRecoveryDiagnostic | undefined>;
  retryDashboard(): Promise<DesktopStartupResult>;
  copyRecoveryDiagnostic(): Promise<void>;
  selectFolder(): Promise<{ readonly kind: 'selected'; readonly path: string } | { readonly kind: 'cancelled' }>;
  showNotification(notification: { readonly title: string; readonly body: string }): Promise<void>;
  openExternalLink(url: string): Promise<void>;
}
```

Make `DesktopInvoke` a discriminated overload/map for those six literal channel names. No generic `invoke(channel: string, ...args: unknown[])`, shell access, filesystem API, token getter, arbitrary clipboard API, arbitrary notification payload, or arbitrary external URL is allowed. The bridge does not expose Runtime, Node, filesystem, process, or credential access.

- [ ] **Step 4: Register fail-closed Main handlers**

Register `readRecoveryDiagnostic` as a read-only return of Main's current redacted diagnostic. Register `retryDashboard` through the controller only after a Renderer user-click invocation; it is the only retry path. Register copy only when Main has a recovery diagnostic; format the copy text in Main from its redacted fields, then call Electron's `clipboard.writeText`. If there is no recovery diagnostic, reject with a fixed `desktop:no-recovery-diagnostic` error. Register folder selection only from a focused BrowserWindow and return a selected project folder or cancellation, never `HARNESS_HOME`; show notifications only from bounded title/body fields; and check each external URL against a fixed `https:` host allowlist before Main calls `shell.openExternal`. Reject failed checks with fixed redacted error codes. Do not echo exception messages from clipboard, Runtime, BrowserWindow, dialog, notification, or shell into IPC responses.

- [ ] **Step 5: Expose and validate only the typed bridge**

Keep `contextBridge.exposeInMainWorld('harnessDesktop', createDesktopBridge(...))`; update `global.d.ts` to declare only `DesktopBridge`. Add a test asserting `Object.keys(window.harnessDesktop)` is exactly `['copyRecoveryDiagnostic', 'openExternalLink', 'readRecoveryDiagnostic', 'retryDashboard', 'selectFolder', 'showNotification', 'version']`, that its version is literal `1`, and that `window.require`, `process`, and every old metadata method are absent in the sandboxed page.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
```

Expected: the only renderer-visible native operations are the six literal, typed operations above; Dashboard state remains observable through its authenticated DOM and test hooks, never through this bridge.

- [ ] **Step 7: Commit the preload boundary**

```powershell
git add apps/desktop/src/shared apps/desktop/src/preload apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/global.d.ts apps/desktop/tests
git diff --cached --check
git commit -m "feat(desktop): expose fail-closed native bridge"
```

### Task 3: Replace the welcome shell with a local recovery page

**Files:**

- Delete: `apps/desktop/src/renderer/src/DesktopShell.tsx`
- Delete: `apps/desktop/tests/desktop-shell.snapshot.tsx`
- Modify: `apps/desktop/src/renderer/src/DesktopStartup.tsx`
- Create: `apps/desktop/src/renderer/src/DesktopRecovery.tsx`
- Modify: `apps/desktop/src/renderer/src/main.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/tests/desktop-startup.spec.ts`
- Create: `apps/desktop/tests/desktop-recovery.snapshot.tsx`

**Interfaces:**

- Consumes: `DesktopBridge` and `DesktopStartupResult` from Task 2.
- Produces: `DesktopRecovery({ bridge, diagnostic }): React.JSX.Element`, shown only while the local Runtime/Dashboard path is unavailable.

- [ ] **Step 1: Write failing recovery rendering tests**

Replace assertions for “Local coding agent” and “Open a workspace to begin.” with a test that reads a `dashboard-unavailable` diagnostic through `readRecoveryDiagnostic()` and renders `DesktopRecovery`. Require a `role="alert"` naming Dashboard, its stable code, correction, and diagnostic identifier; require enabled `Retry Dashboard` and `Copy diagnostic` buttons. While retry is pending, require both controls to be disabled. A successful retry must call the bridge and leave the local page for Main navigation; a recovery retry must replace the displayed diagnostic. Assert initial rendering never calls `retryDashboard()`.

- [ ] **Step 2: Run the renderer tests and observe the welcome assertions fail**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/desktop-startup.spec.ts apps/desktop/tests/desktop-recovery.snapshot.tsx
```

Expected: FAIL until the welcome shell and metadata startup path are removed.

- [ ] **Step 3: Implement recovery-only local rendering**

Make the local `index.html` a recovery bootstrap document with `connect-src 'none'`: no inline script, remote source, broad `ws:`, or network retry. The Runtime-owned Dashboard response CSP permits only its exact local `ws://127.0.0.1:<port>` event-stream origin (or `'self'` where the same origin is used), never broad `ws:`. `DesktopStartup` reads Main's redacted diagnostic and renders `DesktopRecovery`; it never starts, attaches, mints, navigates, or retries. Do not render a fake workspace, a conversation placeholder, product metadata, or Dashboard content.

- [ ] **Step 4: Implement retry and copy behavior without local persistence**

`DesktopRecovery` owns pending UI state only. Only the Retry button awaits `bridge.retryDashboard()`; its Copy button awaits `bridge.copyRecoveryDiagnostic()` and announces “Diagnostic copied” without reading text back. It must not receive or cache data-root paths, tokens, credentials, raw errors, or process information. Main performs a fresh attachment and handoff before reloading the recovered Dashboard. The ordinary browser path remains the CLI/Web-owned copyable `harness web` command, not this Electron-only recovery UI.

- [ ] **Step 5: Remove welcome-shell tests and add the keyless snapshot**

Delete `DesktopShell` and its snapshot. Record a keyless snapshot of only the recovery page, including the visible redacted diagnostic fields and controls. Assert the snapshot excludes fixture tokens, paths, and credentials. This replaces—not supplements—the welcome-shell assertion.

- [ ] **Step 6: Run the focused renderer checks**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/desktop-startup.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-recovery.snapshot.tsx
```

Expected: a user sees either a real Dashboard after Main navigation or an actionable local recovery page, never a ready-looking empty shell.

- [ ] **Step 7: Commit the recovery renderer**

```powershell
git add -A apps/desktop/src/renderer apps/desktop/tests
git diff --cached --check
git commit -m "feat(desktop): replace welcome shell with recovery"
```

### Task 4: Implement the authenticated Dashboard focus mode and engineering workbench

**Files:**

- Modify: `packages/client/web/src/app.tsx`
- Modify: `packages/client/web/src/AppRoot.module.css`
- Modify: `packages/client/web/src/boot.tsx`
- Modify: `packages/client/web/tests/app.client.spec.tsx`
- Create: `apps/web/tests/dashboard-workbench.e2e.ts`
- Create: `apps/web/tests/dashboard-ready.e2e.ts`

**Interfaces:**

- Consumes: the existing authenticated client connection, workspace/session/tool/todo/deliverable projections, and Foundation's exact authenticated Dashboard control operations backed by `observeActiveWork(): Promise<ActiveWorkStatus>` and `stopOwnUiWork(): Promise<OwnUiWorkStopResult>`.
- Produces: `EngineeringWorkbench` with `focus` state and exactly five panel ids: `'files' | 'diff' | 'terminal' | 'artifacts' | 'tasks'`; each panel renders Runtime-backed data and invokes the existing authenticated action path. It also produces the non-secret `data-harness-dashboard-ready="true"` marker only after `AppWebEntry` completes authenticated application boot.

- [ ] **Step 1: Write failing Dashboard client and authenticated e2e tests**

Extend `app.client.spec.tsx` with fixture client stores for a workspace file tree, a diff-bearing tool event, a terminal transcript, deliverables, and todos. Require the focus control to hide the surrounding Dashboard chrome while retaining the active session and to restore it without reconnecting. Require each of Files, Diff, Terminal, Artifacts, and Tasks to select its panel, render the corresponding authenticated projection, and route its action through the existing client command/service rather than Electron preload or fixture globals. Require the active-work indicator to render Foundation's status unchanged and its safe-stop action to issue only the exact Foundation-backed Dashboard operation.

Create `dashboard-workbench.e2e.ts` against the keyless Runtime-hosted Dashboard fixture. Seed each projection through the supported Runtime test API, authenticate through the real handoff/cookie flow, and require DOM/test hooks for focus and all five panel states and actions. Prove no panel receives data through `window.harnessDesktop`, local recovery state, localStorage, or a new Desktop-specific API. Create `dashboard-ready.e2e.ts` to require the ready marker only after cookie-authenticated Dashboard boot, to reject an unauthenticated response and a failed plugin boot, and to prove the marker has no origin, handoff, cookie, token, credential, path, process, or session field.

- [ ] **Step 2: Run the Dashboard tests and observe the missing owner**

Run:

```powershell
pnpm exec vitest run packages/client/web/tests/app.client.spec.tsx
pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/tests/dashboard-workbench.e2e.ts apps/web/tests/dashboard-ready.e2e.ts
```

Expected: FAIL because the current Dashboard has neither an engineering-workbench composition nor an authenticated-ready marker.

- [ ] **Step 3: Implement the Dashboard-owned views and ready marker**

Implement `EngineeringWorkbench` in `packages/client/web/src/app.tsx` and mount it through `buildRenderApp`; it owns focus state, panel selection, accessible labels, and composition of existing client projections. Add its scoped styles to `AppRoot.module.css`. Files uses the selected workspace projection and file action; Diff uses the selected tool/diff projection; Terminal uses the attached terminal projection and input action; Artifacts uses deliverables; Tasks uses the todo projection and update action. All requests use the existing authenticated connection and Foundation's existing control routes; no panel reads `HARNESS_HOME`, endpoint records, cookies, handoffs, credentials, or Electron APIs. After `AppWebEntry` has settled every entry active and the authenticated Dashboard view is mounted, set only `data-harness-dashboard-ready="true"` on its root; clear it on dispose and leave it absent on every boot failure.

- [ ] **Step 4: Run focused Dashboard validation**

Run:

```powershell
pnpm exec vitest run packages/client/web/tests/app.client.spec.tsx packages/client/web/tests/app-root.client.spec.tsx
pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/tests/dashboard-workbench.e2e.ts apps/web/tests/dashboard-ready.e2e.ts
```

Expected: the real authenticated Dashboard—not a Desktop shell—owns focus and all five workbench panels, while the ready marker proves only successful authenticated boot.

- [ ] **Step 5: Commit the Dashboard workbench**

```powershell
git add packages/client/web apps/web
git diff --cached --check
git commit -m "feat(web): add the authenticated engineering workbench"
```

### Task 5: Lock down Desktop navigation and prove the real Electron journey

**Files:**

- Modify: `apps/desktop/src/main/window-options.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tests/window-options.spec.ts`
- Delete: `apps/desktop/tests/desktop-shell.e2e.ts`
- Create: `apps/desktop/tests/desktop-dashboard.e2e.ts`
- Create: `apps/desktop/tests/desktop-recovery.e2e.ts`
- Create: `apps/desktop/tests/support/runtime-fixture.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**

- Consumes: the Runtime-foundation test entry and the CLI/Web plan's already-authenticated loopback Dashboard, handoff exchange, cookie, CSP, and keyless Dashboard boot manifest.
- Produces: an Electron test path that reaches the same Dashboard composition as `apps/web`, plus a recovery/retry path with no privileged renderer access.

- [ ] **Step 1: Write failing Electron security and Dashboard e2e tests**

Create `desktop-dashboard.e2e.ts` to build/start a fixture Runtime, launch `out/main/index.js`, and wait for the process's unchanged `DesktopReadyAcknowledgement` followed by authenticated Dashboard DOM/test hooks for the actual workspace picker, session history, conversation, streaming-tool rendering, approval control, model selector, credential-reference setting, and application-setting view backed by that same Runtime. Create or update project/session state through the authenticated Dashboard and Runtime-supported test API, then observe it through Dashboard DOM/test hooks—not recovery IPC or a preload state API. Assert the bootstrap URL, clean address-bar page URL, `history.state`, every request URL/referrer/body and every request header except the authenticated session `Cookie`, browser script storage, diagnostics, and transcript output exclude the handoff; the one opaque-file-origin exchange `POST` contains it only in the raw request body, emits no CORS permission, and has a redacted captured body/diagnostic. Assert the Dashboard response CSP contains no broad `ws:`, permits only its exact loopback event-stream origin, and a foreign `ws://127.0.0.1:<different-port>` connection is denied. Assert `window.require`, `process`, `Buffer`, and a token getter are undefined; `window.harnessDesktop` exposes exactly the six versioned native operations from Task 2.

Create `desktop-recovery.e2e.ts` with a Runtime fixture that returns a redacted start failure first, then a successful attachment. Assert initial recovery reads but does not invoke retry; a user click retries once and reaches the real Dashboard; a failed click retry replaces the redacted diagnostic; and Copy calls Main's clipboard seam with redacted text. Assert an arbitrary `window.open()` creates no child window; only a documented allowlisted `https:` URL opened through `openExternalLink()` reaches Main's external-open seam, while a disallowed URL is rejected; and navigation to `http://localhost:43123` is blocked.

- [ ] **Step 2: Run e2e tests and verify the present shell cannot satisfy them**

Run:

```powershell
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/tests/desktop-recovery.e2e.ts
```

Expected: FAIL before Tasks 1–4 are complete because the built application lacks the private bootstrap transport, authenticated-ready acknowledgement, and Runtime Dashboard.

- [ ] **Step 3: Enforce Main-process navigation policy**

Keep the existing secure `webPreferences`. In Main, reject every `setWindowOpenHandler` request so no renderer request creates a child window. Dashboard links use the literal `openExternalLink()` IPC instead: Main checks the fixed `https:` host allowlist, opens only approved URLs with `shell.openExternal`, and still denies the new-window request. Permit top-level navigation only to the local recovery file or the controller's current exact `http://127.0.0.1:<port>` origin; call `event.preventDefault()` for every other navigation. Treat renderer crashes, failed loads, and Dashboard 401/hand-off expiry as a return to the local recovery document with a newly normalized redacted diagnostic; retry obtains a new attachment and handoff instead of reusing a URL.

- [ ] **Step 4: Implement the reusable keyless Runtime fixture**

The Desktop e2e adapter starts the Runtime-foundation test entry with a temporary `HARNESS_HOME`, consumes the CLI/Web plan's already-built Dashboard artifact, and reuses `packages/test-support/client-runtime` for client-runtime fixtures where its existing test contract applies. It does not create a nonexistent `packages/support` package or reimplement a static host, API, handoff exchange, cookie, CSP, event stream, or `AppWebEntry` composition. It supplies fixture project/session data through the Runtime's supported test API, never needs `DEEPSEEK_API_KEY`, exposes redacted failure injection, and has an explicit async close that waits for the Runtime listener and Electron child to exit.

- [ ] **Step 5: Run focused source and e2e validation**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts apps/desktop/tests/desktop-startup.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-recovery.snapshot.tsx apps/web/tests/built-boot.snapshot.ts
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm --filter @harness-desktop/dsh-desktop run test:e2e
```

Expected: keyless tests prove the actual Dashboard functionality and workbench state, Foundation-owned one-time handoff exchange with its sole redacted POST-body exception, exact WebSocket CSP, Main-only native access, first recovery, concurrent navigation coalescing, and success/failure user-click retry.

- [ ] **Step 6: Commit the Electron acceptance coverage**

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "test(desktop): exercise Runtime-hosted Dashboard"
```

### Task 6: Add active-work close choices and tray lifecycle

**Files:**

- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/close-policy.ts`
- Modify: `apps/desktop/src/shared/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/src/DesktopStartup.tsx`
- Modify: `apps/desktop/tests/desktop-dashboard.e2e.ts`
- Create: `apps/desktop/tests/close-policy.spec.ts`

**Interfaces:**

- Consumes: Foundation's exact `RuntimeClient.observeActiveWork(): Promise<ActiveWorkStatus>` and `RuntimeClient.stopOwnUiWork(): Promise<OwnUiWorkStopResult>`, the Desktop-owned attachment/client lifecycle from Task 1, and the authenticated Dashboard workbench DOM/test hooks from Task 4.
- Produces: a close decision with exactly `minimize-to-tray`, `safely-stop-own-ui-work`, and `cancel`, plus a tray that restores the existing window or requests the same close decision.

- [ ] **Step 1: Write failing close, tray, and Dashboard-state tests**

Create `close-policy.spec.ts` to require `observeActiveWork()` before every close decision and to use its returned `ActiveWorkStatus` unchanged. Require an active-work close request to show all three choices. `minimize-to-tray` hides but does not destroy the window or close its attachment; `safely-stop-own-ui-work` calls only `stopOwnUiWork()`, waits for its exact `OwnUiWorkStopResult`, and only then closes this Desktop attachment/client without stopping other clients; `cancel` leaves the window and work untouched. Require a close with no active UI work to release the Desktop attachment/client normally. Assert no branch invents a process kill, Runtime stop, background-lease release, session identifier, or another client's cancellation. Keep the Task 4 authenticated Dashboard focus/workbench assertions as the product UI owner.

- [ ] **Step 2: Run the tests and observe the missing lifecycle behavior**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/close-policy.spec.ts apps/desktop/tests/runtime-dashboard.spec.ts
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts --grep "workbench|focus|tray"
```

Expected: FAIL until Main consumes Foundation's active-work observation and owner-scoped safe-stop results exactly.

- [ ] **Step 3: Implement only Desktop-owned close and tray behavior**

Use the platform tray only after user choice or a configured background preference, with visible Restore and Quit actions. Intercept a close by calling `observeActiveWork()` while the Desktop client owns UI work, show the three literal choices, and honor the selected result. `safely-stop-own-ui-work` waits for `stopOwnUiWork()`'s typed safe completion or redacted failure; it never sends a process kill, Runtime stop, background-lease release, or another client's session cancellation. The tray survives a hidden window and restores/focuses its existing Dashboard window; app quit follows Task 1's attachment-then-client close ordering. The Dashboard workbench remains Task 4's owner; Main owns only native lifecycle and does not duplicate its views.

- [ ] **Step 4: Run focused lifecycle and product checks**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/close-policy.spec.ts apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- --grep "close|tray|workbench|focus"
```

Expected: every close path consumes the Foundation status/result unchanged, tray hiding preserves active work, and no Desktop lifecycle branch can stop shared work.

- [ ] **Step 5: Commit the lifecycle and workbench integration**

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "feat(desktop): preserve active work through close and tray"
```

### Task 7: Verify source, built, and unpacked packaged output from clean trees

**Files:**

- Modify: `apps/desktop/tests/preload-build.spec.ts`
- Modify: `apps/desktop/tests/desktop-dashboard.e2e.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/electron-builder.config.mjs`
- Modify: `apps/desktop/package.json`

**Interfaces:**

- Consumes: Main/preload build entries and the Runtime-hosted Web asset contract.
- Produces: a packaged Desktop that carries no duplicate persistence, credential, or Dashboard runtime and still resolves the shared Runtime client from its production artifact.

- [ ] **Step 1: Write failing clean-output assertions**

Extend `preload-build.spec.ts` to remove `apps/desktop/out` before build, then require one CommonJS preload and Main output that imports the shared Runtime client but has no literal endpoint token, `HARNESS_HOME`, credential-provider implementation, or `DesktopShell`. Add an unpacked package test that removes `apps/desktop/release`, runs `package:dir`, launches the platform unpacked executable, waits for the unchanged `DesktopReadyAcknowledgement`, and repeats the real-Dashboard e2e with the keyless Runtime fixture, including the exact Dashboard WebSocket CSP and the one redacted opaque-file-origin handoff form-body exception.

- [ ] **Step 2: Run the checks and confirm stale output cannot satisfy them**

Run:

```powershell
Remove-Item -Recurse -Force apps/desktop/out, apps/desktop/release -ErrorAction SilentlyContinue
pnpm exec vitest run apps/desktop/tests/preload-build.spec.ts
```

Expected: FAIL until build configuration includes every new Main/preload dependency and the packaged launch helper exists.

- [ ] **Step 3: Keep source and production module resolution explicit**

Update `electron.vite.config.ts` aliases only for source-owned, Node-safe Runtime client entry points; production output resolves the built workspace export. Keep renderer bundling separate from Main/preload, and do not add a Runtime implementation, database, credential provider, or Web bundle copy to Electron Builder `files`. The Runtime static host remains the sole Dashboard asset owner.

- [ ] **Step 4: Make packaging inspectable and non-publishing**

Keep `package` and `package:dir` at `--publish never`. Include only the Main, preload, local recovery document, and their declared production dependencies. Add a package test that verifies the unpacked application starts the Runtime fixture, consumes the exact Main stdout acknowledgement unchanged, and reaches the same Dashboard selectors as the source/built test; do not accept merely obtaining an Electron process, a readiness lookalike, or a welcome heading. The installed-artifact fixture in the icon/release plan consumes the same JSONL acknowledgement unchanged, with no alternate IPC, DOM guess, or privileged test channel.

- [ ] **Step 5: Run source, built, and packaged verification from clean output**

Run:

```powershell
Remove-Item -Recurse -Force apps/desktop/out, apps/desktop/release -ErrorAction SilentlyContinue
pnpm --filter @harness-desktop/dsh-desktop run typecheck
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm exec vitest run apps/desktop/tests/preload-build.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e
pnpm --filter @harness-desktop/dsh-desktop run package:dir
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts --grep "unpacked"
```

Expected: regenerated output and the unpacked package both emit the same redacted readiness acknowledgement only after the authenticated real Dashboard loads and enforce the same authenticated DOM, handoff, CSP, native-bridge, and lifecycle guarantees; no test depends on residue in `out/` or `release/`.

- [ ] **Step 6: Run final scoped repository validation and commit**

Run:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

Expected: all commands exit 0. Then commit only the implementation work:

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "build(desktop): package the Runtime Dashboard host"
```

## Plan self-review

- Spec coverage: Task 1 keeps start-or-attach and the local control token in Main, uses only the Foundation body-only handoff API, and emits one redacted ready acknowledgement after authenticated Dashboard boot; Task 2 projects only Foundation's redacted diagnostic into the renderer; Task 3 removes the welcome shell and adds read-only recovery/user-click retry/copy; Task 4 owns the real authenticated Dashboard focus/workbench implementation and ready marker; Task 5 verifies Dashboard functionality, privilege isolation, recovery, and the acknowledgement through Electron; Task 6 consumes Foundation active-work observation and owner-scoped safe-stop exactly; Task 7 verifies clean source, built, and unpacked output, while the icon/release plan consumes the same acknowledgement for installed-artifact smoke.
- No Desktop-private state: every task consumes Runtime discovery/control and the existing Web composition. No task creates Desktop persistence, a credential provider, a Runtime server, or a Dashboard duplicate.
- Security review: renderer IPC has six versioned literal operations; token-bearing objects stop inside Main; the renderer receives only a pure field projection of Foundation's redacted diagnostic; all successful Dashboard navigations use a fresh Foundation `DashboardNavigation` only through the Main bootstrap transport; the bootstrap's owner-only directory and document are verified and a broader-access location is rejected, while its `expiresAt` timer cleans up exactly once on no dispatch, dispatch failure, exchange success or failure, or expiry. No handoff reaches a file URL, launch argument, log, URL, hash, query, header, referrer, history, storage, renderer, diagnostic, or transcript, and it appears only in the bootstrap HTML hidden form value and the single opaque-file-origin form POST body whose capture is redacted. The exchange sends no CORS permission, while normal Dashboard traffic uses the exact Runtime origin and the HttpOnly session cookie. The stdout acknowledgement has only constant kind/version fields.
- Placeholder scan: no task relies on unspecified tests, generic error handling, or welcome-shell acceptance.
