# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

Provides the host foundation for the single local Harness Desktop Runtime. It resolves one writable data root, acquires its exclusive owner lock before stateful services mount, and persists the Runtime's private loopback endpoint.

`HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`. `resolveHarnessHome()` reports `DSH_HOME` only as a legacy import source and never selects it as the writable target.

The owner lock records both PID and operating-system process-start identity. A short-lived cross-process recovery guard serializes acquisition, identity probing, and stale replacement, so contenders cannot both recover one record. A contender preserves a live or unverifiable owner and recovers a stale record only after the recorded identity is proved absent. Release removes only the acquiring Runtime's unchanged lock.

The endpoint record contains the protocol version, Runtime identity, port, process identity, and private access token. The internal writer protects a same-directory temporary file before its atomic rename; the internal reader verifies owner-only `0600` access on POSIX or a current-user-only Windows DACL before reading. Retirement atomically renames the current endpoint to a private tombstone and rechecks its Runtime identity there; a claimed replacement is restored without overwriting a newer endpoint. The package root exports only token-free status and ownership types, never the endpoint parser, writer, filename, or token-bearing record.

`createRuntimeConnector()` is the only application entry that discovers the private endpoint and retains its token. `connect({ start: false })` reports typed absence without creating the selected home, lock, endpoint, or process; `connect({ start: true })` serializes racing process starts through the owner lock and attaches every successful caller to the same Runtime. Public success values and `normalizeRecoveryDiagnostic()` contain no endpoint fields, token, credential value, raw filesystem error, or absolute Harness home.

Runtime-local routes accept native control only at the exact `127.0.0.1` authority with the private endpoint bearer token. A native caller mints a 60-second, single-use opaque handoff; `POST /_harness/handoff` consumes that value only from one URL-encoded form body, emits no CORS permission, and redirects cleanly after setting a session `HttpOnly; SameSite=Strict; Path=/` cookie with no expiry. The in-memory authenticator requires that exact Runtime Origin and cookie for Dashboard API and event carriers, while a launcher-owned cleanup controller removes only its bootstrap document and owner directory once after dispatch, exchange settlement, or expiry. Tokens, handoffs, and session values stay outside public exports, diagnostics, URLs, and browser script storage.

The Runtime owner acquires the lock before it boots the shipped base and Web composition, including API, static Dashboard, session, settings, workspace, storage, and credential-reference providers. It requires the composition to expose a healthy `127.0.0.1` WebServer on an OS-assigned port, mounts private authenticated control before publishing the endpoint, and shares one injected `HarnessHomeProvider` with every writer. It counts actual client attachments, agent work, and explicit background leases, and begins configured idle shutdown only when all three are absent. Direct internal disposal has the same zero-retainer precondition and rejects without starting shutdown while any retainer remains. Ordered shutdown settles every durable flush, removes the endpoint, releases the lock, and disposes the Cordis root; independent failures are reported after every stage settles. `startRuntime()` and its handle remain orchestration internals; applications use `RuntimeConnector` and `RuntimeClient`.

Each `RuntimeClient`, `TerminalConnection`, and `DashboardAttachment` owns one independent attachment and releases only that attachment through `close()`. The Runtime admits at most one write-type operation per session and returns the typed `observe`, `new-session`, and `wait` recovery choices to a competing client while leaving reads concurrent; the session's durable `turn/end` releases that admission. Active-work observation and safe stop are scoped to the requesting UI owner. The per-home Web background lease has the stable id `web`; repeated acquisition and release are serialized and idempotent across clients, and release does not cancel work or disconnect attachments.

Legacy import decisions and results are stored under `HARNESS_HOME` and are shared by native and authenticated Dashboard control requests. Acceptance copies supported non-secret roots once into an otherwise empty target, decline persists, retry reuses only a recorded retryable result, and every source directory remains intact. Collision and failure results expose only a redacted diagnostic and correction.

The declared `lib/bin.js` and direct `src/bin.ts` development entry both boot the complete shipped composition. Source entry execution requires `pnpm run build:lib` first because Typert contributions and browser bundles are build-generated artifacts; clean source-only integration fixtures must declare any backend-only overlay explicitly rather than changing the product composition.

## Model Experience

### Runtime ownership and endpoint records

#### What the model sees

Nothing. `acquireRuntimeLock()` and the endpoint-record primitives add no prompt text, messages, tool schemas, or tool results.

#### Token effect

None. Runtime access tokens remain in private control-plane files and never enter a model request.

#### KV Cache effect

None. This package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Background retention is not supervision** — the named Web lease keeps a healthy Runtime alive, but it does not restart the process after a crash, sign-out, or upgrade.
