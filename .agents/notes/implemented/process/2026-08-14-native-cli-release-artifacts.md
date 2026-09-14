# Agent Note: Native CLI release artifacts

Status: implemented

English | [中文](2026-08-14-native-cli-release-artifacts.zh.md)

## Problem

The dsh command-line runtime needs downloadable native artifacts on the platforms supported by its local subprocess provider. A Linux-only archive does not provide a usable distribution for macOS or Windows, while installer formats would add product and signing contracts that are not implemented.

The CLI staging closure is created with `pnpm deploy --prod`, materialized without symlinks, and pruned of dependency `test`, `tests`, and `__tests__` directories before `@yao-pkg/pkg` scans its configured production assets.

## Decision

`scripts/build-cli-exe.ts` builds one native `@yao-pkg/pkg@6.21.0 --sea` target per invocation. The supported targets are `node24-linux-x64`, `node24-linux-arm64`, `node24-macos-x64`, `node24-macos-arm64`, and `node24-win-x64`. Linux and macOS produce tarballs; Windows produces a zip archive. Every archive has a SHA-256 sidecar and runs the executable help, version, and default-config smoke checks before the archive is written.

The builder stages the target's `node-pty` addon from the native install. macOS also requires its architecture-specific `spawn-helper`; the builder fails if that asset is absent. Native matrix runners build each target in `.github/workflows/build-cli-artifacts.yml`. The existing dsh release workflow calls that matrix only for a `dsh-v*` tag release and uploads its checked archives and checksums to the matching GitHub Release. The npm pack and publication sequence remains independent and continues to publish its exact packed bytes.

The artifacts are CLI-only. DMG, MSI, AppImage, Electron, and Python-wheel support are not implied by these archives.

## Alternatives considered

**Cross-compiling all targets on one runner.** Rejected because `node-pty` native assets must come from a matching native installation and pkg target binaries are platform-specific.

**Adding installers.** Rejected because no DMG, MSI, or AppImage packaging, signing, update, or installation contract exists.

**Uploading artifacts directly from the build matrix.** Rejected because release assets require one release-scoped job to recheck all checksums and upload the exact validated files.

## Consequences

Native runners make the platform and architecture of the staged `node-pty` payload explicit and expose unsupported prebuilds as build failures. Archives remain simple, verifiable command-line downloads, but users must extract them themselves and the workflow does not provide installer UX or signing.

The release asset job requires the GitHub Actions token with contents write permission, while build jobs remain read-only. A failed release asset upload can be retried without rebuilding or republishing npm packages.
