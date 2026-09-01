# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

This package owns the shared local Harness Runtime described by the [unified local Runtime design](../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md). The Runtime is the sole persistence owner for one `HARNESS_HOME`. Native clients use its public connector and client API instead of opening session, settings, workspace, storage, or credential-reference state directly.

## Configuration and ownership

`HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`. `resolveHarnessHome()` reports `DSH_HOME` only as a legacy import source and never selects it as the writable target.

The Runtime acquires an exclusive per-home lock before booting the shipped base-and-Web Cordis composition. One injected `HarnessHomeProvider` supplies the selected root to every writer. The lock records PID and operating-system process-start identity; a serialized recovery guard replaces a stale record only after proving that exact identity absent, and release removes only the acquiring Runtime's unchanged lock.

## Private endpoint and authentication

The composed WebServer binds an operating-system-assigned port on `127.0.0.1`. Its owner-only endpoint record contains protocol version, Runtime identity, port, process identity, and a private access token. Publication and retirement use protected same-directory files and atomic renames; retirement restores a claimed replacement without overwriting a newer endpoint.

Native control requires the exact loopback authority and bearer token. A native caller creates a 60-second, single-use, body-only handoff bound to its Runtime client owner; the exchanged browser cookie retains that owner for Dashboard prompt and active-work control. An ownerless browser launch receives a stable cookie-derived owner instead. `POST /_harness/handoff` accepts the handoff only from one URL-encoded form body, sends no CORS permission, and returns a clean redirect with a session `HttpOnly; SameSite=Strict; Path=/` cookie without an expiry attribute. Malformed, unknown, expired, or replayed handoffs receive a no-store `403` HTML recovery document containing only `Dashboard connection expired. Run harness web to reconnect.` Dashboard API and event requests require the cookie and exact Runtime origin, providing cookie-only Dashboard authentication. The launcher-owned cleanup controller removes only its private bootstrap document and directory after dispatch, exchange settlement, or expiry.

## Non-disclosure guarantees

- The package root never exports the endpoint parser, writer, filename, private record, access token, handoff secret, or browser session credential.
- URLs, launch arguments, diagnostics, transcripts, browser script storage, Renderer IPC, and public Runtime values never contain those secrets.
- Public status, migration, lease, busy, active-work, terminal, and diagnostic values never expose credential values, raw filesystem errors, or the selected Harness home.
- Authenticated response parsing rejects exact private-token disclosure, selected-home disclosure at an absolute path-component boundary, malformed fields, invalid branded values, and configured byte or item limits as `RuntimeProtocolError`.

## Public Runtime API and failures

`createRuntimeConnector()` alone discovers the endpoint and retains its token inside authenticated request closures. `connect({ start: false })` performs read-only discovery and throws `RuntimeUnavailableError` without creating the home, lock, endpoint, or process. `connect({ start: true })` serializes racing starts through the owner lock, waits for an authenticated healthy owner, and attaches successful callers to that Runtime.

`RuntimeClient` exposes redacted status, the stable `web` background lease, durable legacy migration, owner-scoped active-work control, terminal attachments, Dashboard attachments, and independent close. `TerminalConnection` submits tasks and approvals through the composed API and Agent owners, runs registered model, permission, session, and command controls, streams bounded protocol events, cancels only its correlated operation, and closes only its attachment. `DashboardAttachment` creates a body-only handoff and releases independently. Closing an attachment never cancels active work. A Dashboard stop or Runtime close before prompt correlation aborts that carrier's admission; a raced late message with the same `rpcId` is removed before the Agent can claim a Turn. Cancellation of claimed work waits for Agent quiescence and ends the Runtime work lease even when no separate `turn/end` callback arrives.

`RuntimeUnavailableError` identifies absence, `RuntimeBusyError` identifies a same-session writer and carries its branded session id, and `RuntimeProtocolError` identifies an incompatible, malformed, oversized, or secret-bearing local response. `normalizeRecoveryDiagnostic()` projects these and unknown local failures into stable, token-, path-, and secret-free recovery fields with a copyable diagnostic id.

