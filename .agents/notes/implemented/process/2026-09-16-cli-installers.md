# Agent Note: Native CLI installers

Status: implemented

English | [中文](2026-09-16-cli-installers.zh.md)

## Problem

Standalone CLI archives require manual extraction and do not provide package-manager metadata or an uninstall path on Windows and Debian.

## Decision

The release pipeline builds `dsh-<version>-win-x64-setup.exe` with Inno Setup 6.7.0 from the validated Windows x64 CLI executable and builds `dsh_<version>_amd64.deb` or `dsh_<version>_arm64.deb` with `dpkg-deb` from the matching validated Linux CLI executable. The Windows installer has a per-user application under `%LOCALAPPDATA%\DeepSeek Harness` and an uninstaller. Each Debian package installs `/usr/bin/dsh` with matching control metadata and is removable through `apt`. Each package receives a SHA-256 sidecar.

Packaging runs only after the existing CLI artifact build and validation. A release-scoped job checks every archive and package checksum and requires both installer formats before creating or updating a GitHub Release, preventing partial publication. Builders have read-only repository permissions; only the final asset job has contents write permission.

## Alternatives considered

**Chocolatey or winget manifests.** Not used because they add external repository ownership and package publication contracts beyond the release assets.

**Cross-platform packaging from one runner.** Not used because the input CLI executables and native `node-pty` payloads are produced on matching native runners.

**Publishing packages independently.** Not used because a release must expose a complete validated asset set rather than a partial installer selection.

## Consequences

Windows x64 and Debian x64/arm64 users receive install and uninstall workflows while other supported targets retain archive downloads. Installer builds depend on fixed official tooling and remain reproducible source definitions; generated binaries stay in CI artifacts and are not committed.
