# Stable Release Readiness Implementation Plan

English | [中文](2026-08-24-stable-release-readiness.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a test-verified Harness Desktop branch that is ready for separate signing and publication: Desktop and standalone CLI update from verified local fixtures, roll back failed candidates, and have non-publishing CI release evidence on every supported native platform.

**Architecture:** Extract the signed-manifest parser and target policy into one zero-network utility package consumed by Runtime, Desktop Main, standalone CLI, and release scripts. Desktop Main owns download staging, readiness acknowledgement, and rollback; the Runtime remains the only owner of selected channel and redacted outcomes. The CLI detects package-manager ownership before mutation, while standalone archives update their sibling payload atomically through the bundled Node runtime. Production trust remains absent from the source tree: all release-like tests use local fixture keys and artifacts, and a signing workflow accepts separate approval-gated credentials only after this branch is complete.

**Tech Stack:** TypeScript, Node.js `node:crypto`/`node:fs`, Electron Main, pnpm, Electron Builder, Vitest, Playwright, GitHub Actions native runners, and existing Harness Runtime settings/control APIs.

**Spec:** [Harness Desktop Product Architecture Design](../specs/2026-08-15-harness-desktop-design.md)

## Global Constraints

- Do not sign, notarize, upload, publish, create a GitHub Release, install user software outside isolated test roots, or push the branch. Those actions retain separate explicit user approvals.
- Production trust has no allowed update origin or public key in source. Every product consumer returns `unconfigured-update-source` before network, archive, process, or install mutation; the library-level empty trust result remains `unconfigured-trust-root`.
- Test keys are generated in-memory or stored only in isolated test roots. No command line, log, test report, snapshot, Git file, diagnostic, or user-facing result contains a private key, bearer token, manifest URL, raw manifest, staging path, or unredacted error.
- The Runtime owns selected channel and redacted outcome persistence. Desktop and CLI may own only transient staged artifact bytes and their exact install transaction; they do not create a second settings store.
- Desktop publishes Windows x64 NSIS, macOS universal DMG plus ZIP for Intel/Apple Silicon, and Linux x64 AppImage/Deb. The macOS ZIP is the self-update transfer; DMG remains the user-facing distribution artifact. CLI standalone accepts matching ZIP and tar archives. Windows ARM64, Linux ARM64, RPM, Flatpak, and distribution-specific installers remain outside the first stable matrix.
- A candidate is never committed until its matching launch health check succeeds: Desktop requires the existing exact `desktop-dashboard-ready` acknowledgement after authenticated Dashboard boot; standalone CLI requires the bundled runtime to execute `harness --help` successfully.
- A failed candidate restores the retained version, records only a redacted Runtime outcome, and leaves `HARNESS_HOME` unchanged. Downgrade is forbidden except an explicit retained compatible stable rollback.
- Every package and prose change follows root/package/docs instructions, adds paired Chinese documents where required, and excludes `vendor/`, `.superpowers/`, `dist/`, and archived Agent Notes from edits.

---

### Task 1: Extract one shared signed-update policy package

**Files:**

- Create: `packages/util/update-policy/package.json`
- Create: `packages/util/update-policy/tsconfig.json`
- Create: `packages/util/update-policy/src/index.ts`
- Create: `packages/util/update-policy/src/invariant.ts`
- Create: `packages/util/update-policy/tests/update-policy.spec.ts`
- Create: `packages/util/update-policy/README.md`
- Create: `packages/util/update-policy/README.zh.md`
- Create: `packages/util/update-policy/README.i18n.yaml`
- Modify: `apps/desktop/src/main/update/manifest.ts`
- Modify: `apps/desktop/tests/update-manifest.spec.ts`
- Modify: `packages/host/local-runtime/src/update-preferences.ts`
- Modify: `packages/host/local-runtime/src/runtime-client.ts`
- Modify: `packages/host/local-runtime/src/index.ts`
- Modify: `packages/util/README.md`
- Modify: `packages/util/README.zh.md`
- Modify: `packages/util/README.i18n.yaml`
- Modify: `tsconfig.host.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `UpdateChannel`, `SignedUpdateManifest`, `UpdateManifestPolicy`, `RedactedUpdateArtifact`, `verifySignedUpdateManifest(input, policy)`, `canonicalizeSignedUpdateManifest(payload)`, and `EMPTY_UPDATE_TRUST` from `@harness-desktop/dsh-update-policy`.
- Keeps Runtime public `DesktopUpdateChannel` and outcome types as re-exports of the shared channel type; preserves existing Runtime control operation strings and response fields.
- Keeps Desktop Main's `manifest.ts` only as a compatibility re-export, or deletes it after all Desktop imports name `@harness-desktop/dsh-update-policy` directly; no second parser remains.

- [ ] **Step 1: Write the failing shared-package and consumer tests**

Move the existing Ed25519, canonical ordering, origin, digest, archive-member, native-artifact, accessor, and redaction cases into `packages/util/update-policy/tests/update-policy.spec.ts`. Add one Runtime preference test that accepts the shared channel type and one Desktop test importing the bare package entry. Assert a malformed manifest follows one exact implementation rather than a copied Desktop parser.

```text
import { verifySignedUpdateManifest } from '@harness-desktop/dsh-update-policy'

expect(verifySignedUpdateManifest(signedFixture, policy)).toEqual({
  kind: 'accepted',
  artifact: expect.objectContaining({ channel: 'stable', sha256: 'a'.repeat(64) }),
})
```

- [ ] **Step 2: Run the tests and confirm the shared entry is absent**

Run:

```powershell
pnpm exec vitest run packages/util/update-policy/tests/update-policy.spec.ts apps/desktop/tests/update-manifest.spec.ts packages/host/local-runtime/tests/update-preferences.spec.ts
pnpm exec tsc -b packages/util/update-policy/tsconfig.json
```

Expected: FAIL because the utility package and its public entry do not exist.

- [ ] **Step 3: Implement the package and migrate all current consumers**

Move the parser without changing its accepted/rejected values. Declare the package as `@harness-desktop/dsh-update-policy`, with Cordis peer/dev dependencies, an empty invariant justification, a paired README, and a host aggregate reference. Replace Runtime-local channel literals with the shared type and preserve the existing exact `stable`, `beta`, and `nightly` behavior. Replace Desktop local imports with the package entry. Update the util group map and regenerate only generated references affected by the new package.

- [ ] **Step 4: Verify the shared policy in source and built faces**

Run:

```powershell
pnpm exec vitest run packages/util/update-policy/tests/update-policy.spec.ts packages/host/local-runtime/tests/update-preferences.spec.ts apps/desktop/tests/update-manifest.spec.ts
pnpm run build
pnpm run verify-package-invariants
pnpm run verify:desktop-runtime-closure
pnpm exec tsx scripts/run-oxlint.ts packages/util/update-policy/src/index.ts packages/util/update-policy/tests/update-policy.spec.ts
```

Expected: one implementation owns every signed-manifest decision, Runtime control remains compatible, and the built Desktop/CLI dependency graph stays closed.

- [ ] **Step 5: Commit the shared policy extraction**

Run:

```powershell
git add packages/util/update-policy apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts packages/host/local-runtime/src/update-preferences.ts packages/host/local-runtime/src/runtime-client.ts packages/host/local-runtime/src/index.ts packages/util/README.md packages/util/README.zh.md packages/util/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git diff --cached --check
git commit -m "refactor(update): share signed manifest policy"
```

### Task 2: Stage, health-check, and roll back Desktop updates

**Files:**

- Create: `apps/desktop/src/main/update/staged-install.ts`
- Create: `apps/desktop/src/main/update/service.ts`
- Create: `apps/desktop/tests/update-service.spec.ts`
- Create: `apps/desktop/tests/support/update-fixture.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tests/desktop-dashboard.e2e.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**

- Produces `DesktopUpdateService.checkAndStage(): Promise<DesktopUpdateResult>` and `applyStagedUpdate(): Promise<DesktopUpdateResult>`.
- Produces `DesktopUpdateResult` kinds `up-to-date`, `staged`, `applied`, `rolled-back`, and `failed`, each carrying only a stable redacted code and optional version/channel.
- Produces `StageAdapter.download`, `inspect`, `stage`, `launchCandidate`, `restoreRetained`, and `cleanup` seams. The production adapter has no configured source; test adapters use temporary directories and child processes only.

- [ ] **Step 1: Write failing transaction tests**

Create a local signed manifest, fixture downloader, archive inspector, and isolated install root. Require an empty trust policy to avoid every loader/downloader call; require a valid candidate to download into a fresh staging root, check byte SHA-256 and actual archive members, retain the current installation, and return `staged`. Require `applyStagedUpdate()` to accept a candidate only after the existing exact Desktop acknowledgement; a missing, malformed, or failure acknowledgement restores the retained root, records `rolled-back`, and preserves a `HARNESS_HOME` sentinel.

```text
expect(await service.checkAndStage()).toEqual({ kind: 'staged', code: 'candidate-staged', version: '1.1.0', channel: 'stable' })
expect(await service.applyStagedUpdate()).toEqual({ kind: 'rolled-back', code: 'desktop-health-check-failed', version: '1.1.0', channel: 'stable' })
expect(await readFile(harnessSentinel, 'utf8')).toBe('keep')
```

- [ ] **Step 2: Run the transaction tests and confirm the service is absent**

Run: `pnpm exec vitest run apps/desktop/tests/update-service.spec.ts`

Expected: FAIL because neither the staged installer nor service module exists.

- [ ] **Step 3: Implement transactional Desktop staging and Main integration**

Use a unique temporary staging directory owned by the adapter, verify downloaded bytes and actual members before any switch, atomically retain the current installation, and make exactly one candidate launch attempt. Reuse `DesktopReadiness` for the post-authenticated-Dashboard health acknowledgement; do not add IPC. On any failure, restore the retained installation before recording a Runtime `failed` or `rolled-back` outcome. Main creates the service with `EMPTY_UPDATE_TRUST`; it therefore performs no fetch or mutation until a separate signed release configuration supplies trust.

- [ ] **Step 4: Run Main, package, and rollback evidence**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/update-service.spec.ts apps/desktop/tests/update-manifest.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test
pnpm run build
pnpm --filter @harness-desktop/dsh-desktop run package:dir
pnpm --filter @harness-desktop/dsh-desktop run test:e2e:unpacked
```

Expected: source and unpacked Desktop paths have no configured update source by default; test-only candidates stage, health-check, apply, and roll back without deleting Runtime data.

- [ ] **Step 5: Commit Desktop update transaction support**

Run:

```powershell
git add apps/desktop/src/main/update apps/desktop/src/main/index.ts apps/desktop/tests/update-service.spec.ts apps/desktop/tests/support/update-fixture.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/package.json
git diff --cached --check
git commit -m "feat(desktop): stage verified updates with rollback"
```

### Task 3: Add package-manager-aware and standalone CLI updates

**Files:**

- Create: `apps/cli/src/update.ts`
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/src/main.ts`
- Create: `apps/cli/tests/update.spec.ts`
- Create: `apps/cli/tests/update.e2e.ts`
- Modify: `apps/cli/tests/terminal-client.spec.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**

- Adds `UpdateInvocation` and the public syntax `harness update` / `dsh update` with no implicit task or Web lease.
- Produces `runUpdateInvocation(options): Promise<UpdateInvocationResult>` with `managed-by-npm`, `up-to-date`, `staged`, `applied`, `rolled-back`, and `failed` results.
- npm-installed copies print exactly `npm update -g @harness-desktop/cli` and perform no package-manager, archive, or filesystem mutation. Standalone copies consume the shared signed policy, swap a sibling staged archive atomically, run bundled `harness --help`, and restore the retained archive on failure.

- [ ] **Step 1: Write failing command and archive tests**

Add parser tests for `update` and rejection of extra arguments. Create an npm-prefix fixture that records filesystem and process calls; require stdout to contain the managed command and require no mutation. Create an extracted standalone fixture with a local signed manifest/archive; require SHA-256/member validation, a sibling retained copy, bundled-node health check, atomic switch, and rollback when the candidate launcher fails. Require no `npm`, registry, or network process call after the fixture supplies bytes.

- [ ] **Step 2: Run the tests and confirm the command is absent**

Run:

```powershell
pnpm exec vitest run apps/cli/tests/update.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts
```

Expected: FAIL because `update` is not in the parser or dispatcher.

- [ ] **Step 3: Implement install-form detection and standalone transaction**

Detect package-manager ownership from the resolved installed package layout, never from a mutable environment hint. Route that form directly to the stable command result. For a standalone archive, resolve only sibling bundled paths, reuse `@harness-desktop/dsh-update-policy`, stage and verify without `PATH` Node, atomically rename the payload, launch the bundled runtime for health, and restore the retained payload on any failure. Keep all raw manifest and path data internal.

- [ ] **Step 4: Verify CLI source, packed, and standalone paths**

Run:

```powershell
pnpm exec vitest run apps/cli/tests/update.spec.ts apps/cli/tests/terminal-client.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts apps/cli/tests/standalone-archive.e2e.ts
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
```

Expected: npm copies never mutate; standalone candidate health succeeds only through bundled Node; failed launch restores the previous archive and leaves `HARNESS_HOME` intact.

- [ ] **Step 5: Commit CLI update behavior**

Run:

```powershell
git add apps/cli/src/update.ts apps/cli/src/args.ts apps/cli/src/main.ts apps/cli/tests/update.spec.ts apps/cli/tests/update.e2e.ts apps/cli/tests/terminal-client.spec.ts apps/cli/package.json
git diff --cached --check
git commit -m "feat(cli): update standalone archives safely"
```

### Task 4: Produce and verify non-publishing release manifests and native smoke gates

**Files:**

- Create: `scripts/release/build-update-manifest.ts`
- Create: `scripts/release/build-update-manifest.spec.ts`
- Create: `scripts/release/verify-update-manifests.ts`
- Create: `scripts/release/verify-update-manifests.spec.ts`
- Modify: `package.json`
- Modify: `scripts/run-gates.ts`
- Create: `.github/workflows/desktop-artifacts.yml`
- Create: `.github/workflows/release-candidates.yml`
- Modify: `scripts/desktop-release-config.spec.ts`

**Interfaces:**

- Produces deterministic channel manifests from already-built artifact paths and caller-supplied signing material; a missing signing input exits nonzero without output.
- Produces `release:verify-update-manifests`, `desktop:test-updater`, and `release:test-cli-update` commands that use local fixture keys/artifacts and never publish.
- Produces a PR native matrix that packages with `--publish never`, verifies artifacts, runs packed/standalone/update/rollback tests, and uploads only artifacts and redacted logs.
- Produces a manually dispatched release-candidate workflow whose `sign-windows`, `notarize-macos`, `sign-update-manifests`, `publish-npm`, and `create-github-release` inputs each default false and reject missing or combined approvals.

- [ ] **Step 1: Write failing release script and workflow assertions**

Create Ed25519 fixture keys in temporary directories. Require deterministic canonical stable/beta/nightly manifests, reject duplicate target artifacts, bad signatures, incompatible rollback, unsafe archive members, and missing signing input. Extend workflow assertions to require all non-publishing native checks and to reject credential variables, publishing commands, unapproved signing, and update upload on pull requests.

- [ ] **Step 2: Run the release tests and observe missing commands/workflows**

Run:

```powershell
pnpm exec vitest run scripts/release/build-update-manifest.spec.ts scripts/release/verify-update-manifests.spec.ts scripts/desktop-release-config.spec.ts
```

Expected: FAIL because manifest producer/verifier scripts and dedicated native workflow do not exist.

- [ ] **Step 3: Implement deterministic artifacts, manifests, and CI ownership**

Build manifests only from named local artifacts and supplied key bytes; reject external download. Make Windows own NSIS/ZIP smoke, macOS own universal-DMG-plus-ZIP/tar smoke with `lipo`, and Linux own AppImage/Deb/tar smoke. Require updater rollback checks after packaging. Native Desktop inspection for opaque NSIS, ZIP, and AppImage installers is digest- and installer-launch based; archive member inspection remains the release verifier's responsibility. Keep signing/notarization/publication jobs manually dispatched and separately approval-gated; no pull-request or ordinary smoke job has release credentials.

- [ ] **Step 4: Verify scripts and current-platform native release evidence**

Run:

```powershell
pnpm exec vitest run scripts/release/build-update-manifest.spec.ts scripts/release/verify-update-manifests.spec.ts scripts/desktop-release-config.spec.ts
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:verify-update-manifests
```

Expected: local fixture manifests and current-platform artifacts verify without signing, upload, publication, or cross-platform simulation claims; other native evidence is owned by the new CI matrix.

- [ ] **Step 5: Commit release gate and workflow readiness**

Run:

```powershell
git add scripts/release package.json scripts/run-gates.ts .github/workflows/desktop-artifacts.yml .github/workflows/release-candidates.yml scripts/desktop-release-config.spec.ts
git diff --cached --check
git commit -m "test(release): gate verified update rollback"
```

### Task 5: Complete documentation, review, and signing-ready handoff

**Files:**

- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `apps/cli/README.md`
- Modify: `apps/cli/README.zh.md`
- Modify: `apps/cli/README.i18n.yaml`
- Modify: `apps/desktop/package.json`
- Create: `.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.i18n.yaml`

**Interfaces:**

- Documents the exact update commands, supported install forms, rollback behavior, production trust requirement, platform evidence boundary, and separate approval actions. It never publishes instructions containing a key, token, or release URL.

- [ ] **Step 1: Write source-backed bilingual user and maintainer documentation**

Document `harness update` for npm and standalone forms, the Desktop fail-closed behavior before trust configuration, recovery/rollback outcome codes, the supported platform matrix, and the signing-ready but unexecuted external actions. Add an implemented Agent Note recording shared policy ownership, Runtime outcome persistence, Main/CLI mutation ownership, and explicit approval boundaries.

- [ ] **Step 2: Run full local release-readiness verification**

Run:

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run verify:desktop-runtime-closure
pnpm --filter @harness-desktop/dsh-desktop run test
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts apps/cli/tests/standalone-archive.e2e.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts
git diff --check
```

Expected: every task-owned check passes. If a repository-wide baseline failure remains outside this plan, record its exact command, files, and whether the changed scope passes; do not hide it with a global exception.

- [ ] **Step 3: Obtain final whole-branch review and prepare approval handoff**

Run the final subagent-driven whole-branch review against the recorded merge base. Address every Critical/Important finding through the review loop. Report the exact local and CI checks that remain platform-owned, the required signing/notarization/publishing approvals, and the branch commit range; do not push or release.

- [ ] **Step 4: Commit final signing-ready documentation and evidence**

Run:

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/desktop/package.json .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.md .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.zh.md .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.i18n.yaml
git diff --cached --check
git commit -m "docs(release): prepare stable signing handoff"
```

## Plan Self-Review

- Tasks are ordered by dependency: shared policy, Desktop transaction, CLI transaction, release manifest/CI, then final documentation and evidence.
- Desktop and CLI share one signed-manifest implementation; Runtime retains only channel and redacted outcomes; no task creates a second data root or stores production trust in source.
- The plan separates code-ready release work from external signing/notarization/publication approval, so a passing local branch never implies an external release occurred.