## Migration and provider ownership

Legacy decisions and results live under `HARNESS_HOME` and pass through one Runtime-owned transaction queue and private Runtime retainer. Acceptance copies supported non-secret roots once into an otherwise empty target; decline persists before acceptance; retry accepts only an exact retryable collision or failure. Concurrent callers replay the committed result, source directories remain intact, and public failure values contain only redacted correction data.

The canonical composition mounts the API, Dashboard assets, session, settings, workspace, storage, and credential-reference providers behind the same ownership lock. Credential values remain with their credential provider; only references enter Runtime-owned state.

The `desktop-update` settings namespace stores the selected `stable`, `beta`, or `nightly` channel and one fixed-format redacted outcome through that same settings provider. Native control may record only semantic versions, one of the fixed result kinds and codes, and an optional last-known-good version; Dashboard control may read or change only the channel. The Runtime does not fetch, verify, stage, apply, or roll back an artifact, and it has no production update trust root.

Only native control may read the last redacted outcome; Dashboard control cannot read or write it.

## Lifecycle and leases

The Runtime counts actual client attachments, Agent work, and the named background lease. Idle shutdown begins only when all three counts are zero. Migration and terminal-control transactions retain the Runtime until settlement, and direct disposal rejects without starting shutdown while any retainer remains.

Ordered shutdown closes private control and settles its operations, flushes durable sessions, retires the endpoint, releases the lock, and disposes the Cordis root. Every stage settles before independent failures are reported. Background retention keeps a healthy process alive but does not supervise or restart it.

## Source and built entry points

Built full-product evidence boots the canonical base-and-Web composition through the declared `lib/bin.js`, loads the built Runtime artifact, and exercises public `RuntimeConnector` status and background-lease control against that process.

`RuntimeConnector` launches the matching Runtime entry with the caller's Node executable. When Electron Main is the caller, the child environment alone sets `ELECTRON_RUN_AS_NODE=1`, so Electron's executable runs the Runtime script as Node; ordinary Node callers retain their existing environment. The Runtime bin consumes that marker before composition, so agent subprocesses and applications opened later cannot inherit Electron's Node mode. This setting never reaches Renderer or unrelated Electron child processes.

The declared source entry `src/bin.ts` boots the same composition after `pnpm run build:lib`, because Typert contributions and browser bundles remain generated `lib/` artifacts. Its direct-bin process evidence observes source module loading, the generated-artifact boundary, endpoint publication, redacted startup failure, and ownership cleanup on shutdown; it does not by itself prove public connector parity.

Source public-connector and control behavior is exercised through a Loader-launched, source-only backend fixture with workspace `lib/` imports denied and its test backend and replay overlays declared explicitly. That evidence validates source package/control compatibility without representing the fixture as the full-product source bin. Product presentation layers remain separate consumers of `RuntimeConnector` and `RuntimeClient`.

## Model Experience

### Runtime ownership and control

#### What the model sees

`RuntimeConnector` discovery, ownership, authentication, status, migration, attachments, leases, and diagnostics add no prompt text, messages, tool schemas, or tool results. A submitted terminal task enters the existing session API as the ordinary durable user message and Agent turn; the Runtime adds no transport wrapper.

#### Token effect

Runtime control consumes no model tokens. A submitted task and its answer consume their ordinary model input and output tokens.

#### KV Cache effect

Runtime metadata does not change the model request prefix. Model-visible tasks and command effects retain the existing session path's cache behavior.

## Known Limitations and Deferred Work

- **Background retention is not supervision** — the named Web lease does not restart the Runtime after a crash, sign-out, or upgrade.
- **Skill admission still has a cross-package race** — the API admits an exact user-invocable skill from one complete catalog observation, but its definition can change before the pre-step consumer loads it. Closing that interval requires a shared admission token or equivalent skill/API transaction; the Runtime does not claim a universal fail-closed guarantee for that interval.
- **Update preferences are not an updater** — the Runtime persists a channel and redacted result only; trusted manifest retrieval, artifact verification, installation, and rollback remain unavailable until a production trust configuration is supplied.
