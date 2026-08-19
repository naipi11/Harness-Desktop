# Harness Shared Local Runtime Foundation Implementation Plan

English | [中文](2026-08-18-harness-runtime-foundation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single local Runtime that exclusively owns one `HARNESS_HOME` and supplies secure, shared state to the CLI, browser Dashboard, and Desktop clients.

**Architecture:** A new `@harness-desktop/dsh-host-local-runtime` package in the existing `host` group resolves and imports the data root, owns an atomic instance lock and endpoint record, composes the existing Harness services once, and publishes an authenticated loopback API. It is the only producer of the public Node API used by the CLI and Electron Main. Native launchers use the private endpoint token for Runtime control; a launcher-owned transient local bootstrap document submits a single-use handoff only in a form body from an opaque file origin, receives an HttpOnly session cookie, and follows the clean Dashboard `303` navigation.

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`, pnpm 11, TypeScript, Cordis, existing WebServer/API proxy/Web frontend packages, Vitest, Playwright-compatible HTTP fixtures.

**Spec:** [Harness unified local Runtime design](../specs/2026-08-18-harness-unified-local-runtime-design.md) and [Harness Desktop product architecture](../specs/2026-08-15-harness-desktop-design.md).

## Global Constraints

- One `HARNESS_HOME` has exactly one Runtime; only that Runtime mounts or writes sessions, project metadata, settings, credential references, locks, and endpoint records.
- Resolve `HARNESS_HOME` before execution: Windows `%LOCALAPPDATA%\Harness Desktop`; macOS `~/Library/Application Support/Harness Desktop`; Linux `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`; `HARNESS_HOME` overrides the default.
- Legacy `DSH_HOME` migration copies supported non-secret data only into an empty target, never overwrites or deletes either root, and returns a typed result that identifies the retained source and target.
- The Runtime binds only `127.0.0.1` with port `0`; no config or fallback permits a LAN listener.
- Endpoint tokens and credential values never enter command lines, initial navigation URLs, Renderer messages, browser script storage, session records, logs, diagnostics, or snapshots. A high-entropy handoff may appear only in the body of one local-file-origin form `POST /_harness/handoff`, never in a URL, header, referrer, history, browser storage, Renderer IPC, log, diagnostic, or transcript; its capture is redacted before every diagnostic or log sink. The launcher creates its bootstrap directory and file with owner-only POSIX modes or a current-user Windows ACL, verifies that protection, and rejects a broader-access location. Its exactly-once cleanup timer is bound to `expiresAt`; the same idempotent cleanup removes the owned file and directory after dispatch failure, exchange success or failure, or expiry, including a document never dispatched. The exchange deliberately does not require Origin equality and emits no CORS permission. The post-exchange randomized or signed session credential is the sole browser exception: Runtime sends it only in `Set-Cookie`, the browser sends it only in `Cookie` headers, and its HttpOnly cookie jar retains it; it uses `HttpOnly; SameSite=Strict; Path=/` with no expiry attribute and never reaches Dashboard JavaScript, Renderer IPC, script storage, app persistence, logs, diagnostics, snapshots, or transcripts.
- The endpoint record contains protocol version, random port, Runtime identity, and process-start identity; stale records are removed only after the recorded process identity is proved dead.
- The token-bearing endpoint record is Runtime-foundation control-plane state. Only its private discovery implementation reads or parses it; applications consume `RuntimeConnector` and receive redacted typed errors and public origin data only.
- Native control requests authenticate with the private endpoint token. The body-only handoff exchange accepts an opaque file origin solely by its unused, unexpired secret; normal Dashboard API and event requests authenticate with an exact loopback origin plus the `HttpOnly; SameSite=Strict; Path=/` session cookie issued by that single-use handoff within 60 seconds.
- Runtime exit requires zero attached clients, zero active agent operations, and zero background leases; a crash, sign-out, or update never restarts it from a stale lease.
- Do not change CLI or Electron client behavior in this plan. Those plans consume the Runtime public API and must not reproduce its lock, persistence, credential, or composition logic. No caller parses an endpoint record or receives its token; `RuntimeConnector` is the sole restricted control-plane reader.
- Every new package and Agent Note has English, Simplified Chinese, and recorded `.i18n.yaml` siblings.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/host/local-runtime/src/data-root.ts` | Resolve the sole data root and perform safe one-way legacy import. |
| `packages/host/local-runtime/src/process-identity.ts` | Read and compare platform process-start identities without treating a reused PID as live. |
| `packages/host/local-runtime/src/instance-lock.ts` | Acquire, verify, release, and recover the atomic per-home owner lock. |
| `packages/host/local-runtime/src/endpoint-record.ts` | Atomically persist the private endpoint record and derive redacted status. |
| `packages/host/local-runtime/src/runtime-client.ts` | Export the only public discovery, attachment, terminal, handoff, lease, status, recovery, and close API. |
| `packages/host/local-runtime/src/auth.ts` | Implement native-token control authorization and browser handoff/cookie authentication. |
| `packages/host/local-runtime/src/runtime.ts` | Compose the canonical Cordis tree, account for work and leases, and own graceful idle shutdown. |
| `packages/host/local-runtime/src/control-routes.ts` | Mount private native control routes and authenticated browser API/event routes. |
| `packages/host/local-runtime/src/bin.ts` | Run one Runtime process from source and built artifacts; it has no public user command. |
| `packages/host/local-runtime/tests/` | Isolated filesystem/process/auth tests plus clean-tree Runtime integration tests. |
| `packages/util/home-paths/src/index.ts` | Keep dependency-free path primitives only; it never imports Runtime policy or selects a Harness data root. |

### Task 1: Create the Runtime package, public types, and data-root resolver

**Files:**
- Create: `packages/host/local-runtime/package.json` as `@harness-desktop/dsh-host-local-runtime`
- Create: `packages/host/local-runtime/tsconfig.json`
- Create: `packages/host/local-runtime/tsdown.config.ts`
- Create: `packages/host/local-runtime/src/index.ts`
- Create: `packages/host/local-runtime/src/data-root.ts`
- Create: `packages/host/local-runtime/src/invariant.ts`
- Create: `packages/host/local-runtime/README.md`
- Create: `packages/host/local-runtime/README.zh.md`
- Create: `packages/host/local-runtime/README.i18n.yaml`
- Create: `packages/host/local-runtime/tests/data-root.spec.ts`
- Modify: `packages/host/README.md`
- Modify: `packages/host/README.zh.md`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `packages/util/home-paths/src/index.ts`
- Modify: `packages/util/home-paths/tests/home-paths.spec.ts`
- Modify: `apps/cli/src/profile-boot.ts`
- Modify: `apps/cli/src/web-daemon.ts`
- Modify: `packages/attachment/attachment-local/src/index.ts`
- Modify: `packages/boot/app-boot/src/index.ts`
- Modify: `packages/boot/app-boot/src/profile.ts`
- Modify: `packages/context/agent-instructions/src/config.ts`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Modify: `packages/examples/agent-spine-demo/src/index.ts`
- Modify: `packages/identity/anonymous-user-id/src/index.ts`
- Modify: `packages/preset/agent-presets/src/index.ts`
- Modify: `packages/settings/settings-file/src/index.ts`
- Modify: `packages/shell/shell-env/src/index.ts`
- Modify: `packages/skill/skill-filesystem/src/index.ts`
- Modify: `apps/web/tests/scaffold.ts`, `packages/boot/app-boot/tests/app-boot.spec.ts`, and affected consumer fixtures

**Interfaces:**
- Consumes: filesystem paths, the existing `@harness-desktop/dsh-brand` helper, and no application service.
- Produces: `HarnessHome`, `resolveHarnessHome(input)`, `defaultHarnessHome(platform, env, homeDir)`, `HarnessHomeProvider`, and `createLocalRuntimePlugin(config)`.

- [ ] **Step 1: Write the failing data-root tests**

Create table-driven tests that pass injected `platform`, `env`, and `homeDir` values. Require the resolver to return the exact default or `HARNESS_HOME` override, normalize it to an absolute path, reject whitespace-only overrides, and never choose `DSH_HOME` as the write target. Include a test importing `HarnessHome` from the new package before it exists.

- [ ] **Step 2: Run the focused tests and confirm the package is absent**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/data-root.spec.ts packages/util/home-paths/tests/home-paths.spec.ts
```

Expected: FAIL because `packages/host/local-runtime` and the `HARNESS_HOME` API do not exist.

- [ ] **Step 3: Add the minimal typed resolver and package boundary**

Import `Branded` from `@harness-desktop/dsh-brand`; do not redeclare it. Keep all `HARNESS_HOME` defaulting in `resolveHarnessHome`, not inside a caller:

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type HarnessHome = Branded<'HarnessHome'>

export interface HarnessHomeInput {
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly localAppData?: string
}

export interface HarnessHomeResolution {
  readonly path: HarnessHome
  readonly source: 'environment' | 'platform-default'
  readonly legacyDshHome: string | undefined
}

export declare function resolveHarnessHome(input?: HarnessHomeInput): HarnessHomeResolution
```

`HarnessHomeInput` accepts injectable `platform`, `env`, `homeDir`, and `localAppData` fields for tests. Keep `expandHomePath()` and `canonicalizeWatchPath()` in `packages/util/home-paths`; remove its `defaultDshHome`, `resolveDshHome`, `dshHomePath`, and `DSH_HOME` policy exports instead of making that utility depend on the host package. The Runtime imports these dependency-free primitives, resolves the one `HARNESS_HOME` policy, and injects a resolved `HarnessHomeProvider`/absolute paths into every writer. Migrate each current policy consumer named in the file list: CLI profile/Web paths, attachment-local, app-boot/profile and Loader expression, agent instructions, credentials-local, agent-spine demo, anonymous identity, presets, settings, shell environment, skill filesystem, and their app/test fixtures. Tests must assert that no `resolveDshHome`, `dshHomePath`, or `DSH_HOME` default writer remains outside an explicitly marked legacy-import source reader, and that every mounted writable path receives the same injected `HarnessHome`. Create the complete package skeleton, README pair and i18n record in its creation task. Register the child in both host README maps, add the exact source aliases for `@harness-desktop/dsh-host-local-runtime` and `@harness-desktop/dsh-host-local-runtime/*` to `tsconfig.base.json`, and add its project reference to `tsconfig.host.json`; those registrations are part of the package boundary, not deferred cleanup.

- [ ] **Step 4: Run source and artifact checks**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/data-root.spec.ts packages/util/home-paths/tests/home-paths.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run typecheck
```

Expected: all tests pass; the built package exports the resolver and the existing compatibility helper has one delegated implementation.

- [ ] **Step 5: Commit the data-root foundation**

Run:

```powershell
git add packages/host/local-runtime packages/host/README.md packages/host/README.zh.md tsconfig.base.json tsconfig.host.json packages/util/home-paths
git diff --cached --check
git commit -m "feat(runtime): add Harness data-root resolver"
```

### Task 2: Add safe legacy import and platform credential-reference admission

**Files:**
- Create: `packages/host/local-runtime/src/legacy-import.ts`
- Create: `packages/host/local-runtime/tests/legacy-import.spec.ts`
- Create: `packages/credentials/credentials-platform/src/index.ts`
- Create: `packages/credentials/credentials-platform/package.json`
- Create: `packages/credentials/credentials-platform/tsconfig.json`
- Create: `packages/credentials/credentials-platform/tsdown.config.ts`
- Create: `packages/credentials/credentials-platform/src/invariant.ts`
- Create: `packages/credentials/credentials-platform/README.md`
- Create: `packages/credentials/credentials-platform/README.zh.md`
- Create: `packages/credentials/credentials-platform/README.i18n.yaml`
- Create: `packages/credentials/credentials-platform/tests/platform-provider.spec.ts`
- Modify: `packages/credentials/README.md`
- Modify: `packages/credentials/README.zh.md`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Modify: `packages/bundle/base/cordis.patch.yml`
- Modify: `packages/host/local-runtime/package.json`

**Interfaces:**
- Consumes: `HarnessHomeResolution`, the existing credential service definition, and an injected filesystem/credential adapter.
- Produces: `detectLegacyImport()`, `recordLegacyImportDecision(decision)`, `importLegacyDshHome(request)`, `LegacyImportResult`, and a Runtime-only credential provider that persists references but obtains secret values from the platform/environment provider.

- [ ] **Step 1: Write failing import and secret-boundary tests**

Create temporary source and target roots. Require a successful import to copy supported sessions/settings/project metadata into an empty target, preserve the source, and report copied paths. Require a non-empty target to return `{ kind: 'target-not-empty' }`, a copy failure to return `{ kind: 'failed', retained: [...] }`, and neither result to delete a root. Seed a legacy `.credentials.yaml` with a sentinel secret and require that no target file contains that sentinel after import. On first start, require Runtime-owned detection to expose a typed pending decision, record an accept/decline/result without secrets, and expose an actionable retry after a collision or failure while preserving both roots. Cover the full credentials-platform package manifest, build face, invariant, bilingual README, and i18n record rather than treating it as an unowned source directory.

- [ ] **Step 2: Run the focused tests and confirm the behavior is missing**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/legacy-import.spec.ts packages/credentials/credentials-platform/tests/platform-provider.spec.ts
```

Expected: FAIL because the importer and platform credential provider do not exist.

- [ ] **Step 3: Implement the explicit import and credential-reference result types**

Use these result variants so callers can render a safe correction without parsing text:

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type HarnessHome = Branded<'HarnessHome'>
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>

export type LegacyImportResult =
  | { readonly kind: 'imported'; readonly copied: readonly string[]; readonly source: string; readonly target: HarnessHome }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'target-not-empty'; readonly target: HarnessHome }
  | { readonly kind: 'failed'; readonly source: string; readonly target: HarnessHome; readonly retained: readonly string[]; readonly diagnosticId: RuntimeDiagnosticId }
