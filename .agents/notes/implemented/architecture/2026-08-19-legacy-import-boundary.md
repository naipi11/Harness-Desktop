# Agent Note: Legacy import boundary without credential values

Status: implemented

English | [中文](2026-08-19-legacy-import-boundary.zh.md)

## Problem

A legacy `$DSH_HOME` may hold sessions, settings, project metadata, and a `.credentials.yaml` document full of secrets. The single-home Runtime must adopt the supported non-secret data without ever writing to, deleting, or merging with the legacy root, and without letting a legacy secret silently become the Runtime's credential source.

A migration boundary also needs a user decision. The Runtime stores state and executes an accepted import, but a client must never choose for the user; collisions and failures must be recoverable with an actionable typed result.

## Decision

`@harness-desktop/dsh-host-local-runtime/legacy-import` owns the boundary. `importLegacyDshHome()` copies only the known non-secret roots (`sessions`, `settings.yaml`, `projects`) into an empty `HARNESS_HOME` target through a staging sibling, then moves each root into the target with one atomic rename. The source and the target are never deleted. A non-empty target returns `{ kind: 'target-not-empty' }`; any filesystem failure, including setup, attempts to remove the staging directory when present, returns `{ kind: 'failed', retained, diagnosticId }`, and preserves the source plus fully moved target roots for a retry that resumes from `retained`.

The Runtime atomically stores `not-needed`/`decision-required`/`declined`/`imported`/`target-not-empty`/`failed` state in `$HARNESS_HOME/legacy-migration.json` with owner-only modes. The stored state never contains the legacy source path or any secret. `detectLegacyImport()` exposes `decision-required` on first start; `recordLegacyImportDecision()` persists a decline, executes an accepted import, maps the typed result into retryable state, and returns an existing `imported` state unchanged. `.credentials.yaml` and `.env` are never copy candidates.

The Runtime base composition mounts `@harness-desktop/dsh-credentials-platform` and does not mount `@harness-desktop/dsh-credentials-local`, so a legacy `.credentials.yaml` is never read into the Runtime. The platform provider loads and validates opaque references from `$HARNESS_HOME/.credential-references.json` at boot and resolves values per request from a platform/environment adapter; the default adapter is the launcher's frozen read-only process environment. Each mutation atomically persists candidate metadata before changing the adapter and restores the previous metadata if the adapter rejects. The file-backed package stays intact with unchanged public behavior for embedders that deliberately choose it.

## Alternatives considered

**Copy `.credentials.yaml` into the target and keep reading it.** A credentials document is exactly the secret-bearing material this boundary must exclude; copying it would move secrets into a file the Runtime owns and could later read or log. Keeping the local provider mounted would make the legacy document a live Runtime credential source.

**Write legacy data directly into the target root by root.** A partial copy would leave the target indistinguishable from a completed one and offer no resume point. Staging plus atomic per-root moves gives readers a never-partial root and gives retry an explicit `retained` list.

**Ask the user inside the importer.** The Runtime stores decisions and executes imports, but the CLI owns its terminal prompt and the Dashboard and Desktop own their migration UI. Keeping the decision outside keeps one boundary for every client.

## Consequences

- One import either reports a typed failure that preserves both roots or completes with a `copied` list; a user can fix the collision and retry through the Runtime.
- Legacy secrets cannot reach the target home, the Runtime credential seam, logs, diagnostics, or state files: `.credentials.yaml` and `.env` are not candidates, and the platform provider never writes values into its metadata document.
- The base composition's credential row is now the platform provider; `dsh-credentials-local` remains shipped and tested but is no longer mounted by default.
- Import state is Runtime-owned: clients read typed states and never parse migration text or perform the copy themselves.
