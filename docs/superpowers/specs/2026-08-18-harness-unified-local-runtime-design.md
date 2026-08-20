# Harness unified local Runtime design

English | [中文](2026-08-18-harness-unified-local-runtime-design.zh.md)

## Status and scope

This document maps the current Runtime Foundation implemented by [`@harness-desktop/dsh-host-local-runtime`](../../../packages/host/local-runtime/README.md). The [Harness Desktop product topology Agent Note](../../../.agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md) owns the durable rationale and rejected topologies. The [Harness Desktop product architecture design](2026-08-15-harness-desktop-design.md) retains broader presentation, packaging, and release plans.

The foundation supplies one shared local process, its persistence ownership, private authentication, migration transaction, lifecycle accounting, and public Node API. CLI, Web, and Desktop presentation layers consume that API in later work; they and cross-client product acceptance are not part of the shipped foundation described here.

## Runtime ownership

One Runtime process owns one `HARNESS_HOME` and is its sole persistence writer. It acquires the per-home lock before booting the canonical base-and-Web Cordis composition, then supplies one injected `HarnessHomeProvider` to the API, Dashboard assets, session, settings, workspace, storage, and credential-reference providers.

The lock records PID and operating-system process-start identity. A cross-process recovery guard serializes identity probing and stale replacement. A live or unverifiable identity remains authoritative; only a proved-absent identity permits replacement. Release removes only the acquiring Runtime's unchanged record.

## Endpoint and Dashboard authentication

The Runtime binds an operating-system-assigned port on `127.0.0.1`. Its current-user-only endpoint record contains protocol version, Runtime identity, port, process identity, and a private access token. Protected same-directory temporary files and atomic renames publish and retire the record without overwriting a newer owner.

Native control accepts the exact loopback authority with the private bearer token. A Dashboard attachment mints a 60-second, single-use opaque handoff whose value travels only in one URL-encoded form body. The exchange emits no CORS permission and returns a clean redirect with a session `HttpOnly; SameSite=Strict; Path=/` cookie without an expiry attribute. Dashboard API and event requests require that cookie and the exact Runtime origin.

The endpoint token, handoff, and session credential remain outside public exports, command lines, URLs, diagnostics, transcripts, browser script storage, and Renderer IPC. Public values also exclude credential values, raw filesystem errors, and the selected Harness home. Authenticated response parsing rejects malformed, oversized, invalid-branded, token-bearing, or selected-home-bearing values before projection.

## Data root and migration

`HARNESS_HOME` is the only writable Harness data root. Its platform defaults are `%LOCALAPPDATA%\Harness Desktop` on Windows, `~/Library/Application Support/Harness Desktop` on macOS, and `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop` on Linux. Credential values stay in their provider; Runtime-owned state stores references.

A detected `DSH_HOME` is an import source, never a second writable root. Native and authenticated Dashboard requests share one Runtime-owned transaction and retainer. Acceptance copies supported non-secret roots once into an otherwise empty target, decline persists before acceptance, retry accepts only a recorded retryable result, and concurrent decisions replay the committed outcome. Source directories remain intact, and collision or failure results expose only redacted correction data.

## Public Runtime API

`createRuntimeConnector()` alone discovers the private endpoint and retains the token inside authenticated closures. `connect({ start: false })` performs a side-effect-free status attachment and reports typed absence. `connect({ start: true })` serializes racing process starts, waits for one authenticated healthy owner, and attaches all successful callers to it.

`RuntimeClient` exposes redacted status, legacy migration, the stable `web` background lease, owner-scoped active-work control, terminal attachments, Dashboard attachments, and independent close. `TerminalConnection` uses the composed session, Agent, command, model, permission, and approval owners; its submit, control, cancellation, event, and close operations remain scoped to that attachment. `DashboardAttachment` creates body-only browser navigation and releases independently.

`RuntimeUnavailableError` reports absence, `RuntimeBusyError` reports a same-session writer with recovery choices, and `RuntimeProtocolError` reports an incompatible or rejected local protocol value. `normalizeRecoveryDiagnostic()` returns stable, secret-free recovery categories, subject, correction, and correlation id without reflecting unknown local error text.

## Lifecycle and leases

The Runtime remains live while it has a client attachment, Agent work, a migration or control-operation retainer, or the named `web` background lease. Closing an attachment never cancels active work. Cancellation removes only the request's unclaimed inbox message or signals the exact claimed operation, then waits only for its correlated `turn/end` and lease cleanup.

Idle shutdown starts only after every retainer is absent. It closes private control and settles owned operations, flushes durable sessions, retires the endpoint, releases the lock, and disposes the Cordis root. Every stage settles before independent failures are reported. The background lease retains a healthy process but does not supervise or restart it after a crash, sign-out, or upgrade.

## Source and built acceptance

The package's declared `lib/bin.js` and direct `src/bin.ts` development entry boot the same canonical composition. Source startup preserves its TypeScript launcher requirements and consumes build-generated Typert and browser artifacts; built startup runs the published JavaScript path. Real process acceptance attaches the public connector to both entries and verifies shared ownership, authentication, lifecycle, control, and redacted protocol behavior.

This evidence establishes the Runtime Foundation only. It does not establish an installed `harness` terminal interface, Web command behavior, Electron presentation, platform packaging, or three-client convergence.

## Known cross-package follow-up

User-skill slash admission checks a complete catalog and a scoped pre-step consumer before inserting the request. The skill definition can still change between that API decision and the consumer's load at `agent/pre-step`; closing this interval requires a shared admission token or equivalent transaction across the skill and API owners. The foundation therefore does not claim a universal fail-closed guarantee for this interval.
