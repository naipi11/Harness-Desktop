# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

Provides the host foundation for the single local Harness Desktop Runtime. It resolves one writable data root, acquires its exclusive owner lock before stateful services mount, and persists the Runtime's private loopback endpoint.

`HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`. `resolveHarnessHome()` reports `DSH_HOME` only as a legacy import source and never selects it as the writable target.

The owner lock records both PID and operating-system process-start identity. A short-lived cross-process recovery guard serializes acquisition, identity probing, and stale replacement, so contenders cannot both recover one record. A contender preserves a live or unverifiable owner and recovers a stale record only after the recorded identity is proved absent. Release removes only the acquiring Runtime's unchanged lock.

The endpoint record contains the protocol version, Runtime identity, port, process identity, and private access token. The internal writer protects a same-directory temporary file before its atomic rename; the internal reader verifies owner-only `0600` access on POSIX or a current-user-only Windows DACL before reading. Retirement atomically renames the current endpoint to a private tombstone and rechecks its Runtime identity there; a claimed replacement is restored without overwriting a newer endpoint. The package root exports only token-free status and ownership types, never the endpoint parser, writer, filename, or token-bearing record.

`createRuntimeConnector()` is the only application entry that discovers the private endpoint and retains its token. `connect({ start: false })` reports typed absence without creating the selected home, lock, endpoint, or process; `connect({ start: true })` serializes racing process starts through the owner lock and waits for an authenticated healthy replacement before attaching every successful caller to the same Runtime. Each authenticated HTTP response is capped at 1 MiB before UTF-8 decoding or JSON parsing, then every wire success/error is parsed with exact fields, bounded strings, and branded-value validation before projection. A terminal page is limited to 256 events and 256 KiB of encoded events, with 64 KiB per human-readable event string. Malformed or oversized values, and any response containing the exact private endpoint token or selected absolute Harness home, reject as `RuntimeProtocolError`; public status, migration, lease, busy, active-work, terminal, and diagnostic values contain no endpoint field, token, credential value, raw filesystem error, or selected Harness home. Other user workspace paths remain valid terminal content.

Runtime-local routes accept native control only at the exact `127.0.0.1` authority with the private endpoint bearer token. A native caller mints a 60-second, single-use opaque handoff; `POST /_harness/handoff` consumes that value only from one URL-encoded form body, emits no CORS permission, and redirects cleanly after setting a session `HttpOnly; SameSite=Strict; Path=/` cookie with no expiry. The in-memory authenticator requires that exact Runtime Origin and cookie for Dashboard API and event carriers, while a launcher-owned cleanup controller removes only its bootstrap document and owner directory once after dispatch, exchange settlement, or expiry. Tokens, handoffs, and session values stay outside public exports, diagnostics, URLs, and browser script storage.

The Runtime owner acquires the lock before it boots the shipped base and Web composition, including API, static Dashboard, session, settings, workspace, storage, and credential-reference providers. It requires the composition to expose a healthy `127.0.0.1` WebServer on an OS-assigned port, mounts private authenticated control before publishing the endpoint, and shares one injected `HarnessHomeProvider` with every writer. It counts actual client attachments, agent work, and explicit background leases, and begins configured idle shutdown only when all three are absent. Dashboard migration and terminal-control transactions hold a private Runtime retainer until settlement, so idle shutdown cannot retire ownership while they mutate durable state. Direct internal disposal has the same zero-retainer precondition and rejects without starting shutdown while any retainer remains. Ordered shutdown first closes the control service to cancel and settle its owned operations, then settles every durable flush, removes the endpoint, releases the lock, and disposes the Cordis root; independent failures are reported after every stage settles. `startRuntime()` and its handle remain orchestration internals; applications use `RuntimeConnector` and `RuntimeClient`.

Each `RuntimeClient`, `TerminalConnection`, and `DashboardAttachment` owns one server-mapped attachment; an authenticated parent cannot release, submit through, cancel, or control another parent's child id. `close()` commits closed only after the idempotent server release succeeds, so a transient transport failure can retry the same release without issuing a duplicate after success. Closing an attachment does not cancel active work. Cancellation removes only this operation's still-unclaimed inbox message, or signals the exact claimed Agent operation with inbox preservation; unrelated queued and steering messages remain. The Runtime then waits for the correlated turn when one exists and for Agent idle before releasing only that operation's work lease.

`openTerminal()` creates or resumes through the composed API owner and `submit()` enters a real Agent turn. The Runtime correlates the request's `rpcId` with the exact inbox claim, turn number, Agent instance, and `turn/end`, then waits for `agent.whenIdle()` before admitting a replacement; a stale turn or cancel completion cannot clear a later lease. An exact slash command executes through `ApiProxy.sessions.prompt` and the composed command owner, emits its safe success text, logs `command/run` and `command/done`, and releases its exact work lease immediately because no inbox claim or turn exists. Terminal events derive from the live session and approval mechanisms: streamed assistant text, tool activity, model/permission changes, and approval questions. Approval responses are accepted only from the terminal that owns the active Agent operation. `runControl()` resumes a terminal, queries or selects its model, changes its permission preset, executes a registered command, or closes only that terminal for `exit`; each operation is owner-checked and Runtime-retained, and unavailable, busy, rejected, or wrong-owner requests reject without synthetic success.

The per-home Web background lease has the stable id `web`; repeated acquisition and release are serialized and idempotent across clients, and release does not cancel work or disconnect attachments.

Legacy import decisions and results are stored under `HARNESS_HOME` and are shared by native and authenticated Dashboard control requests through one Runtime-owned transaction queue and private Runtime retainer. Acceptance copies supported non-secret roots once into an otherwise empty target; concurrent accepts replay the committed success, and a later decline cannot overwrite it. Decline persists before acceptance, retry runs only from an exact retryable collision/failure state, and every source directory remains intact. The state file is capped at 64 KiB before UTF-8 decoding and JSON parsing; durable records reject unknown, missing, extra, path-bearing, or invalid-branded fields before public projection. Collision and failure results expose only a redacted diagnostic and correction.

The declared `lib/bin.js` and direct `src/bin.ts` development entry both boot the complete shipped composition. Source entry execution requires `pnpm run build:lib` first because Typert contributions and browser bundles are build-generated artifacts; clean source-only integration fixtures must declare any backend-only overlay explicitly rather than changing the product composition.

## Model Experience

### Runtime ownership and endpoint records

#### What the model sees

Nothing. `acquireRuntimeLock()` and the endpoint-record primitives add no prompt text, messages, tool schemas, or tool results.

#### Token effect

None. Runtime access tokens remain in private control-plane files and never enter a model request.

#### KV Cache effect

None. These Runtime ownership and endpoint-record primitives neither assemble nor send a provider request.

### Terminal Agent operations

#### What the model sees

A terminal task is admitted through the existing session API as the same durable user message and Agent turn used by the Dashboard. The Runtime adds no wrapper prompt or transport metadata to model-visible content. Controls that change model or permission state use their existing owners; registered slash commands retain their own logged behavior.

#### Token effect

The submitted task and resulting conversation consume their normal model input/output tokens. Runtime control, attachment ownership, status, leases, migration, busy results, and diagnostics add zero model tokens.

#### KV Cache effect

The task appends after the session's reusable prefix. Runtime control metadata does not change the request prefix; ordinary model-visible task or command effects have the same cache behavior as the existing Agent/session path.

## Known Limitations and Deferred Work

- **Background retention is not supervision** — the named Web lease keeps a healthy Runtime alive, but it does not restart the process after a crash, sign-out, or upgrade.
