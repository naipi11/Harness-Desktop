# Agent Note: Layered release artifact closure

Status: implemented

English | [中文](2026-08-23-release-artifact-closure.zh.md)

## Problem

Source tests and an unpacked Electron process do not prove that a native installer is complete, that removal preserves user state, or that an npm tarball and standalone archive run without a developer checkout. These failures occur after ordinary build verification: an installer can omit its icon, npm can resolve workspace imports through hoisting, and an archive can invoke the host Node executable or carry a native module for another target.

A pull-request check also must not acquire release authority merely because it produces release-shaped files. Artifact inspection, installed execution, signing, upload, and publication are different operations with different credentials and platform requirements.

## Decision

Desktop release evidence stays layered. Static inspection requires the current runner's exact installer matrix and generated icon resources; installed smoke performs the matching native install or mount operation, launches the real Desktop against the authenticated Dashboard fixture, accepts only the Desktop-owned redacted ready acknowledgement, removes the artifact, and proves a temporary `HARNESS_HOME` sentinel survives. A successful Windows install whose file validation fails runs the generated uninstaller and waits for removal before temporary-root cleanup. Linux launches the AppImage itself and uses its extracted `AppRun` only for a FUSE-specific failure; Deb acceptance uses isolated `dpkg` install and removal. Windows owns NSIS, macOS owns the universal DMG and both architectures, and Linux owns AppImage and Deb; no runner substitutes archive listing or another operating system's simulation for native execution.

The packed CLI keeps `harness` and `dsh` as small external-importing client entries and deploys their complete Runtime graph as physical bundled package dependencies. The payload retains `dsh-host-local-runtime`'s own `lib/bin.js` and `runtime.cordis.yml`, the base/Web/headless patch layers, plugin and worker entries, and target-native dependencies, so package-relative Runtime spawning cannot resolve back to the CLI entry. Acceptance installs the tarball into a new npm prefix with an empty cache, offline mode, and scripts disabled, starts the Runtime through `harness web --background --no-open`, attaches through `dsh web --status`, releases the lease, and runs both prefix-owned help commands. Source, tests, credentials, Desktop artifacts, and stale hashed chunks are outside the payload.

Standalone CLI archives consume that closed tarball payload plus a local Node distribution selected by an exact version, platform, architecture, filename, and SHA-256 allowlist. The producer never downloads. ZIP and tar.gz outputs use stable ordering, timestamps, ownership, modes, a sorted per-file digest map, a sorted executable-path manifest, and matching checksum sidecar; every `.node` member is target-checked and recorded. The executable set preserves deployed executable bits and includes declared package bins, target ripgrep, macOS node-pty `spawn-helper`, launchers, and bundled Node. Production and verification inspect large trees through bounded worker pools. Tar verification rejects a recorded executable without mode `0755`; ZIP verification restores `0755` from the checksummed manifest before execution. Verification loads recorded native modules with the bundled Node executable, records `process.execPath` inside that runtime, runs both help entries from an empty directory, starts the Runtime through `harness`, attaches through `dsh`, and releases its lease without a package manager, registry, network, or system Node path.

Pull-request and ordinary smoke workflows retain `--publish never` and read-only repository permission. Runtime acquisition is an explicit workflow input before the offline producer. CI retention names only the inspected NSIS setup executable, universal DMG, AppImage, Deb, standalone ZIP/tar.gz, and checksum sidecar globs; builder metadata, blockmaps, unpacked trees, and test results remain outside the workflow artifact. This bounded retention is not release distribution. Signing, notarization, update-manifest upload, npm publication, and GitHub Release creation remain absent and require separately authorized release work.

## Alternatives considered

**Treat an unpacked Electron launch as package acceptance.** This does not execute installer metadata, native removal, mounted-image behavior, or installed icon resources, so it leaves the highest-risk packaging operations untested.

**Accept archive listings as installed success.** Listings are useful static evidence but cannot prove that the installed executable authenticates the Dashboard, emits the owned ready acknowledgement, or preserves `HARNESS_HOME` through removal.

**Let npm or the standalone verifier use online resolution and the system Node executable.** That can pass only because a runner has a warm cache, registry access, workspace hoisting, or Node on `PATH`; the shipped bytes remain unproven.

**Download Node inside the standalone producer.** Combining acquisition with verification makes an unreviewed network response part of the produced archive. A separate acquisition step plus the committed allowlist keeps the producer offline and fail-closed.

**Cross-simulate native installers on one runner.** Tool output from a foreign operating system does not prove native install, mount, architecture, launcher, or uninstall behavior. The workflow pays for three native jobs instead.

## Consequences

Release smoke costs more time and platform capacity because source, packed npm, deterministic archive, static installer, and installed artifact checks remain separate. The Node version and distribution checksums are reviewed data that must change deliberately, and each operating system must maintain its own installer fixture.

In return, every accepted artifact has a named evidence tier and a current-runner owner. A pull request can prove complete offline CLI bytes and real native Desktop lifecycle behavior without gaining signing or publication authority, while later release work can consume the same inspected artifacts instead of rebuilding them under credentials.
