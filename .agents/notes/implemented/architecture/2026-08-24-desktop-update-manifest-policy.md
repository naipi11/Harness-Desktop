# Agent Note: Desktop update manifest policy

Status: implemented

English | [中文](2026-08-24-desktop-update-manifest-policy.zh.md)

## Problem

Desktop update metadata is untrusted input. A malformed, substituted, cross-channel, cross-platform, or path-bearing manifest can otherwise cause the Main process to select an artifact that does not belong to the installed Harness Desktop application.

## Decision

`apps/desktop/src/main/update/manifest.ts` owns exact manifest parsing, canonical signature bytes, Ed25519 public-key verification, version comparison, target selection, HTTPS-origin admission, digest syntax, and archive-member path admission. It returns either one redacted selected artifact or one fixed rejection code; it never returns a URL, key id, signature, manifest body, or raw crypto error.

The shipped `PRODUCTION_DESKTOP_UPDATE_TRUST` has no origins and no public keys, so every production check rejects as `unconfigured-trust-root` until a separately reviewed release configuration supplies both. Unit tests generate ephemeral Ed25519 keys in memory; those keys are not release trust material.

An Apple-Silicon or Intel macOS process may select one `darwin` `universal` DMG. Any request with more than one compatible artifact rejects instead of picking by incidental manifest order.

The verifier does not fetch, hash downloaded bytes, inspect an actual archive, stage an installer, alter a running application, request a restart, or roll back. A later Main-process staging owner must re-check the downloaded digest and actual archive members before it can use this selected declaration.

## Alternatives considered

**Fail open until a public key is configured.** Rejected because absence of a trust root would turn any reachable metadata source into an update authority.

**Use an Electron-updater default feed.** Rejected because the product needs explicit application, channel, target, origin, archive, and redaction rules instead of a transport-specific implicit policy.

**Verify in the renderer or Dashboard.** Rejected because browser code must not hold trust keys or receive raw manifest data, and it does not own native artifact lifecycle.

## Consequences

The future updater has a deterministic, testable admission point before network or installer mutation. Release engineering must explicitly add immutable allowed origins and public keys through a reviewed configuration change; neither a build nor a local test supplies them.

Manifest signing sorts artifacts and member paths before signing, so valid signatures do not depend on producer list order. Duplicate compatible targets and unsafe members reject rather than relying on an extractor's behavior.

The manifest tests exercise ephemeral-key verification, signature tampering, product/channel/version/target mismatches, URL and digest rejection, archive-path rejection, and universal macOS selection.
