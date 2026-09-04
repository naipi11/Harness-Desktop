# Agent Note: Desktop non-publishing artifact matrix

Status: implemented

English | [中文](2026-08-16-desktop-release-config.zh.md)

## Problem

Electron Builder only auto-discovers `electron-builder.yml` (or `yaml`, `json`, `json5`, `toml`, `js`, `cjs`, `ts`), so the checked-in `electron-builder.config.mjs` is never loaded without an explicit `--config` flag. A packaging run then silently falls back to defaults: empty `files`, `dist` output, and no publish guard. The fork also kept a publishing-capable legacy release workflow that could push upstream-scoped packages or create GitHub Releases from pull-request artifacts.

## Decision

`apps/desktop/electron-builder.config.mjs` imports product metadata with a JSON import attribute and pins appId, productName, executableName, `directories.output: release`, `files: ['out/**', 'package.json', 'resources/icons/**']`, `asar: true`, `publish: null`, and the Windows NSIS, macOS universal DMG, and Linux AppImage/DEB target matrix. Its Windows, macOS, and Linux `icon` fields select only the generated ICO, ICNS, and 512 px PNG files under `apps/desktop/resources/icons`. `desktopIconPath()` resolves the same generated platform asset for BrowserWindow, while the Desktop renderer copies the Web-owned generated favicon into its build output rather than introducing another favicon source. Both Desktop `package` and `package:dir` scripts verify generated icons before passing `--config electron-builder.config.mjs --publish never`; the new `.github/workflows/desktop-artifacts.yml` runs the same non-publishing command on windows-2025, macos-15, and ubuntu-24.04 with `contents: read` only, no environment, and no signing or npm secret. The legacy `.github/workflows/release.yml` becomes a pack-only audit: its publish input, publish job, and `NODE_AUTH_TOKEN` are removed while the credential-free pack/install verification job remains. `scripts/desktop-release-config.ts` statically asserts the explicit config flags, generated icon paths, and icon payload; `apps/desktop/tests/icon-assets.spec.ts` covers `prepackage` and `prepackage:dir`; and `ciArtifactGates()` runs `verify:desktop-release-config`.

## Alternatives considered

**Rename the config to `electron-builder.ts` for auto-discovery.** Rejected. The plan specifies `electron-builder.config.mjs`; the explicit `--config` flag is self-documenting, and the static gate proves the packaging scripts load it.

**Rely on auto-discovered defaults in CI.** Rejected. Without the explicit flag, `files: []` and `directories.output: dist` silently produce an unpackageable matrix; a hard gate is cheaper than a packaging regression.

## Consequences

Packaging always loads the checked-in matrix, verifies generated icon bytes before Builder runs, and never publishes; pull-request artifacts are unsigned and upload to Actions artifacts only. The release verifier reports the field and repository-relative generated path for an omitted or substituted platform icon. The legacy dsh workflow can still pack and verify installs but cannot publish. Local `package:dir` verification on Windows used the already-cached Electron zip through a one-off `--config.electronDist` override; that machine-local workaround is not part of the committed configuration.
