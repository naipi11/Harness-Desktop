# Agent Note: Cross-client Runtime fixture

Status: implemented

English | [中文](2026-08-24-cross-client-runtime-fixture.zh.md)

## Problem

CLI, Web, and Desktop acceptance needs one shared local Runtime and durable workspace/session evidence, but app-specific runners cannot safely share browser, Electron, filesystem, and process imports. Existing local-Runtime tests can inspect private endpoint records and replay fixtures; using those mechanisms for cross-client acceptance would validate an implementation shortcut instead of the product connector, Dashboard handoff, terminal, and API carriers.

Readiness and cleanup also need an enforceable owner. A port, PID, lock, or endpoint-file probe can report availability before authenticated control is usable, while deleting a temporary home before every owned handle and process settles can hide leaked work. Cordis invariants cannot express this host-process relationship because the test fixture owns no Cordis event stream or mutable service data.

## Decision

`@harness-desktop/dsh-cross-client-runtime` is a Host-only test-support package. Its default fixture creates one temporary root, runs the declared built `harness-runtime` bin with plain current Node and a sanitized system environment, starts the public LLM mock server, and configures the Runtime through a test API key and `${baseURL}/v1`. A minimal `standard` preset keeps the assembled product path canonical without a replay or private source backend.

Readiness retries only the public no-start connector and accepts the Runtime after its attached client's redacted status reports `running`. Shared state is created and read through a cookie-authenticated `AbstractApiClient` subclass. The fixture obtains that cookie from `attachDashboard()` and `createBrowserHandoff()`, accepts only a clean explicit-port loopback HTTP origin plus a `303` redirect to `/`, posts the handoff only in a form body, retains authentication privately, and pins every API request to the exact returned origin. The Dashboard handle exposes only a capability closure that compares candidate output with the exact handoff and cookie values. Tests never read endpoint records, locks, SQLite, credential stores, ports, or process identifiers.

The root API uses `WorkspaceId` from `@harness-desktop/dsh-host-apiproxy/api` and `SessionId` from `@harness-desktop/dsh-session/types`, and exposes workspace/session/history/prompt operations plus public terminal attachments. Same-session contention must surface `RuntimeBusyError` with the attempted session id. CLI, Web, and Desktop process or browser launchers remain injected Node-only adapters, so Playwright, Electron, and browser fixture imports stay in app-owned test modules. CLI results containing exact fixture roots, the test API key, retained handoff/cookie values, or access-token/auth/cookie/handoff markers fail with one stable redacted operation error. The fixture never receives the endpoint token, so exact endpoint-token non-disclosure remains owned by local-runtime tests rather than a test hook here.

Setup treats sibling directory creation as one transaction: rollback begins only after every attempt settles. Every ready-state asynchronous public operation enters a synchronous admission counter before its first await. Runtime stop or disposal changes state first, waits that counter to reach zero, then snapshots and attempts every app handle, terminal, Dashboard, API client, and base-client close. Any unconfirmed owner aborts before Runtime stdin, mock shutdown, or root removal; successful owners remain recorded while failed one-flight closes and pre-quiescence stop/dispose flights clear for retry. A handle created after state changes is registered, closed, and rejected rather than returned live. Only after all owners close does Runtime shutdown close stdin and settle once. Mock close and root removal then settle independently: mock failure retains the root, root failure skips the already closed mock on retry, and settled stages never repeat. An abnormal observed Runtime exit records one stopped event and retains its terminal rejected stop/dispose flight after all resources settle. The required Cordis `./invariant` companion remains an explained empty installer.

## Verification

Host tests inject filesystem, process, health, API, and app adapters to verify root ownership, all-settled setup rollback, no-start status retries, state observations, synchronous admission across delayed state/CLI/app/terminal operations, late-handle closure, cleanup ordering, permanent-owner teardown denial, transient app/terminal close retry, successful concurrent disposal, abnormal-stop idempotence, mock-before-root ordering, independent mock/root retry, exact private-value and labeled-marker CLI rejection, cleanup-start admission denial, stable independent failure aggregation, force-kill fallback, setup-failure cleanup, missing-stop rejection, and forbidden browser/Electron/client-fixture dependencies. Covered Dashboard-carrier tests reject unsafe scheme/host/port/path/query/fragment/credentials, cross-origin cookie requests, invalid redirect responses, and missing or malformed cookies while proving body-only handoff exchange, exact handoff/cookie comparison, value clearing, and secret-free diagnostics. The built-artifact lane imports the package's built public entry, rejects an inherited hostile Node loader, then proves public health, workspace/session/history persistence, success including the automatic title request, stalled terminal work, exact same-session busy rejection, cancellation, and cleanup through the canonical Runtime and public mock server. The V8 per-file gate excludes only `cross-client-defaults.ts`, whose declared-bin, sanitized-process, public-mock, and public-connector glue executes outside the instrumented unit program; the lifecycle, state, and Dashboard security modules remain under the 100% per-file gate.

## Alternatives considered

**Extend the browser-side client test runtime** — rejected because its compiler face and jsdom dependencies cannot own native processes, filesystem roots, or Electron launchers without mixing Host and Client programs.

**Inspect Runtime storage and endpoint files** — rejected because those are private recovery mechanisms and can make an unavailable authenticated carrier appear ready. Their owning packages retain direct-format tests.

**Use the replay adapter or a source-only backend** — rejected because cross-client release acceptance must execute the shipped provider and built Runtime paths. The public mock server supplies deterministic success and stall behavior without bypassing HTTP/SSE.

**Use one mixed mock script for success, title generation, and stall** — rejected because the automatic title request is an independent model request whose timing should not determine the stall step. Built acceptance uses separate repeatable-success and repeatable-stall fixtures.

**Model host cleanup as a Cordis runtime invariant** — rejected because no authoritative Cordis relation represents a test-owned child process. A synthetic event would test fixture bookkeeping indirectly; the explicit lifecycle ledger observes the owner directly.

## Consequences

All three app runners can share one built, authenticated, storage-opaque fixture while retaining their own presentation tooling. Readiness and cleanup claims come from public status and owned-process settlement, and stable errors preserve independent failure stages without exposing home paths, provider keys, handoffs, cookies, endpoint tokens, or private causes.

The fixture is deliberately test-only and depends on prior built artifacts. App tests must inject launcher adapters, and storage-format, credential, endpoint, lock, and app-rendering assertions remain outside this package. Success and stall/busy scenarios use separate Runtime lifetimes, which costs one additional boot but avoids request-order coupling with title generation.
