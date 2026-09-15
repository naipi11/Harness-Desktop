# Agent Note: Preserve bundle patch assets in native CLI artifacts

Status: implemented

English | [中文](2026-09-15-cli-sea-bundle-patch-assets.zh.md)

## Problem

The native CLI build stages the production dependency closure and asks `@yao-pkg/pkg` to embed its declared assets. `dsh-app-boot` resolves each profile bundle's `dsh.bundle.patch` path and reads that YAML file during startup. The staging asset list included code, manifests, JSON, native addons, wasm, and the CLI config tree, but omitted the shipped `cordis.patch.yml`, so SEA smoke tests failed before the profile could boot.

## Decision

The CLI asset list explicitly includes `node_modules/**/cordis.patch.yml`. This is the runtime YAML convention owned by profile bundles: the three shipped bundles publish that exact filename and declare it in `dsh.bundle.patch`. Other dependency YAML files remain excluded, while the existing `config/**/*` rule continues to carry the CLI's shipped configuration tree.

## Alternatives considered

**Include every dependency YAML file.** `node_modules/**/*.yml` and `node_modules/**/*.yaml` would mask the missing asset, but would also embed dependency documentation, fixtures, and other files that the runtime never reads.

**Change app-boot to inline or copy patch contents.** That would alter the bundle loader's declared-file semantics and would not preserve runtime assets for externally installed bundles. The artifact builder owns the production asset closure, so it is the correct repair point.

## Consequences

Native Linux and Windows CLI artifacts now contain the patch layer required by `loadOverlayPatches`, including `@stackstackstack/dsh-base/cordis.patch.yml`. The asset rule is covered by a focused regression test that also rejects broad dependency YAML globs. The artifact matrix remains Linux x64, Linux arm64, and Windows x64.

## Verification

The focused asset test, YAML/static checks, repository typecheck, lint, and the available native Windows artifact smoke path are required before release. No commit, tag, push, or publication is part of this change.
