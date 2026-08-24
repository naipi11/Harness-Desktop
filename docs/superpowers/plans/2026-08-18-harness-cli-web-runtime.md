# Harness CLI and Web Runtime Clients Implementation Plan

English | [中文](2026-08-18-harness-cli-web-runtime.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `harness`, `harness web`, and the `dsh` compatibility alias attach to one local Runtime instead of booting profile-private application trees.

**Architecture:** The Runtime-foundation workstream owns `HARNESS_HOME`, locking, endpoint discovery, token-bearing control requests, persistence, credentials, and the hosted Dashboard. This workstream adds thin terminal and Web launchers: they parse product commands, obtain a Runtime client through the foundation API, and render or hand off only Runtime-provided state. `dsh` calls the same parser and dispatcher as `harness`; desktop activation is delegated only to the installed-app launcher and never emulated by a CLI child process.

**Tech Stack:** TypeScript ESM, Commander, Node child-process/browser opening adapters, Vitest, existing source/built CLI and snapshot harnesses.

**Spec:** [Harness unified local Runtime design](../specs/2026-08-18-harness-unified-local-runtime-design.md) and [中文设计](../specs/2026-08-18-harness-unified-local-runtime-design.zh.md)

## Global Constraints

- `HARNESS_HOME` is the only writable Harness data root; CLI, Web, Dashboard JavaScript, and Electron renderer never write persistence or credentials directly.
- A client calls Runtime discovery/attach and never starts a second Runtime when a healthy endpoint exists; only the Runtime foundation acquires or recovers its per-home lock.
- Applications never read, parse, or disclose endpoint records; the foundation `RuntimeConnector` encapsulates discovery and its private control token.
- Runtime loopback control tokens never appear in argv, stdout JSONL, stderr diagnostics, browser URLs, browser storage, snapshots, transcripts, logs, or thrown error text.
- `harness` without `--profile` is an interactive terminal client for the current directory; `harness "task"` supplies its initial task.
- `harness run "task" --json` emits only JSONL protocol records on stdout; human diagnostics and all failures go to stderr.
- `harness web` starts or attaches, obtains a Runtime-owned Dashboard attachment, mints one high-entropy, 60-second single-use browser handoff, and opens a current-user-only local bootstrap directory and document after verifying owner-only POSIX modes or a current-user Windows ACL and rejecting a broader-access location. Its opaque file origin intentionally makes the top-level form POST to the exact Runtime `/_harness/handoff` target cross-origin; the exchange authenticates only its form-body handoff, atomically consumes it, emits no CORS permission, and returns a clean `303`. The launcher binds one idempotent cleanup timer to `expiresAt` and removes the owned document and directory exactly once on dispatch failure, exchange success or failure, or expiry, including a never-dispatched document. The handoff never enters a navigation URL, hash, query, header, referrer, history, storage, logs, diagnostics, or transcripts. Only the post-exchange session credential may use Runtime `Set-Cookie`, browser `Cookie` headers, and the browser HttpOnly cookie jar; normal Dashboard requests require that `HttpOnly; SameSite=Strict; Path=/` session cookie with no expiry attribute and the exact Runtime origin.
- `--daemon` and `--background` are aliases for one persistent named Runtime background lease, not detached web-server processes. `--status` never starts a Runtime; `--stop` releases only that lease and succeeds when it is already absent.
- `--no-open` suppresses browser navigation and does not create a lease unless combined with `--daemon` or `--background`.
- `dsh` and `harness` use the same parser, Runtime data root, command graph, error mapping, and source/built behavior. Compatibility does not preserve `--profile` as a public Runtime-client requirement.
- This plan is the sole owner of the shared parser, installed-app resolver/activator, and `web --stop` behavior. The Icon/release workstream consumes these APIs and packages them; it does not add a second dispatcher, resolver, activator, or stop rule.
- `harness desktop` activates only the installed Harness Desktop app. When absent, print the platform-specific installation route and exit; never launch a hidden Electron or Web replacement.
- Preserve ESM, strict TypeScript, public JSDoc, redacted typed errors, and the repository source-plane/artifact-plane separation. Do not edit `specs/`, README files, or `.superpowers/dist`; Task 2 alone may edit `apps/cli/package.json` for the narrowly required workspace dependency exceptions, CLI runtime graph, source/built staging, and build entries. That prerequisite does not take over Icon/release packaging or distribution ownership.

---

## File map

- `apps/cli/src/args.ts` — product command parser shared by both executable names.
- `apps/cli/src/main.ts` — shared dispatch and explicit stdout/stderr ownership.
- `apps/cli/src/runtime-client.ts` — non-durable CLI adapter over the Runtime-foundation client API.
- `apps/cli/src/terminal-client.ts` — Ink/React interactive terminal and JSONL presentation; no profile boot or persistence access.
- `apps/cli/src/web-daemon.ts` — rename its responsibility to Runtime Web invocation/lease orchestration; remove detached-child startup and log ownership.
- `apps/cli/src/browser.ts` — launcher-owned transient local-file bootstrap transport that verifies an owner-only directory and document, submits the opaque handoff only in a cross-origin form POST body to the exact Runtime target, and uses its `expiresAt`-bound exactly-once cleanup before following only the clean Dashboard URL.
- `apps/cli/src/desktop.ts` — injectable installed-application activation adapter.
- `apps/cli/tests/args.spec.ts`, `apps/cli/tests/main.spec.ts`, `apps/cli/tests/terminal-client.spec.ts`, `apps/cli/tests/web-daemon.spec.ts`, `apps/cli/tests/desktop.spec.ts` — focused parser and client behavior.
- `apps/cli/tests/source-launch.compat.spec.ts`, `apps/cli/tests/runtime-client.e2e.ts`, `apps/cli/tests/interactive-terminal.pty.e2e.ts`, `apps/cli/tests/web-daemon.compat.spec.ts`, `apps/cli/tests/web-daemon.snapshot.ts` — real source/built, PTY, and transcript validation.
- `apps/web/src/main.ts` — starts the existing Dashboard shell only after the transient bootstrap POST redirects to its clean, cookie-authenticated URL.
- `apps/web/tests/runtime-bootstrap.e2e.ts` and `apps/web/tests/runtime-bootstrap.snapshot.ts` — clean-URL, cookie-authenticated Dashboard validation with no browser-visible handoff.

## Runtime-foundation dependency

This plan consumes, but does not implement, the following public API from the Runtime foundation. Do not duplicate these types in `apps/cli` or `apps/web`.

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type RuntimeId = Branded<'RuntimeId'>
export type RuntimeClientId = Branded<'RuntimeClientId'>
export type SessionId = Branded<'SessionId'>
export type BackgroundLeaseId = Branded<'BackgroundLeaseId'>
export type BrowserHandoffId = Branded<'BrowserHandoffId'>
export type ApprovalId = Branded<'ApprovalId'>
export type ActiveWorkId = Branded<'ActiveWorkId'>
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>
export type DashboardOrigin = Branded<'DashboardOrigin'>

export interface TerminalOpenRequest {
  readonly workspace: string
  readonly initialTask?: string
  readonly sessionId?: SessionId
}
export type TerminalProtocolEvent =
  | { readonly kind: 'session-opened'; readonly sessionId: SessionId }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'tool-activity'; readonly title: string }
  | { readonly kind: 'approval-requested'; readonly approvalId: ApprovalId; readonly prompt: string }
  | { readonly kind: 'model-changed'; readonly model: string }
  | { readonly kind: 'permission-changed'; readonly permission: string }
  | { readonly kind: 'diagnostic'; readonly diagnostic: RedactedRuntimeDiagnostic }
