# `@harness-desktop/dsh-cross-client-runtime`

English | [中文](README.zh.md)

Host-only reference fixture for acceptance tests that attach CLI, Web, and Desktop to one canonical local Runtime. The package is test infrastructure, not a product client API.

## Fixture API

`createCrossClientFixture()` creates one temporary root containing a fresh `HARNESS_HOME`, platform home, and workspace. Its default path starts the declared built `harness-runtime` bin under the current Node executable with `DSH_HOME` unset even when the parent defines it, starts the public `@harness-desktop/dsh-llm-mock-server`, and retries only `createRuntimeConnector(...).connect({ start: false })` plus `status().state === 'running'` for readiness. It does not read endpoint records, locks, SQLite, credential stores, ports, or process identifiers.

`CrossClientFixture` exposes workspace and session creation, workspace/session/history reads, prompt submission, public terminal attachments, same-session `RuntimeBusyError` verification, injected CLI/Web/Desktop launchers, explicit Runtime stop, disposal, and token-free lifecycle observations. Workspace observations use `WorkspaceId` from `@harness-desktop/dsh-host-apiproxy/api`, and session observations use `SessionId` from `@harness-desktop/dsh-session/types`; the package introduces no identifier brand.

The authenticated state client comes from a public Dashboard attachment and one body-only browser handoff. The carrier accepts only a clean, explicit-port loopback HTTP origin, a `303` redirect to `/`, and a non-empty cookie name/value pair. A host `AbstractApiClient` subclass retains that cookie privately and refuses requests outside the exact origin. A capability closure tests output against the exact handoff and cookie values without exposing them. The fixture rejects its exact API key and home paths plus access-token/auth/cookie/handoff markers. It never receives the Runtime endpoint token; exact endpoint-token non-disclosure remains enforced by local-runtime owner tests.

## Lifecycle

Fixture setup waits every sibling directory attempt before rollback, so no delayed mkdir can recreate the owned root after cleanup. Each ready-state asynchronous operation is admitted synchronously before its first await. Runtime stop or disposal changes state first, waits the admitted set to settle, then closes the complete app/terminal/Dashboard/API/base-client snapshot before Runtime stdin and its bounded force-kill fallback. A handle that arrives after state changes is registered, closed, and rejected rather than returned live. Any unconfirmed owner close aborts teardown before Runtime stdin, mock shutdown, or root removal; the failed stop/dispose flight clears so a later call retries only unresolved owners. Mock close and root removal have independent settlement records: mock failure retains the root, root failure retries without re-closing the mock, and a removed root is never removed again. An abnormal exit records one stopped event and retains its terminal rejected stop/dispose flight after mock and root settle, so repeated disposal returns the same error without repeating teardown. Successful concurrent calls share one settlement, and failures return stable cleanup-stage errors without private causes.

`assertCrossClientLifecycle()` requires one ordered `started`, `health-confirmed`, and `stopped` event. The `./invariant` Cordis companion is intentionally empty because this package owns no Cordis event or mutable-data relationship; host fixture tests enforce the lifecycle ledger.

## App adapters

CLI, Web, and Desktop tests inject Node-only adapters. Adapter interfaces contain no Playwright, Electron, browser, or browser-side `client-runtime` import, so each app test keeps its runner-specific launch and presentation assertions in its own module. The CLI adapter runs only the matching built `apps/cli/lib/bin.js` or `lib/dsh-bin.js` under plain current Node from the fixture workspace, with a non-extending system environment and unchanged captured output.

The Web adapter dynamically imports the physical built public local-Runtime entry and refuses a missing `apps/web/dist`. It connects without starting another Runtime, verifies `running`, owns a Dashboard attachment, and writes one randomly named, exclusively created form file with owner-only POSIX mode inside the fixture platform home. Chromium opens that clean file URL, submits the handoff once only in the form body, follows the exact clean `/` redirect, and waits for both the authenticated-ready marker and the real Engineering workbench. The adapter owns independent retryable closure of its page, browser context, Dashboard attachment, Runtime client, and bootstrap file; open plus cleanup failures retain stable stage-only errors. Its probe exposes the Playwright page for semantic role/text interaction plus a token-free audit of request URLs and headers, referrer, final DOM and URL, Chromium history, browser storage, console/page errors, and the HttpOnly cookie policy; it never returns a handoff or cookie value.

The cumulative Web acceptance first creates state through built `harness run --json`: the known Workspace remains unchanged and the cwd-only CLI Session appears under Ungrouped. The real Dashboard dismisses its first-use notice, expands and selects that Session through accessible UI, renders the existing prompt/reply, submits a second prompt through the composer, and confirms both turns through the fixture's public history API. This semantic DOM coverage changes no product-visible string, so it requires no snapshot update.

The Desktop adapter refuses a missing built `apps/desktop/out/main/index.js` and launches that real Electron entry with only the fixture roots and system executable paths; it passes no provider key, Runtime token, endpoint path, or `DSH_HOME`. Desktop itself attaches the already healthy Runtime through its product connector. The adapter owns only the Playwright-returned Electron child, requests graceful application closure before a bounded exact-child `SIGKILL`, and still releases the Playwright application after an unexpected child exit. The cumulative Desktop lane waits for the authenticated-ready workbench, selects the CLI Session under Ungrouped, appends through the native renderer, proves the public history survives the kill, then launches Desktop again and renders the same history. Linux consumer CI runs that built lane under `xvfb-run`; it adds no product-visible string or snapshot.

## Model Experience

None, as the fixture drives ordinary public prompt and terminal operations while the canonical Runtime's composed plugins own every model-visible input.

#### KV Cache effect

None directly; each isolated Runtime and mock scenario has an independent request history, and the fixture does not add, retain, or rewrite model-request prefixes.

## Known Limitations and Deferred Work

- **Test-only carriers** — the fixture supports the public Runtime connector, terminal, Dashboard handoff, and API carrier for acceptance tests; it is not an application integration API.
- **App launchers are injected** — CLI, Web, and Desktop modules must supply their runner-specific adapters before calling `runCli()`, `openWeb()`, or `openDesktop()`.
- **CLI Sessions stay Ungrouped** — terminal CLI creation is cwd-only and does not attach a Session to a Workspace merely because their paths match, following the [Workspace membership decision](../../../.agents/notes/implemented/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md).
- **No storage or credential inspection** — persistence, lock, endpoint, and credential assertions remain with their owning packages; this fixture observes only public health and authenticated API state.
