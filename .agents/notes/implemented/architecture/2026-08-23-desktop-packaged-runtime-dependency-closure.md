# Agent Note: Desktop packaged Runtime dependency closure

Status: implemented

English | [中文](2026-08-23-desktop-packaged-runtime-dependency-closure.zh.md)

## Problem

Electron Builder copies the external Main imports reachable from the Desktop package's production dependency graph. Workspace peer dependencies remain available through the repository's parent `node_modules` during source and ordinary built tests, but they are absent from an `app.asar` unless the packaged application declares them. The Runtime-hosted Dashboard therefore needs an explicit production dependency closure at the Desktop package boundary.

## Decision

`apps/desktop/package.json` declares the complete workspace peer closure imported by the assembled App-Boot, local Runtime, base, and Web production graph. The repository closure verifier reports the Desktop manifest as a closed graph of 180 workspace packages, and `pnpm-lock.yaml` records the same closure. Electron Builder continues to package only `out/**`, the Desktop manifest, and product icons with `--publish never`; it does not copy a second Runtime, persistence provider, credential store, or Dashboard asset owner.

The Desktop Builder keeps pnpm's target-native payload on Windows because rebuilding the patched `node-pty` dependency mutates the shared linked-worktree store; macOS and Linux retain Builder's rebuild step for target-specific and universal native payloads. The unpacked artifact is copied to an external temporary release root before launch, so repository `node_modules` cannot satisfy a missing package. Each artifact is exercised through the real Electron Dashboard journey rather than accepted from process existence alone.

## Alternatives considered

**Bundle the Runtime into Main.** This would hide missing package boundaries while duplicating dynamic Cordis package loading and would diverge from the shared Runtime ownership model.

**Copy the repository's entire `node_modules` tree.** This would ship development-only packages and workspace residue, weaken the package manifest as the production dependency authority, and increase the release surface.

**Leave peer dependencies implicit.** This works only from a repository checkout whose parent module tree supplies the peers; an installed `app.asar` has no such parent and fails before the Runtime can start.

## Consequences

The Desktop manifest and lockfile are part of the Runtime packaging contract: a newly mounted production plugin with a peer-provided import requires its peer to be declared at the Desktop application boundary. Clean source, built, and unpacked checks cover this contract; the unpacked smoke reaches the authenticated Dashboard, verifies the constant readiness acknowledgement, exact WebSocket CSP, native bridge, handoff exchange, and ordered close.
