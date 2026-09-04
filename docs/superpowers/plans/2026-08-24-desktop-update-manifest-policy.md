# Desktop Update Manifest Policy Implementation Plan

English | [中文](2026-08-24-desktop-update-manifest-policy.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Desktop Main-process verifier that accepts only a locally supplied, signed, target-matching update manifest and fails closed when production update trust is unconfigured.

**Architecture:** `apps/desktop/src/main/update/manifest.ts` owns an exact JSON parser, canonical signed payload, Ed25519 verification, semantic-version comparison, target selection, HTTPS origin allowlist, SHA-256 syntax, and archive-member path checks. It returns a closed redacted result; it performs no fetch, extraction, staging, installation, restart, or rollback. The compiled production trust policy intentionally has no origins or public keys, while tests inject an ephemeral Ed25519 key pair.

**Tech Stack:** TypeScript, Node.js `node:crypto`, Electron Main-process code, Vitest, and `@harness-desktop/dsh-app-boot` product metadata.

**Spec:** [Harness Desktop Product Architecture Design](../specs/2026-08-15-harness-desktop-design.md)

## Global Constraints

- The verifier runs only in Desktop Main-process code; the renderer receives no trust key, manifest body, artifact URL, staging path, or raw verification error.
- Production trust is fail-closed: an empty origin or public-key configuration returns `unconfigured-trust-root` before an artifact is accepted.
- A test may generate an ephemeral Ed25519 key pair and sign an in-memory payload. It never reads a production key, downloads an artifact, contacts a release service, uploads data, installs software, restarts Electron, or modifies `HARNESS_HOME`.
- Only `stable`, `beta`, and `nightly`; the frozen product `appId`; one strictly newer semantic version; and the current `win32`/`darwin`/`linux` plus `x64`/`arm64` target are accepted. A `darwin` `universal` DMG is compatible with either macOS runtime architecture; any request with more than one compatible artifact rejects.
- Each selected artifact must have an HTTPS URL at an allowlisted exact origin, a lowercase 64-hex SHA-256, one supported artifact format, and non-empty archive members made of safe forward-slash relative paths. Absolute paths, drive paths, backslashes, colons, control characters, empty components, `.` and `..` are rejected.
- Unknown manifest, signature, artifact, or policy fields reject the manifest. Validation does not preserve unrecognized input for later diagnostics.
- The output contains only a stable result code and, on acceptance, the selected artifact's redacted version/channel/target/digest/member list. It never echoes a URL, signature, key id, manifest body, or error text.
- Maintain English/Chinese plan and Agent Note pairs. Do not touch `vendor/`, `.superpowers/`, `dist/`, signing identities, release credentials, or release workflows.

---

### Task 1: Specify redacted manifest parsing with failing tests

**Files:**

- Create: `apps/desktop/tests/update-manifest.spec.ts`

**Interfaces:**

- Specifies `verifyDesktopUpdateManifest(input, policy): DesktopUpdateManifestVerification`.
- Specifies `canonicalizeDesktopUpdateManifest(manifest): Buffer` for signing an exact, signature-free payload.

- [x] **Step 1: Write the failing acceptance and rejection tests**

Create a test helper that generates an Ed25519 key pair, builds a manifest for `productMetadata.appId`, signs `canonicalizeDesktopUpdateManifest(...)`, and supplies the public key plus `https://updates.example.test` as a test-only policy. Assert an accepted newer artifact returns its version, channel, platform, architecture, SHA-256, format, and safe member list without its URL, signature, or key id.

```text
const result = verifyDesktopUpdateManifest(signedManifest('stable', '1.1.0'), policy({ channel: 'stable' }))
expect(result).toEqual({
  kind: 'accepted',
  artifact: {
    version: '1.1.0', channel: 'stable', platform: process.platform,
    arch: process.arch, format: expectedFormat, sha256: 'a'.repeat(64),
    members: ['Harness Desktop.app/Contents/MacOS/harness-desktop'],
  },
})
```

Add literal rejection cases for an empty production trust policy, changed signature, unknown key id, non-HTTPS URL, wrong origin, wrong app id, wrong channel, equal/downgrade version, missing/currently unsupported target, duplicate target artifact, non-hex digest, traversal member, drive member, backslash member, unknown field, and a signature that no longer matches after any payload field changes. Add one case each proving a valid `stable`, `beta`, and `nightly` manifest is accepted only by its own selected channel.

- [x] **Step 2: Run the test and confirm the verifier is absent**

Run: `pnpm exec vitest run apps/desktop/tests/update-manifest.spec.ts`

Expected: FAIL because `apps/desktop/src/main/update/manifest.ts` and its verifier exports do not exist.

### Task 2: Implement the pure, fail-closed Desktop manifest verifier

**Files:**

- Create: `apps/desktop/src/main/update/manifest.ts`
- Modify: `apps/desktop/tests/update-manifest.spec.ts`

**Interfaces:**

- Produces `DesktopUpdateArtifactFormat = 'nsis' | 'dmg' | 'appimage' | 'deb'`, `DesktopUpdateArchitecture = 'x64' | 'arm64' | 'universal'`, and `DesktopUpdateManifestPolicy` with `appId`, `currentVersion`, `channel`, `platform`, `arch`, `allowedOrigins`, and PEM public keys indexed by key id.
- Produces `DesktopUpdateManifestVerification = { kind: 'accepted'; artifact: RedactedDesktopUpdateArtifact } | { kind: 'rejected'; code: DesktopUpdateManifestRejectionCode }`.
- Produces `PRODUCTION_DESKTOP_UPDATE_TRUST` with no public keys and no origins.

- [x] **Step 1: Implement exact record parsing and canonical signing bytes**

Parse only plain objects, require every known key exactly once, and construct detached typed records rather than preserving input. Canonicalize the signature payload by serializing an object with the fixed top-level key order `schemaVersion`, `applicationId`, `channel`, `version`, and `artifacts`; sort artifacts by `platform`, `arch`, and `format`; sort each member list lexicographically; omit `signature`. Reject duplicate targets and duplicate members before signature verification.

```text
const payload = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  applicationId: manifest.applicationId,
  channel: manifest.channel,
  version: manifest.version,
  artifacts: orderedArtifacts,
}), 'utf8')
```

- [x] **Step 2: Implement fail-closed policy and signature checks**

Before parsing an accepted result, reject an empty `allowedOrigins` or public-key map as `unconfigured-trust-root`. Require `signature.algorithm === 'ed25519'`, a known PEM key id, a base64url signature of bounded size, and `crypto.verify(null, canonicalPayload, key, signature)`. Catch malformed PEM or crypto input and return `signature-invalid`, never a reflected error. Do not expose the key id or signature in any result.

- [x] **Step 3: Implement target and artifact checks**

Reject app/channel/version/target mismatches with distinct stable codes. Select exactly one artifact matching `policy.platform` and `policy.arch`; a `darwin` `universal` DMG matches both `x64` and `arm64`. Reject no match or multiple matches. Require `https:` plus an origin in `policy.allowedOrigins`, a lower-case 64-hex digest, and every declared member path to meet the global safe-path rule. Return only the selected redacted artifact on success.

- [x] **Step 4: Run source tests, Desktop typecheck, and focused lint**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/update-manifest.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
pnpm exec tsx scripts/run-oxlint.ts apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts
```

Expected: every valid test key verifies only its own unmodified canonical payload; every invalid input returns a redacted rejection without a URL, key id, signature, path, or raw crypto error.

- [x] **Step 5: Commit the manifest policy implementation**

Run:

```powershell
git add apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts
git diff --cached --check
git commit -m "feat(desktop): verify signed update manifests"
```

### Task 3: Record the trust boundary and pair the documentation

**Files:**

- Create: `.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.i18n.yaml`
- Modify: `docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md`
- Modify: `docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.zh.md`
- Modify: `docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.i18n.yaml`

**Interfaces:**

- Records that the Desktop Main verifier owns only trust and selection policy, while a later staged-install owner performs download, extraction, health acknowledgement, atomic switch, and rollback.

- [x] **Step 1: Write the paired Agent Note**

Create an implemented architecture Agent Note with `Problem`, `Decision`, `Alternatives considered`, and `Consequences`. State that an empty production trust policy rejects updates, that test-only keys are not release keys, and that renderer/browser code never receives trust material or raw manifest data. Compare the rejected fail-open and Electron-updater-default alternatives against the adopted explicit verifier.

- [x] **Step 2: Re-record and verify both named pairs**

Run:

```powershell
pnpm run verify-translation-pairing --write .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md
pnpm run verify-translation-pairing .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md
pnpm run verify-agent-note-format
pnpm run verify-md-wrap
pnpm run verify-md-links
git diff --check
```

Expected: the trust decision has both language counterparts, and no prose claims that a production updater or key has been configured.

- [x] **Step 3: Commit the documentation with the manifest policy**

Run:

```powershell
git add .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.zh.md .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.i18n.yaml docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.zh.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.i18n.yaml
git diff --cached --check
git commit -m "docs(desktop): record update manifest trust policy"
```

## Plan Self-Review

- The plan covers signature, channel, identity, version, target, digest, origin, and archive-path acceptance before any artifact mutation is introduced.
- Production trust remains intentionally empty; tests carry only ephemeral local keys.
- Every later update action depends on this verifier but does not change its closed output format.
