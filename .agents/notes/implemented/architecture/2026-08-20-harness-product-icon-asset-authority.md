# Agent Note: Harness product icon asset authority

Status: implemented

English | [中文](2026-08-20-harness-product-icon-asset-authority.zh.md)

## Problem

Desktop executables, Linux launchers, browser chrome, and installed Web applications require different icon formats and sizes. Independent editable or hand-maintained inputs let those identities drift, make binary provenance unclear, and allow a platform-specific replacement to bypass the artwork authority used by the rest of the product.

Small native icons also cannot preserve every detail that remains legible at application and Web sizes. Theme-specific native variants would add another identity axis without a cross-platform selection mechanism, while the browser favicon has an explicit color-scheme mechanism.

## Decision

[`assets/brand/harness-icon.svg`](../../../../assets/brand/harness-icon.svg) is the only editable product-icon authority. It contains original repository-owned B-direction artwork: a round blue-violet little whale with a soft-pink highlight and a three-star trail. Product icon artwork must not copy or derive from DeepSeek or third-party characters, logos, source art, or other identifiable assets.

[`scripts/generate-product-icons.ts`](../../../../scripts/generate-product-icons.ts) is the only writer for every native and Web derivative. Generated SVG, PNG, ICO, ICNS, and favicon files are never edited directly. Renders at 32 px or below select `mark-compact`, which keeps the whale silhouette and one star; renders above 32 px select `mark-full`, which keeps the three-star trail.

`pnpm run generate:icons` replaces every declared derivative from the authority. `pnpm run verify:icons` builds the same expected bytes in memory, reports each missing or stale repository-relative path with a stable remediation, and performs no writes. Paths resolve from the generator module's repository root rather than the invoking directory, so command location cannot redirect output ownership.

Native platforms consume one color-safe asset. Only `apps/web/public/favicon.svg` contains generated light and dark `prefers-color-scheme` artwork. The [Web install manifest decision](../feature/2026-08-06-web-install-manifest.md) consumes the generated 192 px, 512 px, and maskable 512 px PNGs without acquiring a second artwork authority.

The generator uses root development dependencies for distinct format roles: `sharp` renders explicit-size sRGB PNGs from SVG, `png-to-ico` assembles the required Windows frames, and `@fiahfy/icns` assembles the required macOS representations. Pinning these libraries in `package.json` and `pnpm-lock.yaml` keeps the cross-platform generation implementation in the repository dependency graph instead of relying on an operator's installed image tools.

## Verification

`scripts/generate-product-icons.spec.ts` runs generation below a temporary repository root and pins the authority IDs and tokens, compact/full selection, visible and declared PNG dimensions, opaque maskable output, Windows and macOS representation endpoints, generated SVG markers, favicon media queries, and read-only drift diagnostics. `apps/web/tests/pwa-manifest.e2e.ts` pins the generated Web paths, sizes, MIME types, maskable purpose, source marker, and both favicon theme selectors in the built Web application.

`pnpm run generate:icons` followed by the focused generator and Web tests and then `pnpm run verify:icons` is the source-level acceptance path. A clean `verify:icons` result establishes byte equality with the current authority and dependency versions; it does not substitute for platform-native packaging checks that consume these files.

## Alternatives considered

**Maintain each platform asset by hand.** Rejected because separate editable binaries conceal which artwork is authoritative and let one platform drift without changing the authority SVG.

**Shell out to platform image utilities.** Rejected because tool presence and versions would depend on the host, and Windows, macOS, and Linux contributors would not execute one dependency-locked path.

**Implement ICO and ICNS containers in repository code.** Rejected because format libraries remove owned binary-encoding code and its compatibility burden while leaving source selection and drift policy in the repository generator.

**Publish light and dark native icon sets.** Rejected because native packagers consume one icon path and provide no shared runtime selection contract. The favicon is the sole theme-aware output because browsers define `prefers-color-scheme` for that surface.

## Consequences

One SVG edit and one generator run update every product-icon consumer, and the diff distinguishes authored vector changes from deterministic derivatives. A direct edit to any generated file fails `verify:icons` as stale.

The repository carries generated binary files and three root development dependencies. Dependency upgrades or renderer changes can alter committed bytes, so such upgrades require intentional regeneration, visual inspection of compact and full marks, and inspection of the resulting binary diff.

The compact mark gives up two stars and fine detail to preserve recognition at small sizes. Native icons give up automatic palette switching; the favicon retains that behavior without multiplying native packaging inputs.
