# Runtime Update Preferences Implementation Plan

English | [中文](2026-08-24-runtime-update-preferences.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared local Runtime the only owner of a Desktop update channel and redacted update outcome record, without creating an updater, trust root, downloader, or installer.

**Architecture:** `packages/host/local-runtime` registers one `desktop-update` settings section through the existing settings provider. Authenticated native and Dashboard control routes expose only the selected channel; native callers may additionally write a fixed-format, secret-free outcome. The Runtime does not fetch, validate, stage, apply, or roll back an artifact in this delivery.

**Tech Stack:** TypeScript, Cordis, `@harness-desktop/dsh-settings`, Schemastery, Vitest, and the existing private Runtime control protocol.

**Spec:** [Harness Desktop Product Architecture Design](../specs/2026-08-15-harness-desktop-design.md)

## Global Constraints

- `HARNESS_HOME` remains the sole writable Harness root; Electron user data, the renderer, and CLI-local files never own update preferences or outcomes.
- The only allowed channels are `stable`, `beta`, and `nightly`; the default is `stable`.
- A stored result includes only a semantic version, channel, fixed outcome, fixed code, and optional last-known-good semantic version. It never accepts or stores a URL, token, signature, manifest body, path, error text, archive name, or process detail.
- The Runtime remains able to run when a reduced test composition has no settings provider; update-control requests then fail closed. The shipped base composition has the provider.
- This phase supplies no release trust root. Any later Desktop or standalone CLI updater must reject an update when its production trust configuration is absent.
- Test fixtures use memory settings and local fake values only. They do not sign, download, install, publish, upload, notarize, or call a package manager.
- Maintain the English/Chinese pair and an Agent Note in the same change. Do not touch `vendor/` or archived Agent Notes.

---

### Task 1: Add the Runtime-owned preference record

**Files:**

- Create: `packages/host/local-runtime/src/update-preferences.ts`
- Create: `packages/host/local-runtime/tests/update-preferences.spec.ts`
- Modify: `packages/host/local-runtime/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `DesktopUpdateChannel = 'stable' | 'beta' | 'nightly'`.
- Produces `DesktopUpdateOutcome`, whose `kind` is `up-to-date`, `staged`, `applied`, `rolled-back`, or `failed`, and whose `code` is a closed, redacted enum.
- Produces `DesktopUpdatePreferences.getChannel()`, `setChannel(channel)`, and `record(outcome)`, all backed by `settings.register(settingsNamespace('desktop-update'), ...)`.

- [x] **Step 1: Write the failing preference tests**

Create a local `MemorySettings` subclass in the test, boot it in a real Cordis `Context`, then construct `DesktopUpdatePreferences`. Assert the initial channel is `stable`; after `setChannel('beta')`, the provider document contains exactly `{ channel: 'beta' }`; after `record(...)`, it contains the same channel plus exactly the allowed outcome fields. Start a channel write and an outcome write together with delayed persistence, await both, and assert neither committed field was lost.

```text
expect(preferences.getChannel()).toBe('stable')
await preferences.setChannel('beta')
await preferences.record({ version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged' })
expect(settings.doc['desktop-update']).toEqual({
  channel: 'beta',
  lastOutcome: { version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged' },
})
```

- [x] **Step 2: Run the new test and confirm it fails for the missing module**

Run: `pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts`

Expected: FAIL because `../src/update-preferences.ts` does not exist.

- [x] **Step 3: Implement the smallest settings owner**

Add a `desktop-update` schema with the exact channel and outcome unions. Construct one `SettingsScope` from the supplied `SettingsProvider`; `getChannel()` reads its resolved channel, while the two writes call `scope.update(...)` so the provider's existing serialized write queue and file persistence remain authoritative. Keep validation at the control-route parser for untrusted wire input; do not add a second file writer or an optional compatibility format.

```text
const scope = settings.register(DESKTOP_UPDATE_SETTINGS_NAMESPACE, DESKTOP_UPDATE_SETTINGS_SCHEMA)
return {
  getChannel: () => scope.get().channel,
  setChannel: channel => scope.update({ channel }),
  record: outcome => scope.update({ lastOutcome: outcome }),
}
```

Add direct runtime dependencies for `@harness-desktop/dsh-settings` and `@harness-desktop/schemastery`, then regenerate the lockfile through pnpm rather than editing it manually.

- [x] **Step 4: Run the preference tests and package typecheck**

Run: `pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts`

Run: `pnpm exec tsc -b packages/host/local-runtime/tsconfig.json`

Expected: both commands pass; the test uses a real settings-provider queue and never creates an update-specific persistence path.

- [x] **Step 5: Commit the isolated preference owner**

Run:

```powershell
git add packages/host/local-runtime/src/update-preferences.ts packages/host/local-runtime/tests/update-preferences.spec.ts packages/host/local-runtime/package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(runtime): own Desktop update preferences"
```

### Task 2: Route the redacted Runtime API through authenticated control

**Files:**

- Modify: `packages/host/local-runtime/src/runtime-client.ts`
- Modify: `packages/host/local-runtime/src/control-routes.ts`
- Modify: `packages/host/local-runtime/src/control-service.ts`
- Modify: `packages/host/local-runtime/src/runtime.ts`
- Modify: `packages/host/local-runtime/src/index.ts`
- Modify: `packages/host/local-runtime/tests/control-service.spec.ts`
- Modify: `packages/host/local-runtime/tests/runtime-client.spec.ts`

**Interfaces:**

- Adds `RuntimeClient.getDesktopUpdateChannel(): Promise<DesktopUpdateChannel>` and `RuntimeClient.setDesktopUpdateChannel(channel): Promise<DesktopUpdateChannel>`.
- Adds `RuntimeClient.recordDesktopUpdateOutcome(outcome): Promise<void>` for native callers only.
- Adds authenticated Dashboard operations `get-desktop-update-channel` and `set-desktop-update-channel`; Dashboard control cannot read or write recorded outcomes.
- Adds native operations with exact request keys: `get-desktop-update-channel`, `set-desktop-update-channel` plus `channel`, and `record-desktop-update-outcome` plus `outcome`.

- [x] **Step 1: Write failing wire and ownership tests**

Extend the private-control Runtime fixture with a real memory settings provider. Through `RuntimeClient`, assert that a native attachment reads `stable`, changes it to `nightly`, and receives the committed value. Send malformed JSON directly to the control route for an unexpected channel, an extra key, an arbitrary outcome code, or a URL-like outcome field; require the existing stable invalid-control response. Use an authenticated Dashboard request to change the channel, then prove an attempted outcome record is rejected rather than becoming a Dashboard capability.

```text
await expect(client.setDesktopUpdateChannel('nightly')).resolves.toBe('nightly')
await expect(client.recordDesktopUpdateOutcome({
  version: '1.2.3', channel: 'nightly', kind: 'failed', code: 'manifest-rejected',
})).resolves.toBeUndefined()
expect(await dashboardControl('get-desktop-update-channel')).toBe('nightly')
```

- [x] **Step 2: Run the focused tests and confirm the public API is absent**

Run: `pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts`

Expected: FAIL at typecheck or runtime because the client methods and control operations are absent.

- [x] **Step 3: Implement exact parsers, retainers, and client methods**

Extend the request unions and `parseControlSuccess()` with a strict parser for a channel string and the fixed outcome object. Extend `isRuntimeControlRequest()` and `isDashboardControlRequest()` so only the named key sets cross the HTTP boundary. Pass one `DesktopUpdatePreferences` instance from `startRuntime()` when `ctx.get('settings')` exists. `set` and `record` use `retainRuntime(...)` so an idle transition cannot dispose the Runtime during a settings write; reads do not create a retainer. If a reduced composition lacks settings, return only the existing redacted unavailable failure path and do not create a fallback store.

```text
case 'set-desktop-update-channel':
  requireBaseClient(clients, clientId)
  return retainRuntime(async () => updatePreferences.setChannel(request.channel))
case 'record-desktop-update-outcome':
  requireBaseClient(clients, clientId)
  return retainRuntime(async () => updatePreferences.record(request.outcome))
```

Export only the public types and connector methods from `src/index.ts`; do not export endpoint details, settings-provider internals, or any persistence path.

- [x] **Step 4: Run source and built control evidence**

Run: `pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts`

Run: `pnpm run build`

Run: `pnpm exec vitest run packages/host/local-runtime/tests/runtime-process.compat.spec.ts`

Expected: all tests pass; malformed control bodies remain refused, Dashboard access is limited to the channel, and built Runtime client compatibility remains intact.

- [x] **Step 5: Commit the Runtime control API**

Run:

```powershell
git add packages/host/local-runtime/src/runtime-client.ts packages/host/local-runtime/src/control-routes.ts packages/host/local-runtime/src/control-service.ts packages/host/local-runtime/src/runtime.ts packages/host/local-runtime/src/index.ts packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts
git diff --cached --check
git commit -m "feat(runtime): expose redacted update control"
```

### Task 3: Document the durable ownership and record its safety decision

**Files:**

- Modify: `packages/host/local-runtime/README.md`
- Modify: `packages/host/local-runtime/README.zh.md`
- Modify: `packages/host/local-runtime/README.i18n.yaml`
- Create: `.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.i18n.yaml`

**Interfaces:**

- Documents that the Runtime owns channel and redacted outcome persistence, that Dashboard sees only the channel, and that this delivery cannot install or fetch an update without later production trust configuration.

- [x] **Step 1: Write the paired package contract and Agent Note**

Add one concise paragraph to the package README's migration/provider ownership section. State the namespace name, the three accepted channels, the fixed redacted outcome fields, the Dashboard/native split, and the fact that no update action occurs in this package. Create an implemented architecture Agent Note with `Problem`, `Decision`, `Alternatives considered`, and `Consequences`; record why Electron-local state and a fail-open default were rejected.

- [x] **Step 2: Re-record both bilingual pairs**

Run:

```powershell
pnpm run verify-translation-pairing --write packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.md
pnpm run verify-translation-pairing packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.md
```

Expected: all three named pairs are structurally aligned and their sidecar records contain the current blob hashes.

- [x] **Step 3: Run focused documentation and release-readiness checks**

Run:

```powershell
pnpm run verify-agent-note-format
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run verify-package-readme-model-experience
pnpm run verify-package-readme-limitations
pnpm run verify-package-paths
git diff --check
```

Expected: the Task 7 file path is real, prose has paired counterparts, and the Runtime README remains within its documented contract.

- [x] **Step 4: Commit documentation with the implementation**

Run:

```powershell
git add packages/host/local-runtime/README.md packages/host/local-runtime/README.zh.md packages/host/local-runtime/README.i18n.yaml .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.zh.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.i18n.yaml docs/superpowers/plans/2026-08-24-runtime-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.zh.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.i18n.yaml
git diff --cached --check
git commit -m "docs(runtime): record update preference ownership"
```

## Plan Self-Review

- The approved update architecture is covered through a single Runtime preference owner and authenticated channel control; artifact trust, download, staging, installation, and rollback intentionally remain later delivery units because their production trust configuration is not supplied.
- The plan names every created or modified file for this delivery and assigns each public type and method before a consumer uses it.
- Review the plan for prohibited implementation-placeholder vocabulary before execution; no task delegates an unspecified behavior to a later step.
