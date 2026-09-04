# Agent Note: Linux AppImage health handoff

Status: implemented

English | [中文](2026-09-03-linux-appimage-health-handoff.zh.md)

## Problem

A Linux AppImage may start its mounted Electron Main after the detached worker publishes the transaction heartbeat. Requiring the heartbeat timestamp to be later than the candidate's epoch estimate can reject that valid launch and trigger health-check rollback. The source live Runtime entry also needs package-resolved module URLs because ClientModuleRegistry metadata resolution is anchored at the local-runtime package, not at every bundle package. The successful candidate then removes the applied marker during finalization, so an installed-update test that requires that transient marker cannot distinguish a committed candidate from a failed handoff.

The hosted macOS arm64 runner installed only its host architecture's optional native packages before electron-builder created the x64/arm64 pair, so universal packaging saw the same arm64 `sharp` Mach-O in both apps. The manylinux node-pty Makefile retained an absolute runner-temp `node-gyp` include that was outside the container mount. The Windows packaged Runtime verifier also discarded the child diagnostic that would identify a load failure.

The release-workflow helper tests intentionally clear the child environment, so invoking a bare `node` binary is not portable on a hosted runner. The macOS artifact verifier also assumed that every DMG and ZIP uses the literal `Harness Desktop.app` bundle name, although the archive layout is the authoritative source.

## Decision

`apps/desktop/tests/support/runtime-live-entry.mjs` resolves every bare package name in source patch insertions with `import.meta.resolve()` before boot, while preserving `cordis:` and existing `file:` entries. Built Runtime composition keeps its existing patch resolution path. `isCurrentWatchdogHeartbeat()` accepts a Linux heartbeat no earlier than `candidateStartedBeforeMs - healthCheckTimeoutMs` and no later than the observation time; the Windows launch nonce grammar and the default strict helper behavior remain unchanged. The Linux installed-update test accepts either the live applied marker with a live candidate process or a candidate-version installation whose private journal is gone and Runtime reports `applied:applied` or `up-to-date:up-to-date`.

The freshness window is the existing policy health window, not a new deployment tuning field. Transaction-specific private storage and the worker's terminal applied outcome remain required, so a recent heartbeat cannot commit an update without the detached worker's proof. The source resolver is test-runtime infrastructure; it does not add bundle packages to `dsh-host-local-runtime` merely to change a resolution anchor.

Windows PowerShell appends `.CPL` to `PATHEXT` before it executes the supervisor's worker script. `createWindowsWorkerEnvironment()` includes that extension explicitly, so the WMI child receipt matches the constrained environment without expanding the allowed environment-name set.

The workspace declares x64 and arm64 optional dependency resolution for the current operating system. The macOS builder retains identical target-native Mach-O package files while still lipo-merging files that differ by architecture. The manylinux job mounts `RUNNER_TEMP` read-only at the same path used by the generated Makefile. The CLI deploy copies its tracked node-pty patch into the temporary package, rewrites the deployed workspace to use that package-relative patch path, and installs from that package directory. The isolated Deb fixture uses `--force-depends` only inside its owned dpkg root because the root does not contain the runner's system packages; it still requires configured package state, expected files, launch, and unchanged host state.

The workflow helper launches its fixture with `process.execPath`. macOS DMG and ZIP inspection locates exactly one non-symlink `.app` bundle within a bounded depth and applies required-resource checks relative to that bundle. Linux hosted UI smoke runs under a private Xvfb display because the runner has no X server. Electron Builder keeps the `runAsNode` fuse explicit for the packaged worker probe. Windows Runtime verification pipes both output streams and records the exit code, signal, forced-failure state, and ready marker alongside the bounded diagnostic.

## Alternatives considered

**Add a fixed delay before writing the worker heartbeat.** Rejected. AppImage mount and Electron startup time vary by runner, and a fixed delay either preserves the race or wastes the health window.

**Remove the Linux lower timestamp bound.** Rejected. A same-transaction heartbeat remains private and transaction-bound, but an unbounded old record would weaken restart handling. The configured health window limits the accepted age.

**Require the applied marker to survive candidate finalization.** Rejected. Finalization owns marker removal after Runtime records the terminal outcome. The test consumes that durable outcome instead of changing the update lifecycle.

**Add every browser package as a direct local-runtime dependency.** Rejected. That duplicates the bundle dependency graph and leaves source patch resolution dependent on package layout. File URLs make the source loader's package origin explicit.

## Consequences

Linux AppImage candidates can complete the health handoff when the runtime forks or mounts the Main process after the worker's immediate launch return. The installed Linux test proves both candidate replacement and the post-finalization `applied` outcome, while the existing rollback scenario still requires a retained stable artifact when health is never acknowledged. Native Linux evidence still depends on a runner with the required Electron libraries, FUSE, SquashFS tooling, and target-compatible native bindings; WSL results do not provide macOS evidence or manylinux compatibility proof.
