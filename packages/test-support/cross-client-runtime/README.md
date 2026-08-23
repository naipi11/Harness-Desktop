# `@harness-desktop/dsh-cross-client-runtime`

English | [中文](README.zh.md)

Host-only reference fixture for acceptance tests that attach CLI, Web, and Desktop to one canonical local Runtime. The package is test infrastructure, not a product client API.

## Fixture API

`createCrossClientFixture()` creates one temporary root containing a fresh `HARNESS_HOME`, platform home, and workspace. Its default path starts the declared built `harness-runtime` bin under the current Node executable, starts the public `@harness-desktop/dsh-llm-mock-server`, and retries only `createRuntimeConnector(...).connect({ start: false })` plus `status().state === 'running'` for readiness. It does not read endpoint records, locks, SQLite, credential stores, ports, or process identifiers.

`CrossClientFixture` exposes workspace and session creation, workspace/session/history reads, prompt submission, public terminal attachments, same-session `RuntimeBusyError` verification, injected CLI/Web/Desktop launchers, explicit Runtime stop, disposal, and token-free lifecycle observations. Workspace observations use `WorkspaceId` from `@harness-desktop/dsh-host-apiproxy/api`, and session observations use `SessionId` from `@harness-desktop/dsh-session/types`; the package introduces no identifier brand.

The authenticated state client comes from a public Dashboard attachment and one body-only browser handoff. The carrier accepts only a clean, explicit-port loopback HTTP origin, a `303` redirect to `/`, and a non-empty cookie name/value pair. A host `AbstractApiClient` subclass retains that cookie privately and refuses requests outside the exact origin. The API key, home paths, access-token/auth markers, handoff, cookie, and Runtime endpoint token never enter returned diagnostics, lifecycle snapshots, app-adapter inputs, or accepted CLI output.

## Lifecycle

Fixture setup waits every sibling directory attempt before rollback, so no delayed mkdir can recreate the owned root after cleanup. Each ready-state asynchronous operation is admitted synchronously before its first await. Runtime stop or disposal changes state first, waits the admitted set to settle, then closes the complete app/terminal/Dashboard/API/base-client snapshot before Runtime stdin and its bounded force-kill fallback. A handle that arrives after state changes is registered, closed, and rejected rather than returned live. `dispose()` then closes the mock server and removes only the explicit temporary root after observing process exit. Repeated stop and disposal calls share their settlements, and independent failures return stable cleanup-stage errors without private causes.

`assertCrossClientLifecycle()` requires one ordered `started`, `health-confirmed`, and `stopped` event. The `./invariant` Cordis companion is intentionally empty because this package owns no Cordis event or mutable-data relationship; host fixture tests enforce the lifecycle ledger.

## App adapters

CLI, Web, and Desktop tests inject Node-only adapters. Adapter interfaces contain no Playwright, Electron, browser, or browser-side `client-runtime` import, so each app test keeps its runner-specific launch and presentation assertions in its own module.

## Model Experience

None, as the fixture drives ordinary public prompt and terminal operations while the canonical Runtime's composed plugins own every model-visible input.

#### KV Cache effect

None directly; each isolated Runtime and mock scenario has an independent request history, and the fixture does not add, retain, or rewrite model-request prefixes.

## Known Limitations and Deferred Work

- **Test-only carriers** — the fixture supports the public Runtime connector, terminal, Dashboard handoff, and API carrier for acceptance tests; it is not an application integration API.
- **App launchers are injected** — CLI, Web, and Desktop modules must supply their runner-specific adapters before calling `runCli()`, `openWeb()`, or `openDesktop()`.
- **No storage or credential inspection** — persistence, lock, endpoint, and credential assertions remain with their owning packages; this fixture observes only public health and authenticated API state.