```

Copy only known non-secret roots through a staging directory followed by atomic moves. Make the new provider resolve credential values from a platform/environment adapter and store only opaque reference metadata beneath `HARNESS_HOME`; remove the file-provider path from the Runtime composition rather than silently reading legacy values. Create the credentials-platform README pair and i18n record with the package. Add it to both credentials README maps, add exact `@harness-desktop/dsh-credentials-platform` and `@harness-desktop/dsh-credentials-platform/*` source aliases in `tsconfig.base.json`, and add its project reference to `tsconfig.host.json`.

The Runtime stores the pending/accepted/declined/result state and executes imports, but never chooses for a user. The interactive CLI owns its terminal prompt; `harness web` and installed Desktop present the same Dashboard migration UI after their normal attachment. A non-interactive `run` invocation reports a typed `migration-decision-required` recovery diagnostic. No client attempts the copy directly, and an accepted import is retried only through the Runtime after the user fixes the reported collision or failure.

- [ ] **Step 4: Run provider, import, and build verification**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/legacy-import.spec.ts packages/credentials/credentials-platform/tests/platform-provider.spec.ts packages/credentials/credentials-local/tests/local.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run verify-cordis-config
pnpm run verify-translation-pairing --write packages/credentials/credentials-platform/README.md
pnpm run verify-translation-pairing packages/credentials/credentials-platform/README.md
pnpm run typecheck
```

Expected: import behavior is recoverable, no secret sentinel moves into the target, the canonical base composition resolves the new provider, and the complete credentials-platform package builds with its invariant and bilingual package documentation.

- [ ] **Step 5: Commit the migration boundary**

Run:

```powershell
git add packages/host/local-runtime packages/credentials/README.md packages/credentials/README.zh.md packages/credentials/credentials-platform packages/credentials/credentials-local packages/bundle/base tsconfig.base.json tsconfig.host.json
git diff --cached --check
git commit -m "feat(runtime): import legacy data without credential values"
```

### Task 3: Prove single-instance ownership with locks, process identity, and endpoint records

**Files:**
- Create: `packages/host/local-runtime/src/process-identity.ts`
- Create: `packages/host/local-runtime/src/instance-lock.ts`
- Create: `packages/host/local-runtime/src/endpoint-record.ts`
- Create: `packages/host/local-runtime/tests/fixtures/runtime-owner.ts`
- Create: `packages/host/local-runtime/tests/instance-lock.spec.ts`
- Create: `packages/host/local-runtime/tests/endpoint-record.spec.ts`
- Modify: `packages/host/local-runtime/src/index.ts`

**Interfaces:**
- Consumes: `HarnessHome`, atomic filesystem operations, and injected process probes for platform-independent tests.
- Produces: `ProcessIdentity`, `RuntimeLock`, `PrivateEndpointRecord`, `RedactedRuntimeStatus`, and no token-bearing status serializer.

- [ ] **Step 1: Write failing concurrent-owner and stale-record tests**

Start a fixture owner process against one temporary `HARNESS_HOME`. Require the first acquisition to succeed and a concurrent acquisition to return `{ kind: 'owned-by-live-runtime' }`. Write a record whose PID matches a probe but whose process-start identity differs; require it to be classified stale and removed only after the mismatch is proved. Assert the endpoint file is atomically replaced and its redacted view omits `accessToken`. On POSIX, assert owner-only file modes; on Windows, assert the current-user ACL/policy result rather than POSIX mode bits. In both cases, attempt direct application-level endpoint-file access and assert it is denied by the public API and cannot disclose the token.

- [ ] **Step 2: Run the focused process tests and observe the missing modules**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/instance-lock.spec.ts packages/host/local-runtime/tests/endpoint-record.spec.ts
```

Expected: FAIL because no lock, process identity, or endpoint record module exists.

- [ ] **Step 3: Implement the ownership records with branded identities**

Use exact persistent fields and keep token-bearing records private:

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export interface ProcessIdentity {
  readonly pid: number
  readonly startedAt: string
}

export interface PrivateEndpointRecord {
  readonly protocolVersion: 1
  readonly runtimeId: Branded<'RuntimeId'>
  readonly port: number
  readonly process: ProcessIdentity
  readonly accessToken: string
}

export interface RedactedRuntimeStatus {
  readonly state: 'running' | 'stopping'
  readonly runtimeId: Branded<'RuntimeId'>
  readonly port: number
  readonly backgroundLeaseCount: number
}
```

Acquire the lock with exclusive creation before mounting a stateful service. On conflicts, probe the recorded process identity; only a proven-dead owner permits cleanup and replacement. Write endpoint updates through a same-directory temporary file plus rename, set current-user-only permissions where the platform supports them, and expose only `RedactedRuntimeStatus` to diagnostics.

- [ ] **Step 4: Run lock, artifact, and Node compatibility checks**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/instance-lock.spec.ts packages/host/local-runtime/tests/endpoint-record.spec.ts
pnpm run build:lib:host
pnpm run check:node-compat
```

Expected: the live owner cannot be displaced, PID reuse is not treated as live ownership, and built code uses only supported Node APIs.

- [ ] **Step 5: Commit the single-owner primitives**

Run:

```powershell
git add packages/host/local-runtime
git diff --cached --check
git commit -m "feat(runtime): guard one owner per Harness home"
```

### Task 4: Implement native control authorization and browser handoff authentication

**Files:**
- Create: `packages/host/local-runtime/src/auth.ts`
- Create: `packages/host/local-runtime/src/control-routes.ts`
- Create: `packages/host/local-runtime/tests/local-auth.e2e.ts`
- Create: `packages/host/local-runtime/tests/control-routes.spec.ts`
- Modify: `packages/client/connection/src/index.ts`
- Modify: `packages/host/local-runtime/src/index.ts`

**Interfaces:**
- Consumes: `WebServer`, `client-connection` route registration, and `PrivateEndpointRecord`.
- Produces: private native control routes, browser `POST /_harness/handoff`, session-cookie validation, and a callback that mounts authenticated API/event routes.

- [ ] **Step 1: Write failing security and handoff integration tests**

Start a real loopback `WebServer` on port `0`. Require native control without `Authorization: Bearer <accessToken>` to return 401 and correct authorization to mint a handoff. Create the bootstrap directory and file with verified owner-only POSIX modes or current-user Windows ACL, and reject a broader-access location. Prove a top-level form from an opaque file origin reaches `/_harness/handoff` and exchanges the same handoff once before 60 seconds; require `Set-Cookie` with `HttpOnly`, `SameSite=Strict`, `Path=/`, and no expiry attribute, then reject a wrong, replayed, or expired handoff. Require no CORS permission on the exchange response. Advance to `expiresAt` without dispatch and prove the launcher cleanup runs exactly once; also prove dispatch failure, exchange success, and exchange failure invoke the same exactly-once cleanup of the owned document and directory. Require malformed/non-loopback Origins, cross-origin cookie requests, and unauthenticated API/WebSocket requests to return or upgrade as forbidden after exchange. Assert the initial navigation URL, request headers other than the authenticated session `Cookie`, referrer, history, storage, logs, diagnostics, snapshots, and browser-visible errors exclude the handoff and endpoint token. Permit the handoff only in the form body and assert all request-body capture redacts it.

- [ ] **Step 2: Run the focused authentication tests and confirm they fail**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-routes.spec.ts packages/host/local-runtime/tests/local-auth.e2e.ts
```

Expected: FAIL because the Runtime has no authentication layer or handoff route.

- [ ] **Step 3: Add the one-time body-only handoff exchange and exact-origin API middleware**

Define an in-memory handoff map whose values contain a high-entropy opaque secret, `expiresAt`, and atomically consumable unused state. Mount private control routes under `/_harness/control/*`; minting returns only a `BrowserHandoff` opaque value. Mount `POST /_harness/handoff` before the SPA fallback. The launcher creates a new owner-only bootstrap directory and file, verifies its POSIX modes or Windows current-user ACL before opening its clean file URL, and rejects a broader-access location. Bind one idempotent cleanup timer to `expiresAt`; it receives only the bootstrap path and removes the owned file and directory exactly once on dispatch failure, exchange success or failure, or expiry. The handler must not test Origin equality, but exchanges only a valid unused, unexpired form-body handoff for a randomized or signed server-side session credential in a session `HttpOnly; SameSite=Strict; Path=/` cookie with no expiry attribute, emits no CORS permission, and sends a clean `303`. Wrap `client-connection` API and event registrations so both demand this cookie and the exact origin; retain its existing DNS-rebinding defense rather than weakening privileged-method policy.

- [ ] **Step 4: Run auth, Web route, and source/built checks**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-routes.spec.ts packages/host/local-runtime/tests/local-auth.e2e.ts packages/client/connection/tests/node-half.host.spec.ts packages/host/webserver/tests/webserver.spec.ts
pnpm run build:lib:host
pnpm run typecheck
```

Expected: the Dashboard starts only after the clean redirected URL has the cookie; cookie authentication protects HTTP and WebSocket carriers in source and built composition.

- [ ] **Step 5: Commit the local authentication layer**

Run:

```powershell
git add packages/host/local-runtime packages/client/connection
git diff --cached --check
git commit -m "feat(runtime): authenticate local Dashboard clients"
```

### Task 5: Compose the canonical Runtime and its lifecycle owner

**Files:**
- Create: `packages/host/local-runtime/src/runtime.ts`
- Create: `packages/host/local-runtime/src/bin.ts`
- Create: `packages/host/local-runtime/src/idle-lifecycle.ts`
- Create: `packages/host/local-runtime/src/harness-home-provider.ts`
- Create: `packages/host/local-runtime/tests/runtime-composition.e2e.ts`
- Create: `packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts`
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/base/cordis.patch.yml`
- Modify: `packages/host/local-runtime/package.json`
- Modify: every production consumer listed in Task 1 and their resolver manifests/config patches

**Interfaces:**
- Consumes: all primitives from Tasks 1-4 and existing `boot()`, WebServer, API proxy, Web frontend, session, settings, workspace, storage, and credential-reference providers.
- Produces: `startRuntime(config)`, `RuntimeHandle`, `attachClient`, `releaseClient`, `beginAgentWork`, `endAgentWork`, `acquireBackgroundLease`, and `releaseBackgroundLease`.

- [ ] **Step 1: Write failing composition and lifecycle tests**

Boot the canonical composition from a clean temporary root. Require exactly one `127.0.0.1` listener with an OS-assigned port, all writable provider roots beneath `HARNESS_HOME`, and an endpoint record published only after health succeeds. Inject one `HarnessHomeProvider`/config mapping into both base and Web composition and assert every Task 1 consumer receives its resolved path; fail if `resolveDshHome`, `dshHomePath`, or an old `DSH_HOME` fallback writer is mounted. Attach two test clients, create state through one API carrier, and observe it through the other. Require idle shutdown only after the last client, active-work token, and background lease release; require an active-work token to prevent shutdown; require final disposal to remove endpoint then lock.

- [ ] **Step 2: Run the focused composition tests and observe the absent Runtime owner**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-composition.e2e.ts packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts
```

Expected: FAIL because no canonical composition or lifecycle API is present.

- [ ] **Step 3: Implement a Runtime-owned composition and accounting API**

Create a single orchestration entry with these caller-visible handles:

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export interface RedactedRuntimeStatus {}
export type RuntimeClientId = Branded<'RuntimeClientId'>
export interface RuntimeAttachment {}
export type SessionId = Branded<'SessionId'>
export interface RuntimeWorkLease {}
export interface BackgroundLease { readonly id: Branded<'BackgroundLeaseId'> }

export interface RuntimeHandle {
  readonly status: () => RedactedRuntimeStatus
  attachClient(client: RuntimeClientId): Promise<RuntimeAttachment>
  releaseClient(client: RuntimeClientId): Promise<void>
  beginAgentWork(session: SessionId): Promise<RuntimeWorkLease>
  acquireBackgroundLease(owner: RuntimeClientId): Promise<BackgroundLease>
  dispose(): Promise<void>
}
```

Acquire the lock before `boot()` and configure WebServer as `{ host: '127.0.0.1', port: 0 }`. Replace each base/Web composition and every Task 1 consumer's `DSH_HOME` or old-helper lookup with the injected `HarnessHomeProvider`/config mapping; no provider may silently fall back to an old writer. Mount existing Web/API/static frontend services once and make their roots resolve from that Runtime-owned provider. Count only actual attachments, active work, and explicit background leases; start a configurable idle timer only at zero, flush durable services, remove the endpoint record, release the lock, and dispose the Cordis root in that order. The internal `bin.ts` reads `HARNESS_HOME` from environment and reports only redacted readiness to stderr.

- [ ] **Step 4: Run integration, build, and invariant verification**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-composition.e2e.ts packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts packages/session/session-persistence/tests/persistence.spec.ts packages/settings/settings-file/tests/concurrency.spec.ts packages/workspace/workspace/tests/workspace.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run verify-cordis-config
```

Expected: existing provider semantics remain green while the integration test demonstrates exactly one owner and shared committed state.

- [ ] **Step 5: Commit the Runtime process owner**

Run:

```powershell
git add packages/host/local-runtime packages/bundle/base packages/bundle/web-app
git diff --cached --check
git commit -m "feat(runtime): compose one shared local Runtime"
```

### Task 6: Add control semantics, busy-session serialization, and source/built process smoke tests

**Files:**
- Create: `packages/host/local-runtime/src/control-service.ts`
- Create: `packages/host/local-runtime/src/runtime-client.ts`
- Create: `packages/host/local-runtime/tests/control-service.spec.ts`
- Create: `packages/host/local-runtime/tests/runtime-client.spec.ts`
- Create: `packages/host/local-runtime/tests/runtime-process.compat.spec.ts`
- Create: `packages/host/local-runtime/tests/runtime-cli-process.e2e.ts`
- Create: `packages/host/local-runtime/tests/runtime-control.snapshot.ts`
- Modify: `packages/core/session/src/index.ts`
- Modify: `packages/host/local-runtime/src/runtime.ts`
- Modify: `packages/host/local-runtime/src/control-routes.ts`

**Interfaces:**
- Consumes: `RuntimeHandle`, session service events, and authenticated native control routes.
- Produces: redacted `status`, lease `acquire`/`release`, `attach`/`release`, typed session-busy responses, and the public `RuntimeConnector`/`RuntimeClient` consumed by CLI and Web.

- [ ] **Step 1: Write failing control and concurrent-work tests**

Require a native status request against a missing Runtime to return `{ kind: 'not-running' }` without creating files or a child process. Test `RuntimeConnector.connect({ start: true })` racing in two independent CLI processes: exactly one starts, both discover and attach to the same healthy Runtime, and neither application parses an endpoint file. Test `connect({ start: false })` against no Runtime returns `RuntimeUnavailableError` without writing files, processes, locks, or endpoint records. Exercise every public migration method: a CLI and authenticated Dashboard query see the same durable `LegacyMigrationState`; accept performs the copy once, decline persists, target collision and failure return redacted retryable states, and retry succeeds only after the user correction while both roots remain. Exercise `observeActiveWork()` and `stopOwnUiWork()` so a Desktop client can observe and stop only its own UI work. Require `releaseBackgroundLease` to preserve attached clients and active work. Acquire the named durable Web lease twice through `--daemon` and `--background`, assert both aliases address one lease per `HARNESS_HOME`, then release it from a later CLI process; duplicate stop is safe, `status` is idempotent, and an attached terminal remains active. Start one write-type agent operation for a session, request another from a different client, and require `{ kind: 'session-busy', sessionId, options: ['observe', 'new-session', 'wait'] }`; assert neither operation creates a duplicate session record. Run the internal binary both with `node --import tsx/esm` and from `lib/` to prove the endpoint can be discovered and released.

- [ ] **Step 2: Run control and compatibility tests and confirm they fail**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts packages/host/local-runtime/tests/runtime-cli-process.e2e.ts
```

Expected: FAIL because no status/control API or concurrent-session admission policy exists.

- [ ] **Step 3: Implement typed control results and session admission**

Define `RuntimeControlResult` as a discriminated union containing `not-running`, `version-mismatch`, `owned-by-live-runtime`, `session-busy`, and `unavailable`. Do not return the endpoint token or raw filesystem errors in any variant. Serialize write-type agent admission by branded session id; reads and observation remain concurrent. Make a status probe read and validate only an existing endpoint record, never call `startRuntime`. Route background aliases to the same lease object so release never kills tasks or other clients.

Export this exact foundation-owned Node API from `src/index.ts`. CLI/Web and Electron Main consume it unchanged; the connector alone owns racing start/discovery and the private token is never present in an application-visible value:

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
export interface BrowserHandoff {
  readonly id: BrowserHandoffId
  readonly expiresAt: number
}
export interface DashboardNavigation {
  readonly origin: DashboardOrigin
  readonly handoff: BrowserHandoff
}
export interface DashboardAttachment {
  createBrowserHandoff(): Promise<DashboardNavigation>
  close(): Promise<void>
}
export interface BrowserHandoffTransport {
  open(navigation: DashboardNavigation): Promise<void>
}
export interface RuntimeLease { readonly id: BackgroundLeaseId }
export interface RuntimeStatus {}
export interface RuntimeLeaseStatus { readonly id: BackgroundLeaseId; readonly state: 'present' | 'absent' }
export type RuntimeRecoveryCode =
  | 'runtime-unavailable'
  | 'runtime-version-mismatch'
  | 'runtime-start-failed'
  | 'dashboard-unavailable'
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
export interface ActiveWorkStatus {
  readonly ownUiWork: readonly ActiveWorkId[]
}
export type OwnUiWorkStopResult =
  | { readonly kind: 'stopped'; readonly work: readonly ActiveWorkId[] }
  | { readonly kind: 'none-active' }
  | { readonly kind: 'failed'; readonly diagnostic: RedactedRuntimeDiagnostic }

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

`RuntimeClient.close()` releases its client attachment only. Each `TerminalConnection` and `DashboardAttachment` independently releases its own attachment through `close()`; a client first calls `attachDashboard()`, then the attachment's `createBrowserHandoff()`, and closes it after the browser or Electron Main no longer needs it. `BrowserHandoffTransport` is launcher-owned: it creates a one-time bootstrap directory and document with verified owner-only POSIX modes or a current-user Windows ACL, rejects a broader-access location, and writes a hidden form field for `handoff.id`. Its file URL, launch arguments, and logs are clean, although its HTML body contains that hidden field. It opens the document and binds exactly one idempotent cleanup timer to `expiresAt`; dispatch failure, exchange success or failure, expiry, and a never-dispatched document all use that cleanup to remove the owned document and directory once. The document auto-POSTs that field from its opaque file origin to `${origin}/_harness/handoff`; the Runtime authenticates only the atomically consumed, unexpired body value, emits no CORS permission, sets the session cookie, and redirects with a clean `303` to `${origin}/`. The handoff is absent from every navigation URL, query, URL hash, header, referrer, history entry, storage value, Renderer IPC, log, diagnostic, and capture; only the verifier may inspect the raw POST body and it redacts it before recording. The post-exchange credential is permitted only in the Runtime `Set-Cookie`, browser `Cookie` request headers, and browser HttpOnly cookie jar, never in Dashboard JavaScript, Renderer IPC, script storage, app persistence, logs, diagnostics, snapshots, or transcripts. `normalizeRecoveryDiagnostic()` is the one secret-free normalizer for all callers. The `RedactedRuntimeDiagnostic` interface is the exact Foundation type Desktop imports and projects to Renderer IPC; it never includes an endpoint-record field, token, handoff, cookie, credential value, or absolute home path. Browser handoffs, no-start status, migration actions, active-work operations, and Web-lease operations use authenticated wire requests, and every public success or error serializer is redacted. Define and test these exact control-wire unions; the authenticated endpoint already scopes `web` to its one `HARNESS_HOME` and neither request nor response contains endpoint-record fields:

```ts
export type RuntimeControlRequest =
  | { readonly operation: 'status' }
  | { readonly operation: 'acquire-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'release-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }
  | { readonly operation: 'observe-active-work' }
  | { readonly operation: 'stop-own-ui-work' }

export type DashboardControlRequest =
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }
```

The Runtime persists migration decisions and redacted results under `HARNESS_HOME`; both the Node client and authenticated Dashboard control wire replay the same state after reconnect. Neither exposes legacy root paths or copied secret material. The Web lease has persistent ID `web` per `HARNESS_HOME`; acquire, release, and status work across processes. `status` and acquire are idempotent for that named lease, and release succeeds with `state: 'absent'` when the lease is already absent.

- [ ] **Step 4: Run source, built, and keyless behavior verification**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts packages/host/local-runtime/tests/runtime-cli-process.e2e.ts
pnpm run build:lib:host
pnpm exec vitest run --config vitest.snapshot.config.ts packages/host/local-runtime/tests/runtime-control.snapshot.ts
pnpm run check:node-compat
```

Expected: both process planes pass; two independent CLI processes share one Runtime and one durable named Web lease; the new real runnable keyless snapshot shows redacted status and busy recovery without a token, secret, or absolute data path.

- [ ] **Step 5: Commit the control and process compatibility layer**

Run:

```powershell
git add packages/host/local-runtime packages/core/session
git diff --cached --check
git commit -m "feat(runtime): expose safe local Runtime control"
```

### Task 7: Complete the package acceptance checks and ship the existing topology decision

**Files:**
- Modify: `.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.md` (move to `implemented/` when this workstream ships)
- Modify: `.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.zh.md` (move to `implemented/` when this workstream ships)
- Modify: `.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.i18n.yaml` (move with the pair)
- Modify: `docs/architecture.md`
- Modify: `docs/subsystems/README.md`
- Modify: `docs/subsystems/persistence.md`
- Modify: `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.zh.md`

**Interfaces:**
- Consumes: shipped Runtime public types, the existing proposed product-topology Agent Note, and the accepted product design.
- Produces: a concise current-state package contract, a status migration of the topology Agent Note that already owns the alternatives and rationale, and architecture links to the owning subsystem.

- [ ] **Step 1: Write failing documentation ownership checks**

Add a focused `runtime-docs.spec.ts` that reads the package README and architecture/subsystem pages. Require the README to name the Runtime as the sole persistence owner, list the non-disclosure guarantees, and link to the design. Require the existing topology note to move as a paired record to `implemented/`, retain its alternatives and consequences, replace future-tense work with shipped verification, and link back to the Runtime package rather than duplicating topology rationale.

- [ ] **Step 2: Run the focused document test and format gate**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-docs.spec.ts
pnpm run verify-agent-note-format
```

Expected: FAIL until the owning docs exist and the approved topology record can be promoted with shipped evidence.

- [ ] **Step 3: Write only current contracts and record all bilingual pairs**

Document the running Runtime, its config, its typed error categories, and the sole-writer/loopback/token rules in the package README. The [existing Harness Desktop product topology Agent Note](../../../.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.md) remains the only home for topology rationale and the rejected private-child model. When this workstream ships, move that paired record and its i18n record to `implemented/`, update it to current-state verification, and retain its non-overlapping alternatives and consequences. Update `architecture.md` and the relevant subsystems page by linking to these owners instead of restating their test inventory. Write Chinese counterparts with matching headings, lists, links, and code fences, then create all package `.i18n.yaml` records.

- [ ] **Step 4: Run focused documentation and package gates**

Run:

```powershell
pnpm run verify-translation-pairing --write packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md
pnpm run verify-translation-pairing packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md
pnpm run verify-agent-note-format
pnpm run verify-md-links
pnpm run doc-sync
pnpm run lint
git diff --check
```

Expected: all Runtime docs have consistent pairs and the final package passes the repository's relevant documentation and static gates.

- [ ] **Step 5: Commit the Runtime documentation and acceptance evidence**

Run:

```powershell
git add .agents/notes/implemented docs packages/host/local-runtime
git diff --cached --check
git commit -m "docs(runtime): record shared local Runtime ownership"
```
