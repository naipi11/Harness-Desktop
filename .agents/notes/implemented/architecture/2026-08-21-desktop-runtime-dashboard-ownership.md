# Agent Note: Desktop Runtime Dashboard ownership

Status: implemented

English | [中文](2026-08-21-desktop-runtime-dashboard-ownership.zh.md)

## Problem

The Desktop window needs an authenticated view of the shared local Runtime without receiving the native endpoint token, browser handoff, session cookie, Runtime data root, or attachment object. Window destruction, explicit recovery, application shutdown, and asynchronous Web boot can race, while closing Desktop must not stop shared Runtime work or release another client's lease.

A process readiness signal is useful for source, built, and packaged smoke tests, but a window load event alone does not establish that the clean Dashboard origin completed cookie-authenticated application boot.

## Decision

Electron Main owns the Runtime client, each Dashboard attachment, and the browser handoff transport. `RuntimeDashboardController` shares concurrent startup, retains a failed attachment until explicit retry or window closure, treats a closed window as terminal, and closes an attachment published during a close race without navigating it. Window closure releases only that attachment; application shutdown closes all Desktop attachments before their Runtime clients. These operations never stop Runtime work, cancel a turn, or release the named Web lease.

Each startup mints a fresh Foundation `DashboardNavigation`. The Main-only transport validates an exact `http://127.0.0.1:<port>` origin and an unexpired opaque handoff, writes the handoff only into one hidden field in an owner-only local document, and loads only its secret-free file path. The top-level form POST carries the handoff from an opaque file origin. The Runtime consumes it once, returns a clean 303 with an HttpOnly `SameSite=Strict` session cookie and no CORS permission, and reflects no request body into diagnostics.

The transport removes its document and directory through one idempotent cleanup operation after dispatch failure, exchange success or failure, or handoff expiry. A reused transport rejects a second dispatch of the same handoff.

The clean Dashboard performs its cookie-authenticated control preflight before `AppWebEntry.run()`. The Web boot resolves `true` only after every plugin activates and the application UI settles; a rendered boot failure resolves `false`. Only a `true` result sets `data-harness-dashboard-ready="true"` on the Web root. Main validates the exact clean URL and waits for that marker on every navigation; only the constant `{"kind":"desktop-dashboard-ready","version":1}` JSONL output is limited to once per Desktop process. An abort or navigation failure that wins while the marker probe is pending cannot emit the acknowledgement.

The [authenticated Dashboard workbench](2026-08-21-authenticated-dashboard-workbench.md) owns browser projections and cookie-scoped prompt work after this readiness point; it does not move connection or attachment lifecycle into Renderer.

Main denies every renderer-created child window and permits top-level navigation only to the local recovery document or the current attachment's exact loopback origin. It binds Dashboard response CSP to the owning `webContents`: `connect-src` contains only `'self'` and that origin's exact WebSocket port. A main-frame load failure, renderer loss, or authenticated Dashboard-control rejection enters one coalesced recovery flight for that window. Retry refreshes the client-reported origin before minting another handoff; an unreachable or changed Runtime owner is removed from admission and closed before Main reconnects a replacement. A per-window retirement fence blocks replacement while close is pending or rejected; later retry first retries that same close. A failed close remains in process-shutdown tracking, rejects retry, and prevents replacement admission; rejected attachment and client releases clear only their failed flight so shutdown can genuinely retry them. An unowned or ambiguous response retains its original headers and cannot change another window's recovery state.

Every attachment, transport, navigation, marker, and load failure is converted through `normalizeRecoveryDiagnostic` before Main retains it for recovery UI. The result contains no URL, port, process identity, Runtime home, token, handoff, cookie, or attachment value.

## Alternatives considered

**Put the handoff in a URL, fragment, header, or preload API.** These carriers enter browser history, navigation capture, referrers, logs, renderer-visible state, or broader IPC. The owner-only form body keeps the handoff in the one exchange that consumes it.

**Let Renderer or preload attach and retry.** This would expose privileged Runtime objects across the renderer boundary and permit implicit retries after a destroyed window. Main retains lifecycle ownership and Renderer requests only explicit recovery operations.

**Treat `did-finish-load` or the first process acknowledgement as permanent readiness.** The Dashboard marker appears after asynchronous authenticated boot, and every replacement navigation needs independent URL and marker validation. A one-time output record does not weaken per-navigation verification.

## Consequences

Desktop startup depends on a private temporary file and an extra browser exchange, and Main must retain cleanup, expiry, navigation, response ownership, recovery, and window-close state until they settle. Real Chromium and Electron coverage pins the opaque-origin POST, 303 and cookie sequence, clean URL, absent CORS permission, exact WebSocket CSP, denied foreign navigation, and lack of URL, referrer, storage, header, console, or DOM leakage. Unit coverage pins concurrent startup, explicit retry, closed-window races, per-navigation marker checks, pending-probe aborts, and attachment-before-client shutdown.

The Web root marker is a non-secret synchronization attribute, not a renderer control API. The stdout acknowledgement is likewise process-observable only and carries no Runtime control data.