export type TerminalInput =
  | { readonly kind: 'task'; readonly text: string }
  | { readonly kind: 'approval'; readonly approvalId: ApprovalId; readonly decision: 'approve' | 'reject' }
export type TerminalControlCommand =
  | { readonly command: 'model'; readonly model?: string }
  | { readonly command: 'permissions'; readonly permission?: string }
  | { readonly command: 'plan' }
  | { readonly command: 'compact' }
  | { readonly command: 'resume'; readonly sessionId?: SessionId }
  | { readonly command: 'diff' }
  | { readonly command: 'terminal' }
  | { readonly command: 'doctor' }
  | { readonly command: 'exit' }
export interface TerminalConnection {
  events(): AsyncIterable<TerminalProtocolEvent>
  submit(input: TerminalInput): Promise<void>
  runControl(command: TerminalControlCommand): Promise<void>
  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  close(): Promise<void>
}
export interface BrowserHandoff { readonly id: BrowserHandoffId; readonly expiresAt: number }
export interface DashboardNavigation { readonly origin: DashboardOrigin; readonly handoff: BrowserHandoff }
export interface DashboardAttachment {
  createBrowserHandoff(): Promise<DashboardNavigation>
  close(): Promise<void>
}
export interface BrowserHandoffTransport { open(navigation: DashboardNavigation): Promise<void> }
export interface RuntimeLease { readonly id: BackgroundLeaseId }
export interface RuntimeStatus {}
export interface RuntimeLeaseStatus { readonly id: BackgroundLeaseId; readonly state: 'present' | 'absent' }
export type RuntimeRecoveryCode = 'runtime-unavailable' | 'runtime-version-mismatch' | 'runtime-start-failed' | 'dashboard-unavailable'
export interface RedactedRuntimeDiagnostic {
  readonly code: RuntimeRecoveryCode
  readonly subject: 'Runtime' | 'Dashboard'
  readonly message: string
  readonly correction: string
  readonly diagnosticId: RuntimeDiagnosticId
}
export type LegacyMigrationState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'decision-required'; readonly sourceLabel: 'DSH_HOME'; readonly retryable: boolean }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly copied: readonly string[] }
  | { readonly kind: 'target-not-empty'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
  | { readonly kind: 'failed'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
export interface ActiveWorkStatus { readonly ownUiWork: readonly ActiveWorkId[] }
export type OwnUiWorkStopResult = { readonly kind: 'stopped'; readonly work: readonly ActiveWorkId[] } | { readonly kind: 'none-active' } | { readonly kind: 'failed'; readonly diagnostic: RedactedRuntimeDiagnostic }

export interface RuntimeClient {
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  attachDashboard(): Promise<DashboardAttachment>
  acquireBackgroundLease(): Promise<RuntimeLease>
  status(): Promise<RuntimeStatus>
  releaseBackgroundLease(): Promise<RuntimeLeaseStatus>
  getLegacyMigration(): Promise<LegacyMigrationState>
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  declineLegacyMigration(): Promise<LegacyMigrationState>
  retryLegacyMigration(): Promise<LegacyMigrationState>
  observeActiveWork(): Promise<ActiveWorkStatus>
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
  close(): Promise<void>
}

export interface RuntimeConnector {
  connect(options: { readonly start: boolean }): Promise<RuntimeClient>
}

export declare class RuntimeUnavailableError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeBusyError extends Error { readonly sessionId: SessionId; readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeProtocolError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare function normalizeRecoveryDiagnostic(error: unknown): RedactedRuntimeDiagnostic
```

`connect({ start: false })` rejects with `RuntimeUnavailableError` when no healthy Runtime exists and must not create files, processes, locks, or endpoint records. `TerminalConnection`, `DashboardAttachment`, and `RuntimeClient` each have their own required `close()` lifecycle. A Web launcher closes its Dashboard attachment after opening; Electron Main uses the same attachment and closes it at application exit. `TerminalConnection` supplies protocol events; its event values are already safe to render. All recovery output uses the foundation normalizer, which carries no token, handoff, cookie, credential, endpoint-record field, or absolute home path.

### Task 1: Replace profile-required parsing with one product command graph

**Files:**
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/tests/args.spec.ts`
- Modify: `apps/cli/tests/source-launch.compat.spec.ts`

**Interfaces:**
- Produces `ProductInvocation = InteractiveInvocation | RunInvocation | WebInvocation | DesktopInvocation`.
- `parseProductArgs(argv, commandName): ProductInvocation` is called by both binaries and returns `commandName: 'harness' | 'dsh'` only for presentation.
- `WebInvocation` has `mode: 'web'`, `open: boolean`, `lease: 'none' | 'background'`, and `operation: 'open' | 'status' | 'stop'`.
- Parse errors use `ProductArgumentError` with a correction and are rendered by `main.ts` to stderr.

- [ ] **Step 1: Write failing parser tests**

Add exact assertions that bare `harness` resolves `{ mode: 'interactive', initialTask: undefined }`, `harness "task"` resolves the same mode with the task, and `harness run "task" --json` resolves `{ mode: 'run', task: 'task', json: true }`. Assert `web --daemon` and `web --background` each resolve `lease: 'background'`; `web --status` and `web --stop` resolve their operation with `lease: 'none'`; `web --status --daemon`, `run --json` without a task, duplicate tasks, and every public `--profile` input reject with a correction.

- [ ] **Step 2: Run the RED parser test**

Run: `pnpm exec vitest run apps/cli/tests/args.spec.ts`

Expected: FAIL because the current parser requires `--profile` and returns `DshInvocation`.

- [ ] **Step 3: Implement the smallest command grammar**

Replace `DshInvocation` and `parseDshArgs` with the discriminated `ProductInvocation` parser. Keep Commander help/version handling, but make `harness` examples product commands and generate the exact same syntax graph for `dsh`. Parse `web --no-open`, lease aliases, status, and stop before positional tasks; do not forward launcher flags to a profile.

- [ ] **Step 4: Verify parser and source entry behavior**

Run: `pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts`

Expected: PASS; the source launches accept bare `harness`/`dsh` parsing and reject malformed input without mentioning `--profile`.

- [ ] **Step 5: Commit the parser seam**

Run: `git add apps/cli/src/args.ts apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts && git diff --cached --check && git commit -m "feat(cli): parse Runtime product commands"`

### Task 2: Add the interactive Ink terminal Runtime client and JSONL renderer

**Files:**
- Create: `apps/cli/src/runtime-client.ts`
- Create: `apps/cli/src/terminal-client.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/main.ts`
- Create: `apps/cli/tests/main.spec.ts`
- Create: `apps/cli/tests/terminal-client.spec.ts`
- Create: `apps/cli/tests/interactive-terminal.pty.e2e.ts`
- Create: `apps/cli/tests/runtime-client.e2e.ts`

**Interfaces:**
- Consumes `RuntimeConnector`, `RuntimeClient`, `RuntimeBusyError`, and `TerminalConnection` from the foundation API above.
- Produces `runTerminalInvocation(invocation, io, connector): Promise<number>` where `io.stdout` receives protocol JSONL only in `run --json` mode and `io.stderr` receives diagnostics.
- `TerminalRenderer` has `writeEvent(event: TerminalProtocolEvent): void` and `writeDiagnostic(error: RuntimeClientError): void`; it never receives a data-root path or credential provider.
- The interactive mode uses Ink/React with normal terminal scrollback and never switches to an alternate screen. It maps `/model [model]`, `/permissions [preset]`, `/plan`, `/compact`, `/resume [session]`, `/diff`, `/terminal`, `/doctor`, and `/exit` one-for-one to `TerminalControlCommand`; text input and approval replies use `submit()`, and streamed Runtime events drive all output. The first Ctrl+C calls `cancel()` and keeps the terminal attached; a second Ctrl+C during its cancellation window performs the approved forced exit without waiting for new Runtime output. Exit codes are exactly `0` (normal completion or `/exit`), `2` (argument error), `3` (Runtime unavailable), `4` (session busy), `5` (protocol/internal failure), `130` (completed user cancellation), and `131` (forced second-Ctrl+C exit).

- [ ] **Step 1: Write failing terminal and dispatch tests**

Use a fake `RuntimeConnector` to assert that interactive and task modes pass `workspace`, `initialTask`, and an optional branded resumed `sessionId` to `openTerminal()`, consume `events()`, submit task text and approval decisions, map all nine slash commands to their exact `TerminalControlCommand`, and close their connection/client without stopping a Runtime used elsewhere. Assert `run "task" --json` writes each `TerminalProtocolEvent` as one newline-terminated `JSON.stringify(event)` record to stdout, writes only normalized diagnostics to stderr, and never prints prose before or between JSONL records. In source and built real PTYs, independently assert normal scrollback/no alternate screen; every named slash command; streamed output/tool/approval round trips; first Ctrl+C `cancel()`; second Ctrl+C forced exit; each numeric exit code; resize rerender; and color-capability degradation.

- [ ] **Step 2: Run the RED tests**

Run: `pnpm exec vitest run apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts`

Expected: FAIL because `main.ts` still calls `runProfile` and no terminal Runtime adapter exists.

- [ ] **Step 3: Implement the smallest Runtime-only terminal path**

Add `@harness-desktop/dsh-host-local-runtime`, Ink, and React as the explicit workspace/runtime dependency exceptions in `apps/cli/package.json`, and stage the complete CLI Runtime dependency graph with source and built entry artifacts through the package build. This task supplies the graph required by its own client tests; the Icon/release plan remains the owner of distributable archive and installer packaging. Implement `runtime-client.ts` as a factory around the foundation `RuntimeConnector`; it may connect, open a terminal session, read `getLegacyMigration()`, invoke accept/decline/retry only from explicit user actions, and close its attachment only. Implement `terminal-client.ts` with the Ink/React interactive renderer and a separate JSONL renderer. Render the Foundation migration state as an explicit first-start prompt and its durable result/retry correction; non-interactive `run` renders the same normalized `migration-decision-required` diagnostic without copying files. Map `RuntimeBusyError`, unavailable Runtime, protocol failures, and migration decisions through `normalizeRecoveryDiagnostic()` to redacted stderr diagnostics. Update `dispatchInvocation` to select this client for interactive and run invocations and remove all `runProfile` use from public commands.

- [ ] **Step 4: Verify focused and real entry paths**

Run: `pnpm exec vitest run apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts`

Run:

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built terminal verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
```

Expected: PASS in executable source and built modes; the PTY e2e exercises ordinary scrollback, slash controls, two-stage Ctrl+C, resize, color, and the exit-code matrix. The Runtime e2e asserts one Runtime owner across two invocations and JSONL stdout parses line by line while stderr contains diagnostics only.

- [ ] **Step 5: Commit the terminal client**

Run: `git add apps/cli/package.json apps/cli/src/main.ts apps/cli/src/runtime-client.ts apps/cli/src/terminal-client.ts apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts && git diff --cached --check && git commit -m "feat(cli): attach interactive terminal commands to Runtime"`

### Task 3: Make `harness web` a Runtime handoff and lease client

**Files:**
- Create: `apps/cli/src/browser.ts`
- Modify: `apps/cli/src/web-daemon.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/tests/web-daemon.spec.ts`
- Modify: `apps/cli/tests/web-daemon.compat.spec.ts`
- Create: `apps/cli/tests/web-runtime.e2e.ts`
- Modify: `apps/cli/tests/web-daemon.snapshot.ts`

**Interfaces:**
- `BrowserHandoffTransport.open(navigation: DashboardNavigation): Promise<void>` is injected; only `DashboardAttachment.createBrowserHandoff()` provides its origin and opaque handoff.
- `runWebInvocation(invocation, connector, opener, io): Promise<number>` uses `connect({ start: invocation.operation === 'open' })`.
- `RuntimeStatus` and `RuntimeLeaseStatus` are rendered redacted; `RuntimeUnavailableError` for status reports an absent Runtime and exits nonzero without starting one.

- [ ] **Step 1: Write failing Web operation tests**

Assert normal `web` connects with `start: true`, attaches one Dashboard client, calls its `createBrowserHandoff()` once, and passes the resulting `DashboardNavigation` only to the transport. The transport creates an owner-only local bootstrap directory and document, verifies POSIX modes or the Windows current-user ACL, rejects a broader-access location, and proves its opaque file origin reaches the exact `http://127.0.0.1:<port>/_harness/handoff` target in one form body. Reject wrong, reused, or expired handoffs, receive no CORS permission, and require the `expiresAt`-bound cleanup to delete the owned document and directory exactly once after dispatch failure, exchange success or failure, and expiry; advance a never-dispatched transport to expiry and require the same cleanup. Reach clean `http://127.0.0.1:<port>/` without writing a secret to stdout/stderr. Assert `--no-open` skips the transport, daemon/background each acquire exactly one lease, both aliases together address the persistent named `web` lease for the `HARNESS_HOME`, `--status` calls only `connect({ start: false })` and `status()`, and `--stop` calls only `connect({ start: false })` and `releaseBackgroundLease()`; an absent lease is a successful idempotent stop.

- [ ] **Step 2: Run the RED Web tests**

Run: `pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts`

Expected: FAIL because the existing module strips flags and spawns a detached web profile child with a private log.

- [ ] **Step 3: Replace detached-server ownership with Runtime operations**

Delete `spawn`, log-directory, PID, and child-cleanup behavior from `web-daemon.ts`; retain its filename only to avoid an unrelated move. Implement the transient-bootstrap transport and Runtime orchestration through `attachDashboard()`, `createBrowserHandoff()`, and each attachment's `close()`. Create a fresh owner-only local bootstrap directory and document, verify its POSIX modes or Windows current-user ACL, and reject a broader-access location. The file URL, launch arguments, and logs are clean, although the document has the handoff only in a hidden form field. Bind exactly one idempotent cleanup timer to `expiresAt`; dispatch failure, exchange success or failure, expiry, and a never-dispatched document remove the owned document and directory through that cleanup once. The document auto-POSTs from its opaque origin to the exact Runtime endpoint; the handler authenticates only the atomically consumed, unexpired form value, emits no CORS permission, and returns a clean `303` before the Dashboard starts. `--status` must not fall back to start, `--stop` must not terminate work or disconnect clients, and all outcomes use the foundation recovery normalizer and redact endpoint tokens and handoffs.

- [ ] **Step 4: Verify source, built, and snapshot surfaces**

Run: `pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-runtime.e2e.ts`

Run: `pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts`

Run:

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/web-runtime.e2e.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built Web runtime verification failed.' }
  pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built Web snapshot verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
```

Expected: PASS. The real entry test runs two independent CLI processes, attaches both Web commands to one Runtime, verifies aliases name one lease, releases it from the later process, proves duplicate stop is safe and status did not create an endpoint, and proves stop preserved active terminal work.

- [ ] **Step 5: Commit the Web launcher**

Run: `git add apps/cli/src/browser.ts apps/cli/src/web-daemon.ts apps/cli/src/main.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/web-daemon.snapshot.ts && git diff --cached --check && git commit -m "feat(web): hand off browsers through Runtime"`

### Task 4: Start the Dashboard only after the transient bootstrap redirect

**Files:**
- Modify: `apps/cli/src/browser.ts`
- Create: `apps/cli/tests/browser-bootstrap.spec.ts`
- Modify: `apps/web/src/main.ts`
- Create: `apps/web/tests/runtime-bootstrap.e2e.ts`
- Create: `apps/web/tests/runtime-bootstrap.snapshot.ts`

**Interfaces:**
- The transient local bootstrap document submits the handoff only in a form body from its opaque file origin. `apps/web/src/main.ts` starts only at the clean redirected Dashboard URL after the Runtime session cookie is set.
- It throws `DashboardHandoffError` with a user-safe reconnect instruction when a cookie-authenticated Dashboard request fails; neither the exception nor any DOM string contains a handoff or token.

- [ ] **Step 1: Write failing Dashboard bootstrap tests**

Use a real browser page launched through the transient bootstrap document. Assert its hidden field is the sole raw handoff location, the directory and document have verified owner-only POSIX modes or a current-user Windows ACL, and a broader-access location is rejected. Assert its opaque file origin POST reaches the current `127.0.0.1` target without CORS permission or Origin-equality authentication and request-body capture is redacted. Advance a never-dispatched document to `expiresAt`, then cover dispatch failure and both exchange outcomes; each must invoke the same exactly-once cleanup of the document and directory. Assert every browser navigation URL, non-cookie request header, referrer, history, script storage, log, diagnostic, DOM value, console output, and snapshot excludes the handoff; the protected Dashboard appears only at clean `/` after the `HttpOnly; SameSite=Strict; Path=/` session-cookie redirect. Assert wrong, expired, or reused handoff displays exactly `Dashboard connection expired. Run harness web to reconnect.`, does not mount protected state, and leaves no handoff or session value in localStorage, sessionStorage, IndexedDB, console output, or snapshot text.

- [ ] **Step 2: Run the RED Web bootstrap tests**

Run: `pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

Expected: FAIL because the existing launch path has no transient bootstrap transport or cookie-authenticated clean Dashboard startup.

- [ ] **Step 3: Implement the smallest body-only local-file bootstrap**

Make `main.ts` reject any non-clean initial Dashboard location and start `new AppWebEntry(el).run()` only after the Runtime's body-only local-file bootstrap handler has set the cookie and redirected to clean `/`. Do not add a Dashboard handoff reader, hash handling, history replacement, or persistent browser storage write. On cookie-authentication failure render the stable recovery text `Dashboard connection expired. Run harness web to reconnect.`; do not reveal token, session identifier, raw Runtime error, or raw handoff.

- [ ] **Step 4: Verify Web source/build and client handoff**

Run: `pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

Run:

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built browser bootstrap verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/runtime-bootstrap.e2e.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap e2e verification failed.' }
pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/runtime-bootstrap.snapshot.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap snapshot verification failed.' }
```

Expected: PASS; the built transient bootstrap verifies owner-only file access, submits one body-only handoff exactly once, cleans up its owned document and directory exactly once on every dispatch/exchange/expiry path, redirects to the clean Dashboard URL, and the Dashboard uses the Runtime cookie for subsequent protected requests without receiving a handoff.

- [ ] **Step 5: Commit the Dashboard bootstrap**

Run: `git add apps/cli/src/browser.ts apps/cli/tests/browser-bootstrap.spec.ts apps/web/src/main.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts && git diff --cached --check && git commit -m "feat(web): bootstrap Dashboard through Runtime handoff"`

### Task 5: Route desktop activation and close the shared-client acceptance matrix

**Files:**
- Create: `apps/cli/src/desktop.ts`
- Modify: `apps/cli/src/main.ts`
- Create: `apps/cli/tests/desktop.spec.ts`
- Modify: `apps/cli/tests/source-launch.compat.spec.ts`
- Create: `apps/cli/tests/runtime-clients.acceptance.artifact.ts`
- Modify: `apps/cli/tests/web-daemon.snapshot.ts`

**Interfaces:**
- `InstalledDesktopActivator.activate(): Promise<'activated'>` never accepts a Runtime token, persistence path, credential object, or fallback browser URL. It is the sole installed-app resolver/activator used by `harness desktop` and `dsh desktop`; Desktop packaging consumes it rather than recreating it.
- `DesktopNotInstalledError` contains only a platform-specific installation route and diagnostic identifier.
- `runDesktopInvocation(activator, io): Promise<number>` maps installation absence to stderr and does not call `RuntimeConnector`.

- [ ] **Step 1: Write failing desktop and cross-client tests**

Assert `harness desktop` calls the activator once and never calls Runtime connect; an absent installation prints its platform route to stderr, returns nonzero, and does not open a browser or spawn Electron. In the acceptance fixture, start a terminal task, attach Web, confirm both observe the same Runtime session identity, release Web's lease with `--stop`, and prove the terminal operation remains active. Run every assertion once through `harness` and once through `dsh`.

- [ ] **Step 2: Run the RED tests**

Run: `pnpm exec vitest run apps/cli/tests/desktop.spec.ts apps/cli/tests/source-launch.compat.spec.ts`

Run after `pnpm run build`: `pnpm exec vitest run --config vitest.artifact.config.ts apps/cli/tests/runtime-clients.acceptance.artifact.ts`

Expected: FAIL because desktop is not a command and the compatibility entry still has a profile-only dispatch path.

- [ ] **Step 3: Implement installed-app-only dispatch**

Add the desktop adapter and dispatch branch. It may activate the registered installed application or report `DesktopNotInstalledError`; it must not import `electron`, start a Runtime, create a handoff, or start a substitute child. Ensure both bin files still invoke the same `runCli` parser/dispatcher and differ only in the printed compatibility command name.

- [ ] **Step 4: Run final client verification**

Run: `pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/interactive-terminal.pty.e2e.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/desktop.spec.ts apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/source-launch.compat.spec.ts`

Run: `pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

Run:

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/source-launch.compat.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built CLI Runtime verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
pnpm exec vitest run --config vitest.artifact.config.ts apps/cli/tests/runtime-clients.acceptance.artifact.ts
if ($LASTEXITCODE -ne 0) { throw 'Built shared-client artifact verification failed.' }
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/runtime-bootstrap.e2e.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap e2e verification failed.' }
```

Expected: PASS in source and built entry modes. All user-visible CLI diagnostics and snapshots are token-free; status has no start side effect; no test demonstrates a second Runtime or a client persistence write.

- [ ] **Step 5: Commit the completed client graph**

Run: `git add apps/cli/src/desktop.ts apps/cli/src/main.ts apps/cli/tests/desktop.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/runtime-clients.acceptance.artifact.ts apps/cli/tests/web-daemon.snapshot.ts && git diff --cached --check && git commit -m "feat(cli): activate installed desktop client"`

## Self-review

- Bare terminal, initial task, Ink normal-scrollback interaction, slash controls, two-stage Ctrl+C, resize/color, stable exit codes, `run --json`, Web handoff, lease aliases, no-start status, idempotent lease-only stop, dsh parity, and installed-only desktop all have a dedicated task and focused test.
- Every Runtime-touching task consumes the foundation API and prohibits direct persistence, credential, lock, endpoint, token, and second-Runtime ownership. CLI/Web own the command graph, resolver/activator, and stop semantics that Desktop/Icon packaging consumes.
- The final task includes source, built, PTY, snapshot, and cross-client real-entry validation. No implementation instruction edits the unified Runtime specification, README files, manifests outside Task 2's declared CLI exceptions, or generated `.superpowers/dist` output.

Plan complete and saved to `docs/superpowers/plans/2026-08-18-harness-cli-web-runtime.md`. Execution options: subagent-driven development or inline execution with review checkpoints.
