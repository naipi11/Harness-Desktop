# Agent Note: Cross-client Runtime fixture

Status: implemented

English | [中文](2026-08-24-cross-client-runtime-fixture.zh.md)

## Problem

CLI, Web, and Desktop acceptance needs one shared local Runtime and durable workspace/session evidence, but app-specific runners cannot safely share browser, Electron, filesystem, and process imports. Existing local-Runtime tests can inspect private endpoint records and replay fixtures; using those mechanisms for cross-client acceptance would validate an implementation shortcut instead of the product connector, Dashboard handoff, terminal, and API carriers.

Readiness and cleanup also need an enforceable owner. A port, PID, lock, or endpoint-file probe can report availability before authenticated control is usable, while deleting a temporary home before every owned handle and process settles can hide leaked work. Cordis invariants cannot express this host-process relationship because the test fixture owns no Cordis event stream or mutable service data.

## Decision

`@harness-desktop/dsh-cross-client-runtime` is a Host-only test-support package. Its default fixture creates one temporary root, runs the declared built `harness-runtime` bin with plain current Node and a sanitized system environment, starts the public LLM mock server, and configures the Runtime through a test API key and `${baseURL}/v1`. A minimal `standard` preset keeps the assembled product path canonical without a replay or private source backend.

Readiness retries only the public no-start connector and accepts the Runtime after its attached client's redacted status reports `running`. Shared state is created and read through a cookie-authenticated `AbstractApiClient` subclass. The fixture obtains that cookie from `attachDashboard()` and `createBrowserHandoff()`, posts the handoff only in a form body, retains authentication privately, and pins every API request to the exact returned origin. Tests never read endpoint records, locks, SQLite, credential stores, ports, or process identifiers.

The root API uses the existing `WorkspaceId` and `SessionId` owners and exposes workspace/session/history/prompt operations plus public terminal attachments. Same-session contention must surface `RuntimeBusyError` with the attempted session id. CLI, Web, and Desktop process or browser launchers remain injected Node-only adapters, so Playwright, Electron, and browser fixture imports stay in app-owned test modules.

Runtime stop or disposal stops new operations immediately. Both share one idempotent phase that settles app handles, terminals, Dashboard, API client, and base client before Runtime shutdown closes stdin, waits within a bound, and force-kills only its exact owned child before a second bounded exit observation. Disposal then closes the mock server and removes the temporary root only after exit is observed. The token-free ledger records one ordered `started`, `health-confirmed`, and `stopped`; a pure host assertion enforces it, while the required Cordis `./invariant` companion remains an explained empty installer.

## Verification

Host tests inject filesystem, process, health, API, and app adapters to verify root ownership, no-start status retries, state observations, cleanup ordering, cleanup-start admission denial, idempotent settlement, stable independent failure aggregation, force-kill fallback, setup-failure cleanup, missing-stop rejection, and forbidden browser/Electron/client-fixture dependencies. The built-artifact lane imports the package's built public entry, rejects an inherited hostile Node loader, then proves public health, workspace/session/history persistence, success including the automatic title request, stalled terminal work, exact same-session busy rejection, cancellation, and cleanup through the canonical Runtime and public mock server. The V8 per-file gate excludes only `cross-client-defaults.ts` because that module contains the canonical built-process and network adapters that execute outside the instrumented unit program; the injectable lifecycle and state owner remains under the 100% per-file gate, while the built-artifact lane is required coverage for the excluded adapter module.

## Alternatives considered

**Extend the browser-side client test runtime** — rejected because its compiler face and jsdom dependencies cannot own native processes, filesystem roots, or Electron launchers without mixing Host and Client programs.

**Inspect Runtime storage and endpoint files** — rejected because those are private recovery mechanisms and can make an unavailable authenticated carrier appear ready. Their owning packages retain direct-format tests.

**Use the replay adapter or a source-only backend** — rejected because cross-client release acceptance must execute the shipped provider and built Runtime paths. The public mock server supplies deterministic success and stall behavior without bypassing HTTP/SSE.

**Use one mixed mock script for success, title generation, and stall** — rejected because the automatic title request is an independent model request whose timing should not determine the stall step. Built acceptance uses separate repeatable-success and repeatable-stall fixtures.

**Model host cleanup as a Cordis runtime invariant** — rejected because no authoritative Cordis relation represents a test-owned child process. A synthetic event would test fixture bookkeeping indirectly; the explicit lifecycle ledger observes the owner directly.

## Consequences

All three app runners can share one built, authenticated, storage-opaque fixture while retaining their own presentation tooling. Readiness and cleanup claims come from public status and owned-process settlement, and stable errors preserve independent failure stages without exposing home paths, provider keys, handoffs, cookies, endpoint tokens, or private causes.

The fixture is deliberately test-only and depends on prior built artifacts. App tests must inject launcher adapters, and storage-format, credential, endpoint, lock, and app-rendering assertions remain outside this package. Success and stall/busy scenarios use separate Runtime lifetimes, which costs one additional boot but avoids request-order coupling with title generation.
