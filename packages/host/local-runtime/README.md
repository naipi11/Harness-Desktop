# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

Provides the host foundation for the single local Harness Desktop Runtime. It resolves one writable data root, acquires its exclusive owner lock before stateful services mount, and persists the Runtime's private loopback endpoint.

`HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`. `resolveHarnessHome()` reports `DSH_HOME` only as a legacy import source and never selects it as the writable target.

The owner lock records both PID and operating-system process-start identity. A short-lived cross-process recovery guard serializes acquisition, identity probing, and stale replacement, so contenders cannot both recover one record. A contender preserves a live or unverifiable owner and recovers a stale record only after the recorded identity is proved absent. Release removes only the acquiring Runtime's unchanged lock.

The endpoint record contains the protocol version, Runtime identity, port, process identity, and private access token. The internal writer protects a same-directory temporary file before its atomic rename; the internal reader verifies owner-only `0600` access on POSIX or a current-user-only Windows DACL before reading. Retirement atomically renames the current endpoint to a private tombstone and rechecks its Runtime identity there; a claimed replacement is restored without overwriting a newer endpoint. The package root exports only token-free status and ownership types, never the endpoint parser, writer, filename, or token-bearing record.

Runtime-local routes accept native control only at the exact `127.0.0.1` authority with the private endpoint bearer token. A native caller mints a 60-second, single-use opaque handoff; `POST /_harness/handoff` consumes that value only from one URL-encoded form body, emits no CORS permission, and redirects cleanly after setting a session `HttpOnly; SameSite=Strict; Path=/` cookie with no expiry. The in-memory authenticator requires that exact Runtime Origin and cookie for Dashboard API and event carriers, while a launcher-owned cleanup controller removes only its bootstrap document and owner directory once after dispatch, exchange settlement, or expiry. Tokens, handoffs, and session values stay outside public exports, diagnostics, URLs, and browser script storage.

The Runtime owner acquires the lock before it boots one application composition, requires that composition to expose a healthy `127.0.0.1` WebServer on an OS-assigned port, then publishes the private endpoint. It shares one injected `HarnessHomeProvider` with that composition, counts actual client attachments, agent work, and explicit background leases, and begins configured idle shutdown only when all three are absent. Ordered shutdown flushes composed durable services, removes the endpoint, releases the lock, and disposes the Cordis root. `startRuntime()` and its handle are orchestration internals; the connection and control API is deferred to the Runtime client layer.

## Model Experience

### Runtime ownership and endpoint records

#### What the model sees

Nothing. `acquireRuntimeLock()` and the endpoint-record primitives add no prompt text, messages, tool schemas, or tool results.

#### Token effect

None. Runtime access tokens remain in private control-plane files and never enter a model request.

#### KV Cache effect

None. This package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Runtime client connection and control are deferred** — the next layer owns endpoint discovery, authenticated attachment, and session-control APIs.
