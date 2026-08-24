# Agent Note: Stable release update ownership

Status: implemented

English | [中文](2026-08-24-stable-release-update-ownership.zh.md)

## Problem

A signed manifest policy, durable update preference, filesystem transaction, and release workflow have different authority. Combining them could let untrusted release data become durable, let Runtime mutate an installation, or let verification jobs perform signing or publication. Release evidence also needs a precise completion point so a partially written manifest set cannot be consumed.

## Decision

`@harness-desktop/dsh-update-policy` is the only signed-manifest parser and selector. It verifies the exact record, canonical Ed25519 signature, application, channel, consumer, target, version, HTTPS origin, digest syntax, and safe archive members, then returns a redacted artifact without a URL, key, signature, or raw manifest. It performs no candidate I/O, installation mutation, trust configuration, or outcome persistence.

Runtime owns the selected Desktop channel and the last durable redacted outcome in its existing settings provider. The stored channels are `stable`, `beta`, and `nightly`; stored outcome kinds are `up-to-date`, `staged`, `applied`, `rolled-back`, and `failed`. Its fixed codes are `unconfigured-trust-root`, `up-to-date`, `staged`, `applied`, `rolled-back`, `manifest-rejected`, `artifact-rejected`, `health-check-failed`, and `install-failed`. The durable record contains only version, channel, kind, code, and an optional last-known-good version.

Desktop Main owns transient Desktop candidate mutation through `DesktopUpdateService` and a platform `StageAdapter`. A configured transaction maps successful staging, application, and restored health failure to Runtime `staged`/`staged`, `applied`/`applied`, and `rolled-back`/`health-check-failed`; manifest, artifact, and installation failures map to redacted `failed` outcomes. A restore failure returns the Desktop-local `candidate-restore-failed` code and records `failed`/`install-failed`. The shipped Main uses `EMPTY_UPDATE_TRUST` and the inert adapter, so it returns `up-to-date`/`unconfigured-trust-root` before manifest loading, candidate I/O, process launch, or filesystem mutation.

The CLI owns its package-manager guidance and standalone sibling transaction without using Runtime state. An npm layout prints `npm update -g @harness-desktop/cli` without executing it. A standalone layout with empty trust returns `up-to-date`/`unconfigured-trust-root` before candidate I/O. A separately configured transaction verifies the shared policy, bytes, members, and executable paths, then stages, switches, checks the bundled Node and CLI entrypoint, and restores the retained bundle on health failure.

## Release evidence and approvals

`writeUpdateManifests()` prepares every target manifest in memory, reserves the final output root with one exclusive directory creation, writes the set into a private inner stage, and renames that stage to `ready`. Only `ready/<manifest>` paths are complete and consumable. A competing root owner remains untouched, and failure cleanup never recursively removes the reserved root.

The credential-free Desktop artifact workflow packages with `--publish never`. Native CI owns Windows NSIS and CLI ZIP evidence, macOS universal DMG and CLI tar evidence with `lipo` inspection, and Linux AppImage, Deb, and CLI tar evidence. One host's local or cached artifacts do not prove another native row or a fresh independent archive.

Production update trust remains a separate operator prerequisite: the public key, immutable HTTPS origin, and release location require independent audit before a caller can configure either updater. Windows signing, macOS notarization, production update-manifest signing, npm publication, update upload, and GitHub Release creation are separate approval actions. The manual candidate workflow only validates that exactly one future operation was selected; it has no credentials, release permissions, environment, or external-action step.

## Alternatives considered

- **Let Runtime install updates** — rejected because Runtime owns durable shared state, while native installation mutation belongs to Desktop Main or the standalone CLI transaction.
- **Ship a default production key and origin** — rejected because deployment trust and release locations require a separate audit and must remain absent until authorized.
- **Treat the reserved manifest root as ready** — rejected because a writer can fail after reservation; the inner `ready` rename is the complete-set publication point.
- **Combine signing and publication behind workflow booleans** — rejected because dormant external commands and credentials would give evidence collection authority to change release state.

## Consequences

Repository verification can establish signing readiness without configuring live automatic updates or granting external release authority. Operators must provide audited production trust and obtain each external approval separately. Native evidence remains platform-owned, and consumers must reject manifest paths outside `ready/`.
