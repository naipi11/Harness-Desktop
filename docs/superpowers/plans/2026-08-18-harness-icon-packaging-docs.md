# Harness Icon, Packaging, and Cross-client Release Implementation Plan

English | [中文](2026-08-18-harness-icon-packaging-docs.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the original B “star-trail little whale” Harness visual assets, installable Windows/macOS/Linux desktop artifacts, the global `harness` CLI package, bilingual end-user instructions, and release evidence that all three clients share one local Runtime.

**Architecture:** Keep one editable, repository-owned SVG as the icon authority and derive every raster, container, and Web asset from it through a deterministic Node generation script. Keep `electron-builder` as the sole desktop packager, make its configuration consume only generated icon paths, and test source files, built output, packed archives, and installed client behavior separately. The Runtime remains the only persistence writer; release tests observe that invariant from terminal, Web, and Desktop clients rather than giving packaging code a parallel data path.

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`, pnpm 11, TypeScript 6, SVG, Sharp, PNG-to-ICO, `@fiahfy/icns`, Electron Builder, NSIS, DMG, AppImage, Debian packages, Vitest, Playwright, and GitHub Actions native runners.

**Spec:** [Harness unified local Runtime design](../specs/2026-08-18-harness-unified-local-runtime-design.md)

## Global Constraints

- Use only the approved original B “star-trail little whale” direction: a round blue-violet little whale with soft pink highlights and a small star trail; do not copy DeepSeek characters, logos, names, source art, or identifiable visual assets.
- `assets/brand/harness-icon.svg` is the editable source of truth and declares its color tokens; generated files are never hand-edited.
- At 64 px and larger, retain the star trail; at 32 px and 16 px, retain a legible whale silhouette and one star.
- Derive Windows multi-size `.ico`, macOS `.icns`, Linux PNG/SVG variants, Web favicon, and PWA icons from the same SVG source. The cross-platform native mark is deliberately one color-safe asset, not a theme-specific pair; only `apps/web/public/favicon.svg` has generated `prefers-color-scheme` light/dark variants, and its test must assert both variants.
- The desktop matrix is Windows NSIS, macOS universal DMG, Linux AppImage, and Linux Deb; all local and CI packaging commands pass `--publish never`.
- The public npm package is `@harness-desktop/cli`; `harness` is primary and `dsh` remains a compatibility alias with the same parser, Runtime, and data root.
- `HARNESS_HOME` is the only writable Harness data root. Its defaults are `%LOCALAPPDATA%\Harness Desktop`, `~/Library/Application Support/Harness Desktop`, and `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`.
- `harness`, `harness web`, and `harness desktop` are independently usable clients of one local Runtime; no client directly mutates persistence or owns a private session format.
- `harness web --daemon` and `harness web --background` create the same lease; `--status` never starts a Runtime, and `--stop` releases only that lease.
- The Runtime binds only `127.0.0.1`. A launcher-owned, one-time current-user-only bootstrap directory and document have verified owner-only POSIX modes or a current-user Windows ACL, and creation rejects a broader-access location. Its file URL, launch arguments, and logs are clean, while its HTML body submits the high-entropy handoff only in a hidden form field. Its opaque file origin makes the top-level `POST` to `/_harness/handoff` intentionally cross-origin: the Runtime does not require Origin equality, authenticates only the atomically consumed, unexpired body handoff, emits no CORS permission, and returns a clean `303` Dashboard navigation. A launcher-owned idempotent cleanup timer bound to `expiresAt` removes the owned document and directory exactly once after dispatch failure, exchange success or failure, or expiry, including a never-dispatched document. The handoff never appears in a URL, hash, query, header, referrer, history, browser storage, diagnostic, transcript, documentation example, Renderer IPC, or test output. The exchange-body verifier redacts its sole permitted body capture. The post-exchange randomized or signed session credential appears only in Runtime `Set-Cookie`, browser `Cookie` request headers, and the browser HttpOnly cookie jar; it uses `HttpOnly; SameSite=Strict; Path=/` with no expiry attribute and never reaches Dashboard JavaScript, Renderer IPC, script storage, app persistence, diagnostics, snapshots, or transcripts.
- Every changed human-facing document has an English and Simplified Chinese counterpart plus a refreshed `.i18n.yaml` consistency record.
- Git push is in scope only after the specified verification passes. `npm publish` and GitHub Release creation require fresh explicit user approval and are not implied by a successful build, pack, or push.
- This plan consumes the CLI/Web-owned parser, dispatcher, installed-app resolver, and activator as-is. It neither creates a second resolver/activator nor changes `harness web --stop`: Foundation defines release of an absent Web lease as idempotent success.

---

### Task 1: Add the original editable icon and deterministic asset generator

**Files:**
- Create: `assets/brand/harness-icon.svg`
- Create: `assets/brand/README.md`
- Create: `assets/brand/README.zh.md`
- Create: `assets/brand/README.i18n.yaml`
- Create: `scripts/generate-product-icons.ts`
- Create: `scripts/generate-product-icons.spec.ts`
- Create: `apps/desktop/resources/icons/win/harness-desktop.ico`
- Create: `apps/desktop/resources/icons/mac/harness-desktop.icns`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-16.png`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-32.png`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-64.png`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-128.png`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-256.png`
- Create: `apps/desktop/resources/icons/linux/harness-desktop-512.png`
- Modify: `apps/web/public/favicon.svg`
- Create: `apps/web/public/icons/harness-192.png`
- Create: `apps/web/public/icons/harness-512.png`
- Create: `apps/web/public/icons/harness-maskable-512.png`
- Modify: `package.json`
- Modify: `apps/web/public/manifest.webmanifest`
- Modify: `apps/web/tests/pwa-manifest.e2e.ts`

**Interfaces:**
- Consumes: `assets/brand/harness-icon.svg`, the SVG element IDs `mark-full`, `mark-compact`, `theme-light`, and `theme-dark`, and the color custom properties `--whale-primary`, `--whale-shadow`, `--whale-highlight`, `--star`, and `--background`.
- Produces: `generateProductIcons(options?: { readonly check?: boolean }): Promise<void>` and `collectProductIconViolations(root: string): Promise<readonly string[]>`; `--check` reports drift without writing.
- Produces: `.ico` frames at 16, 20, 24, 32, 40, 48, 64, 128, and 256 px for Windows executable and NSIS use; `.icns` representations at 16, 32, 64, 128, 256, 512, and 1024 px for macOS application and Dock use; Linux `harness-desktop-{16,32,64,128,256,512}.png` and `harness-desktop.svg`; and Web PNGs at 192 and 512 px. `favicon.svg` alone contains explicit generated `@media (prefers-color-scheme: light)` and `dark` artwork; no native light/dark variant is claimed.

- [ ] **Step 1: Write failing source-and-generated-asset tests**

Create `scripts/generate-product-icons.spec.ts`. It must read the SVG and require the exact five color-token names, both `mark-full` and `mark-compact`, and a source comment stating `Original Harness artwork; no DeepSeek-derived assets.`. Run the generator into a temporary root and require every file named in the interface to exist, be non-empty, and decode to its declared PNG dimensions. Require the ICO to contain both 16 px and 256 px frames, the ICNS to contain both 16 px and 1024 px representations, the Linux SVG to be generated from the authority, and `favicon.svg` to contain distinct generated light and dark media-query selectors. Require the 16 px and 32 px SVG render inputs to reference `mark-compact`, while 64 px and larger reference `mark-full`.

- [ ] **Step 2: Run the test and confirm the generator is absent**

Run:

```powershell
pnpm exec vitest run scripts/generate-product-icons.spec.ts
```

Expected: FAIL because `scripts/generate-product-icons.ts` and `assets/brand/harness-icon.svg` do not exist.

- [ ] **Step 3: Draw and document the editable SVG authority**

Create a viewBox-based SVG with only paths, circles, gradients, and the declared CSS custom properties. `mark-full` contains the blue-violet whale, soft-pink highlight, and a three-star trail. `mark-compact` contains the same whale silhouette and one star. Use `<symbol>` or `<g>` identifiers so the generator can select the two marks without parsing artwork geometry. Do not embed raster images, external URLs, DeepSeek names, or third-party artwork.

In the paired asset READMEs, document the source path, token names, the compact/full threshold, the generator command, and the rule that generated outputs are replaced only by the generator. Record the pair with:

```powershell
pnpm run verify-translation-pairing --write assets/brand/README.md
pnpm run verify-translation-pairing assets/brand/README.md
```

- [ ] **Step 4: Implement deterministic generation and drift reporting**

Use `sharp` to render SVG buffers with explicit width, height, and sRGB PNG output. Use `png-to-ico` to combine the required Windows frames and `@fiahfy/icns` to write the macOS representation set. Export `generateProductIcons`; resolve paths from the repository root, never from the invoking directory. Add root scripts exactly equivalent to:

```json
{
  "generate:icons": "tsx scripts/generate-product-icons.ts",
  "verify:icons": "tsx scripts/generate-product-icons.ts --check"
}
```

`--check` must compare generated bytes with committed files and return a stable diagnostic per missing or stale path, for example `icon asset: stale apps/web/public/icons/harness-512.png; run pnpm run generate:icons`. It must not write in check mode.

- [ ] **Step 5: Replace the Web icon metadata from generated assets**

Replace the current unrelated `apps/web/public/favicon.svg` with a generated SVG that contains the only light/dark media-query variants of the original whale. Change `manifest.webmanifest` so `icons` contains `harness-192.png`, `harness-512.png`, and a `purpose: "maskable"` `harness-maskable-512.png` entry. Update `apps/web/tests/pwa-manifest.e2e.ts` to assert these exact paths, dimensions, MIME types, generated source markers, and both favicon media-query selectors rather than the former black/white path-fill implementation.

- [ ] **Step 6: Run source-level generation and verification**

Run:

```powershell
pnpm run generate:icons
pnpm exec vitest run scripts/generate-product-icons.spec.ts apps/web/tests/pwa-manifest.e2e.ts
pnpm run verify:icons
```

Expected: generation is idempotent; focused tests pass; `verify:icons` exits 0 without modifying tracked files.

- [ ] **Step 7: Commit the source and generated icon set**

Run:

```powershell
git add assets/brand scripts/generate-product-icons.ts scripts/generate-product-icons.spec.ts apps/desktop/resources/icons apps/web/public/favicon.svg apps/web/public/icons apps/web/public/manifest.webmanifest apps/web/tests/pwa-manifest.e2e.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(brand): add original Harness icon asset pipeline"
```

### Task 2: Make desktop and Web builds consume generated assets

**Files:**
- Create: `apps/desktop/tests/icon-assets.spec.ts`
- Modify: `apps/desktop/electron-builder.config.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/tests/desktop-dashboard.e2e.ts`
- Modify: `apps/desktop/tests/desktop-recovery.e2e.ts`
- Modify: `scripts/desktop-release-config.ts`
- Modify: `scripts/desktop-release-config.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: generated `apps/desktop/resources/icons/{win,mac,linux}` files and `apps/web/public` generated assets.
- Produces: `desktopIconPath(platform: NodeJS.Platform): string`, returning the `.ico` path on `win32`, `.icns` on `darwin`, and the 512 px Linux PNG otherwise; Electron Builder configuration with `win.icon`, `mac.icon`, and `linux.icon` set to generated paths.
- Produces: `collectDesktopReleaseViolations()` diagnostics `builderConfig.<platform>.icon: expected <path>` when a platform icon is absent or points outside `apps/desktop/resources/icons`.

- [ ] **Step 1: Write failing desktop icon ownership tests**

In `apps/desktop/tests/icon-assets.spec.ts`, require `desktopIconPath('win32')`, `desktopIconPath('darwin')`, and `desktopIconPath('linux')` to return the three exact generated paths. Load the Electron Builder config and require its `win.icon`, `mac.icon`, and `linux.icon` to equal them. Extend `scripts/desktop-release-config.spec.ts` with an invalid config fixture whose Windows icon is `assets/deepseek.ico`; require `collectDesktopReleaseViolations()` to include `builderConfig.win.icon: expected apps/desktop/resources/icons/win/harness-desktop.ico`.

- [ ] **Step 2: Run the tests and observe the missing icon interface**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/icon-assets.spec.ts scripts/desktop-release-config.spec.ts
```

Expected: FAIL because `desktopIconPath` and Builder icon fields do not exist.

- [ ] **Step 3: Wire the generated files into Electron and Builder**

Add the pure `desktopIconPath(platform)` helper beside the Desktop main bootstrap and set BrowserWindow’s `icon` from it. Set the config fields to these repository-relative paths:

```js
win: { target: ['nsis'], icon: 'resources/icons/win/harness-desktop.ico' },
mac: { target: [{ target: 'dmg', arch: ['universal'] }], icon: 'resources/icons/mac/harness-desktop.icns', category: 'public.app-category.developer-tools' },
linux: { target: ['AppImage', 'deb'], icon: 'resources/icons/linux/harness-desktop-512.png', category: 'Development' }
```

Expand Builder `files` to include `resources/icons/**`. Add `prepackage` and `prepackage:dir` scripts that invoke `pnpm --dir ../.. run verify:icons`; packaging must fail before Electron Builder runs when generated output is stale. Add a generated favicon link to the renderer HTML only if the current production renderer does not already load the Dashboard document that owns it; do not create a second favicon authority.

- [ ] **Step 4: Harden the release configuration verifier**

Extend `DesktopBuilderConfig` with optional `icon` fields for Windows, macOS, and Linux. Reject paths that are not the exact generated asset paths, configs that omit a platform icon, and `files` lists that omit `resources/icons/**`. Preserve the existing non-publishing target checks. The command-line diagnostic must name the invalid config field and expected repository-relative path.

- [ ] **Step 5: Verify source, built, and unpacked desktop assets**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/icon-assets.spec.ts scripts/desktop-release-config.spec.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/tests/desktop-recovery.e2e.ts
pnpm run verify:icons
pnpm run verify:desktop-release-config
pnpm run desktop:build
pnpm --filter @harness-desktop/dsh-desktop run package:dir
```

Expected: source assertions pass; the build retains the favicon; the unpacked application contains the selected platform icon and starts with the whale icon instead of the operating-system default.

- [ ] **Step 6: Commit generated-asset consumption**

Run:

```powershell
git add apps/desktop apps/web scripts/desktop-release-config.ts scripts/desktop-release-config.spec.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "build(desktop): package generated Harness icons"
```

### Task 3: Add layered package and native installer smoke tests

**Files:**
- Create: `apps/desktop/tests/packaged-artifacts.spec.ts`
- Create: `apps/desktop/tests/installed-artifacts.e2e.ts`
- Create: `apps/desktop/tests/support/installed-artifact-fixture.ts`
- Create: `apps/cli/tests/packed-install.e2e.ts`
- Create: `apps/cli/tests/standalone-archive.e2e.ts`
- Create: `scripts/release/build-cli-standalone.ts`
- Create: `scripts/release/build-cli-standalone.spec.ts`
- Create: `scripts/release/node-runtime-checksums.json`
- Create: `scripts/release/verify-desktop-artifacts.ts`
- Create: `scripts/release/verify-cli-standalone.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/cli/package.json`
- Modify: `package.json`
- Modify: `scripts/run-gates.ts`
- Modify: `.github/workflows/desktop-artifacts.yml`

**Interfaces:**
- Consumes: clean source/built/unpacked Desktop layers from the desktop-host plan, `apps/desktop/release/`, a packed `apps/cli` tarball, the shared keyless Runtime/Dashboard fixture, and current-OS installer tools.
- Produces: `verifyDesktopArtifacts(input: { readonly platform: NodeJS.Platform; readonly releaseDirectory: string }): Promise<readonly string[]>`; an empty array means the native artifact matrix for the current runner has the expected installer and icon resources.
- Produces: `pnpm run release:verify-desktop-artifacts`, `pnpm run release:verify-packed-cli`, and `pnpm run release:verify-cli-standalone`, all non-publishing checks. The packed CLI contains its complete runtime dependency graph: every workspace dependency reachable from either `harness` or `dsh` is bundled or listed as a package payload dependency resolved from the fresh offline prefix; source, tests, credentials, and Desktop artifacts stay excluded.
- Produces: `pnpm run release:smoke-installed-desktop`, which performs an isolated installed-or-mounted artifact launch, consumes the Desktop-host plan's exact redacted process-observable ready acknowledgement after authenticated Dashboard bootstrap, validates the generated icon, and proves uninstall does not delete the fixture `HARNESS_HOME` sentinel.
- Produces: `buildCliStandalone(input: { readonly platform: NodeJS.Platform; readonly arch: string; readonly version: string; readonly nodeRuntimeRoot: string; readonly outputDirectory: string }): Promise<readonly string[]>`, which deterministically emits `harness-cli-${version}-${platform}-${arch}.zip`, `harness-cli-${version}-${platform}-${arch}.tar.gz`, and `harness-cli-${version}-${platform}-${arch}.sha256`. Each archive contains `manifest.json`, the matching pinned Node distribution, the complete CLI runtime graph, `harness`, and `dsh`; each command runs from an unpacked empty working directory without a system Node or network.
- Produces: `scripts/release/node-runtime-checksums.json`, the reviewed SHA-256 allowlist keyed by exact Node version, platform, architecture, and distribution filename. The producer copies only an allowlisted local Node distribution, rejects an absent or mismatched runtime instead of downloading, records a deterministic sorted per-file digest map in `manifest.json`, and sets archive timestamps, ordering, ownership, and modes from the source date epoch.
- Produces: target-specific native-module closure: every runtime `.node` file must match the requested platform and architecture, appear in the dependency-closure manifest and digest map, and load under the bundled Node runtime. The producer rejects optional or transitive native modules for another target rather than packaging a host build.

- [ ] **Step 1: Write failing packaged-content tests**

Create a unit test for `verifyDesktopArtifacts` with temporary fake release trees. Require Windows to accept exactly an NSIS setup `.exe` plus an unpacked `.exe` carrying `resources/app.asar`, reject a missing setup with `desktop artifact: missing Windows NSIS installer`, and reject a missing icon resource with `desktop artifact: missing generated Windows icon`. Require macOS to recognize a universal `.dmg`, run `lipo -info` on the mounted app binary, and require both `x86_64` and `arm64`. Require Linux to recognize both `.AppImage` and `.deb`; missing artifacts must produce platform-specific diagnostics.

Create `apps/cli/tests/packed-install.e2e.ts` to run `pnpm pack --pack-destination <temp>`, install the tarball into a fresh temporary npm prefix and empty npm cache with `npm install --offline --ignore-scripts <tarball>`, and invoke `<prefix>/bin/harness --help` and `<prefix>/bin/dsh --help`. Require both exit 0, the primary help to begin with `Usage: harness`, and the alias to begin with `Usage: dsh`. Make a runtime command in the installed prefix import each bundled workspace dependency before the help assertion so a flattened or accidentally local workspace resolution cannot pass.

Create `scripts/release/build-cli-standalone.spec.ts`, `apps/cli/tests/standalone-archive.e2e.ts`, and `scripts/release/verify-cli-standalone.ts`. Give the producer a fixture Node distribution and packed CLI graph, then require byte-identical ZIP/tar output across two runs with the same source date epoch, the exact `harness-cli-${version}-${platform}-${arch}` names, a matching sorted digest manifest, and rejection of an absent/mismatched Node checksum or a foreign-architecture `.node` file. On each native release runner, require the matching `.zip` and `.tar.gz` to contain the platform Node executable, complete packaged CLI graph, and both command launchers. Extract each into an empty working directory with `PATH` limited to platform basics and no directory containing a system Node, run `harness --help` and `dsh --help` through the launchers, and require their recorded `process.execPath` to be inside the extracted bundled runtime. Require no package-manager, registry, or network invocation. The archive test is an artifact test, not evidence that it may be uploaded.

Create `apps/desktop/tests/installed-artifacts.e2e.ts` first. Its fixture writes a sentinel only in a temporary `HARNESS_HOME`, starts the same keyless Runtime and Dashboard used by the Desktop-host plan, and consumes that plan's exact redacted process-observable ready acknowledgement only after Dashboard authentication. On Windows silently install the NSIS artifact to an isolated directory, launch its installed executable, verify Dashboard functionality and the generated icon, silently uninstall, and require the sentinel to remain. On macOS attach the DMG, verify `lipo` reports both architectures, copy the app to an isolated Applications directory, launch it, then remove that app copy and preserve the sentinel. On Linux launch an extracted/mounted AppImage and install the Deb into an isolated root before launching each executable; each path must attach to the same Runtime, authenticate the Dashboard, show the generated icon, and leave the sentinel after removal. Never treat archive inspection or an Electron process alone as an installed-artifact success.

- [ ] **Step 2: Run the tests and confirm the release verifier is absent**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/packaged-artifacts.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts
```

Expected: FAIL because the artifact verifier, packed-install fixture, and deterministic standalone producer do not exist or expose the current package payload defect.

- [ ] **Step 3: Implement artifact inspection and package payload closure**

Implement the artifact verifier with platform-selected exact filename patterns and archive/content inspection appropriate to the runner: `7z l` for NSIS output, `hdiutil imageinfo` plus mounted-image inspection and `lipo -info` for DMG, `bsdtar -tf` for AppImage where available, and `dpkg-deb --contents` for Deb. Test adapters must isolate tool invocation so fixture unit tests never require a real installer; `installed-artifacts.e2e.ts` owns the real native install/mount operations.

Update `apps/cli/package.json` and the release pack path so `npm pack --dry-run` includes every built `lib/**` file, shipped `config/**`, and every runtime asset and workspace dependency transitively required by `harness` and `dsh`, while excluding source, tests, credentials, and desktop release artifacts. Do not add `apps/desktop` to the npm payload. Build an explicit dependency-closure manifest from package metadata and fail the verifier on any unresolved `@harness-desktop/*` runtime import; do not rely on a developer checkout, hoisting, or online registry resolution. Prove the installed tarball starts in the fresh offline prefix before declaring the package installable.

Implement `build-cli-standalone.ts` after the packed dependency closure exists. Stage that closure in a fresh target directory, copy the checksum-verified local Node distribution and only target-matching native modules, generate `manifest.json` from sorted relative paths and SHA-256 digests, and write both archive formats plus the exact checksum sidecar without contacting a registry. The launchers resolve their sibling bundled Node executable, not `node` from `PATH`; the verifier loads every declared native module with that executable before invoking both help commands. Keep the producer, archive verifier, and npm pack verifier separate so npm packaging never becomes an implicit archive producer.

- [ ] **Step 4: Add non-publishing release commands and CI evidence**

Add root commands that build before inspection but never publish:

```json
{
  "release:verify-desktop-artifacts": "tsx scripts/release/verify-desktop-artifacts.ts",
  "release:verify-packed-cli": "pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts",
  "release:build-cli-standalone": "tsx scripts/release/build-cli-standalone.ts",
  "release:verify-cli-standalone": "tsx scripts/release/verify-cli-standalone.ts",
  "release:smoke-installed-desktop": "pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/installed-artifacts.e2e.ts"
}
```

In `.github/workflows/desktop-artifacts.yml`, make platform ownership explicit: `windows-2025` owns NSIS install/uninstall, Windows ZIP/tar CLI archive generation then extraction, and Windows installer-tile/icon inspection; `macos-15` owns universal-DMG mount/copy/uninstall plus `lipo`, Dock/ICNS inspection, and macOS archive generation then extraction; `ubuntu-24.04` owns AppImage and Deb mount/install/removal, Linux PNG/SVG inspection, and Linux archive generation then extraction. Each native job runs `pnpm run generate:icons`, `pnpm run verify:icons`, current-runner `package`, `release:verify-desktop-artifacts`, `release:verify-packed-cli`, `release:build-cli-standalone`, `release:verify-cli-standalone`, and `release:smoke-installed-desktop` in that order, then uploads only inspected artifacts, checksum sidecars, and redacted logs. PR and ordinary smoke workflows always use `--publish never`; do not cross-simulate installers or add `NODE_AUTH_TOKEN`, `npm publish`, `gh release create`, signing credentials, notarization credentials, update-server credentials, or an environment deployment.

- [ ] **Step 5: Run source, packed, and platform-native smoke verification**

Run on each matching native runner:

```powershell
pnpm run build
pnpm run generate:icons
pnpm run verify:icons
pnpm --filter @harness-desktop/dsh-desktop run package
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:smoke-installed-desktop
```

Expected: source, built, unpacked, installed, npm-prefix, and standalone layers remain distinct. Windows yields an NSIS installer and exercises its isolated install/uninstall; macOS yields a universal DMG verified by `lipo` and exercises mount/copy/removal; Linux yields and separately launches AppImage and Deb paths. Every launched artifact attaches to the Runtime, authenticates the real Dashboard, shows the generated icon, and preserves `HARNESS_HOME` through uninstall. The fresh offline npm prefix and each matching standalone archive expose both commands without developer-checkout imports. No command publishes anything.

- [ ] **Step 6: Commit release smoke coverage**

Run:

```powershell
git add apps/desktop/tests/packaged-artifacts.spec.ts apps/desktop/tests/installed-artifacts.e2e.ts apps/desktop/tests/support/installed-artifact-fixture.ts apps/cli/tests/packed-install.e2e.ts apps/cli/tests/standalone-archive.e2e.ts scripts/release/build-cli-standalone.ts scripts/release/build-cli-standalone.spec.ts scripts/release/node-runtime-checksums.json scripts/release/verify-desktop-artifacts.ts scripts/release/verify-cli-standalone.ts apps/desktop/package.json apps/cli/package.json package.json scripts/run-gates.ts .github/workflows/desktop-artifacts.yml pnpm-lock.yaml
git diff --cached --check
git commit -m "test(release): smoke packaged desktop and CLI artifacts"
```

### Task 4: Consume the completed public client entries in release acceptance

**Files:**
- Modify: `apps/desktop/tests/installed-artifacts.e2e.ts`
- Modify: `apps/desktop/tests/support/installed-artifact-fixture.ts`
- Modify: `apps/cli/tests/packed-install.e2e.ts`

**Interfaces:**
- Consumes: the CLI/Web plan's sole parser and dispatcher, `InstalledDesktopActivator`, `DesktopNotInstalledError`, and `runDesktopInvocation`; the Foundation Runtime client's idempotent Web-lease release; and the Desktop-host plan's exact redacted process-observable Desktop-ready acknowledgement.
- Produces: release tests that invoke installed `harness`, `harness web --status`, `harness web --stop`, and `harness desktop` through those completed public interfaces. This task defines no resolver, activator, parser, dispatcher, or readiness type.

- [ ] **Step 1: Write failing consumption-only acceptance tests**

In the installed-prefix test, invoke `harness web --status` against no Runtime and require its existing typed `runtime unavailable` nonzero result with no files, lock, endpoint, browser, or child created. Invoke `harness web --stop` twice after the same lease is released and require both commands to exit successfully while the active terminal session remains attached. Invoke `harness desktop` only against the CLI/Web plan's installed-app fixture and require exactly one activation; its unavailable fixture must render that plan's platform route and must not create a Runtime or Electron substitute.

In the native installer fixture, wait for the Desktop-host plan's exact redacted process-observable acknowledgement only after the Runtime attachment and authenticated Dashboard bootstrap. Do not inspect recovery preload IPC for project or session data, and do not duplicate the CLI's installed-app detection.

- [ ] **Step 2: Run the release-facing tests before client-entry completion**

Run:

```powershell
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts
pnpm run release:smoke-installed-desktop
```

Expected: FAIL until the completed CLI/Web and Desktop plans provide their owned entry interfaces and the installer fixture consumes them.

- [ ] **Step 3: Wire tests to owned interfaces without changing their behavior**

Pass the completed CLI/Web activator and parser through fixture injection; never import Electron into the CLI package or recreate installed-app probing in Desktop. Treat absent-lease `web --stop` as Foundation's idempotent success, not `background lease unavailable`. Consume the Desktop-owned acknowledgement unchanged as a synchronization signal only; assert its exact redacted fields expose no endpoint, token, handoff, cookie, path, or process field and never add a release-owned IPC channel or readiness type.

- [ ] **Step 4: Verify installed entry semantics**

Run:

```powershell
pnpm run release:verify-packed-cli
pnpm run release:smoke-installed-desktop
```

Expected: the package and native artifact tests prove only the approved, existing command behavior; neither test becomes a second owner of routing, app activation, or Runtime lifecycle.

- [ ] **Step 5: Commit release-entry consumption**

Run:

```powershell
git add apps/desktop/tests/installed-artifacts.e2e.ts apps/desktop/tests/support/installed-artifact-fixture.ts apps/cli/tests/packed-install.e2e.ts
git diff --cached --check
git commit -m "test(release): consume public client entries"
```

### Task 5: Add cross-client Runtime acceptance fixtures

**Files:**
- Create: `apps/cli/tests/cross-client-runtime.e2e.ts`
- Create: `apps/web/tests/cross-client-runtime.e2e.ts`
- Create: `apps/desktop/tests/cross-client-runtime.e2e.ts`
- Create: `packages/test-support/cross-client-runtime/package.json` as `@harness-desktop/dsh-cross-client-runtime`
- Create: `packages/test-support/cross-client-runtime/tsconfig.json`
- Create: `packages/test-support/cross-client-runtime/tsdown.config.ts`
- Create: `packages/test-support/cross-client-runtime/src/index.ts`
- Create: `packages/test-support/cross-client-runtime/src/cross-client-fixture.ts`
- Create: `packages/test-support/cross-client-runtime/src/invariant.ts`
- Create: `packages/test-support/cross-client-runtime/tests/cross-client-fixture.host.spec.ts`
- Create: `packages/test-support/cross-client-runtime/README.md`
- Create: `packages/test-support/cross-client-runtime/README.zh.md`
- Create: `packages/test-support/cross-client-runtime/README.i18n.yaml`
- Modify: `packages/test-support/README.md`
- Modify: `packages/test-support/README.zh.md`
- Modify: `packages/test-support/README.i18n.yaml`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `vitest.e2e.config.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: `HARNESS_HOME`, Node process/filesystem APIs, the public CLI, the authenticated Dashboard DOM/test hook supplied by the Web/Desktop plans, Electron test-process launch support, and the CLI/Web plan's test-only unpacked activation adapter. `packages/test-support/client-runtime` remains browser-side source-only infrastructure and may be used only by Web DOM feature tests; it is not imported by this host package or by native process fixtures.
- Produces: host-only `createCrossClientFixture(): Promise<CrossClientFixture>` with `home`, `workspace`, `runCli(args)`, `openWeb()`, `openDesktop()`, `readProjects()`, `readSessions()`, `stopRuntime()`, and `dispose()`. Its published Node entry and built `lib/` output are the only fixture entry used by CLI, Web process, and Electron e2e runners.
- Produces: typed fixture observations `{ readonly projectId: ProjectId; readonly sessionId: SessionId }`; no test accesses SQLite, lock files, or credential storage directly.

- [ ] **Step 1: Write failing host-fixture, shared-state, and recovery tests**

Create `packages/test-support/cross-client-runtime/tests/cross-client-fixture.host.spec.ts` before the app tests. With injected child-process, filesystem, Runtime-health, Dashboard, and Electron adapters, require the host fixture to create only its own temporary home/workspace, await the explicit redacted Runtime-health response, and dispose every child it started before removing those directories. Require its invariant to observe each owned child through `started`, `health-confirmed`, and exactly one `stopped` lifecycle event; a missing stop event fails the invariant. The test must import the Node entry and reject a browser compiler face, Node import, or Electron import through `packages/test-support/client-runtime`.

Write the same acceptance sequence once with each client as creator: select one temporary workspace, create a project and session from the creator, then require each other client to see the same opaque project and session IDs and append visible work to that session. Start a session operation from CLI and require Web’s concurrent operation to receive `session busy` with the active `sessionId`, never a second writer.

Add recovery coverage: begin work through Desktop, terminate only its client process unexpectedly, verify CLI and Web retain the active Runtime and session, then reconnect Desktop and observe the same history. Assert no fixture output contains `HARNESS_HOME` credentials, access tokens, handoff secrets, or session cookie values.

- [ ] **Step 2: Run the tests and confirm the cross-client harness is absent**

Run:

```powershell
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- cross-client-runtime.e2e.ts
```

Expected: FAIL because the registered host fixture and clients cannot yet attach to one Runtime.

- [ ] **Step 3: Register and implement the host-only public-API fixture**

Create the complete `packages/test-support/cross-client-runtime` host package: a Node `tsconfig.json` extending `../../../tsconfig.base.json`, a host `tsdown.config.ts`, `package.json` exports for `.` and `./invariant`, source `index.ts`, `cross-client-fixture.ts`, and `invariant.ts`, focused host tests, and paired package README/i18n record. Add the exact `@harness-desktop/dsh-cross-client-runtime` and `/invariant` source aliases to `tsconfig.base.json`, add its project reference to `tsconfig.host.json`, and add its role to the paired `packages/test-support/README*` table before any app test imports it. The package has no client aggregate reference and no browser entry.

Each test receives a fresh `HARNESS_HOME` and workspace, but observes state only through the terminal JSON protocol, authenticated Dashboard DOM/test hooks, and a supported Runtime test API. Desktop project/session state is read from the authenticated Dashboard DOM or that Runtime test API, never from recovery preload IPC. The fixture waits for an explicit redacted Runtime health response; it must never infer readiness from a PID, file path, or port scan. Its cleanup calls the public stop/dispose path, then removes only its explicit temporary directories after the owned process registry observes every child exit.

- [ ] **Step 4: Make the three native client tests share the fixture**

The CLI test owns terminal JSON assertions, the Web test owns browser rendering and handoff-cookie behavior, and the Desktop dashboard/recovery tests own Electron activation and renderer isolation. Keep common project/session assertions in the host fixture helper. Every test must prove the Dashboard and Desktop show the real authenticated application rather than a local placeholder, and one client exit does not terminate other clients’ active work. Web DOM-only assertions may use the existing client-runtime helper inside their browser test; no process, filesystem, health, or Electron orchestration moves back into that client package.

- [ ] **Step 5: Run cross-client acceptance on a clean output tree**

Run:

```powershell
pnpm run clean
pnpm run build
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- cross-client-runtime.e2e.ts
```

Expected: all three client creators converge on one Runtime and durable history; contention is rejected; an unexpected client exit recovers safely; no secret reaches test output.

- [ ] **Step 6: Commit cross-client acceptance coverage**

Run:

```powershell
git add apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts apps/desktop/tests/cross-client-runtime.e2e.ts packages/test-support/cross-client-runtime packages/test-support/README.md packages/test-support/README.zh.md packages/test-support/README.i18n.yaml tsconfig.base.json tsconfig.host.json vitest.e2e.config.ts apps/desktop/playwright.config.ts pnpm-lock.yaml
git diff --cached --check
git commit -m "test(runtime): cover shared clients and recovery"
```

### Task 6: Publish bilingual installation and shared-Runtime documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `apps/cli/README.md`
- Modify: `apps/cli/README.zh.md`
- Modify: `apps/cli/README.i18n.yaml`
- Create: `apps/desktop/README.md`
- Create: `apps/desktop/README.zh.md`
- Create: `apps/desktop/README.i18n.yaml`
- Modify: `docs/user/guide/index.md`
- Modify: `docs/user/guide/index.zh.md`
- Modify: `docs/user/guide/index.i18n.yaml`

**Interfaces:**
- Consumes: verified CLI grammar, data-root behavior, the Foundation-owned legacy detection/result and durable user-decision state, desktop installer names, and public typed errors.
- Produces: English and Simplified Chinese quick-start instructions for global install, source execution, `harness`, `harness web`, `harness desktop`, shared local roots/import, Web daemon/status/stop, Windows/macOS/Linux install/uninstall, and visible first-start legacy-import decisions in all three clients.

- [ ] **Step 1: Write failing documentation assertions**

Extend `scripts/product-identity.spec.ts` or add `scripts/runtime-release-docs.spec.ts` to require both root READMEs to contain `npm install -g @harness-desktop/cli`, `harness`, `harness web --daemon`, `harness web --status`, `harness web --stop`, `harness desktop`, `HARNESS_HOME`, `DSH_HOME`, `dsh`, `NSIS`, `DMG`, `AppImage`, and `Deb`. Require each language to state that `npm publish` and GitHub Release creation require explicit approval.

- [ ] **Step 2: Run documentation tests and confirm current instructions are stale**

Run:

```powershell
pnpm exec vitest run scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
```

Expected: FAIL because the current READMEs describe a fixed Web port and profile-only behavior instead of the unified Runtime commands and lifecycle.

- [ ] **Step 3: Rewrite root quick starts around the three clients**

In both root READMEs, lead with global installation:

```sh
npm install -g @harness-desktop/cli
harness
harness "fix the failing tests"
harness web
harness desktop
```

Document `harness run "task" --json`, `harness web --daemon`, `harness web --background --no-open`, `harness web --status`, and `harness web --stop`. State that all three clients use one local Runtime and `HARNESS_HOME`; give the exact platform defaults. Do not describe legacy import as a silent helper: consume the Foundation detection/result and decision record as the source of truth, then show the first-start offer, an explicit user accept or reject, the recorded decision/outcome, collision correction and retry, and failures that retain both `DSH_HOME` and `HARNESS_HOME`.

- [ ] **Step 3a: Specify visible legacy-import flows for all three clients**

For the interactive CLI, render the Foundation first-start offer before normal session entry when it reports a detected legacy root and an undecided empty target: `Import supported data from DSH_HOME into HARNESS_HOME? [y/N]`. `y` calls the Foundation import operation and prints the typed result; `N` records the rejection through the Foundation decision path and continues with the empty target. A `target-not-empty` collision prints the correction, leaves both roots unchanged, and offers a deliberate retry after the user empties or chooses another `HARNESS_HOME`; `{ kind: 'failed', retained }` prints only the redacted diagnostic identifier and retained-root notice, never deletes either root.

For Web, the authenticated Dashboard's first-start screen presents the same detected-source/empty-target offer before workspace selection. Its Import and Not now controls submit the Foundation decision through the supported Runtime API, then render the resulting imported, rejected, collision, or failure record. The collision view offers Retry after correction; it never issues a client-side copy. Browser reload observes the durable decision/result rather than re-offering a completed or rejected import.

For Desktop, after Dashboard authentication the real Dashboard renders that same first-start card; Desktop Main and the recovery preload do not implement migration or expose legacy paths. Accept, reject, collision/retry, and failure use the authenticated Dashboard flow above. Installer and recovery tests assert the visible Dashboard state and Foundation-recorded outcome, not filesystem inspection or recovery IPC.

- [ ] **Step 4: Add platform installation, uninstall, and release boundaries**

Document only verified routes: Windows runs the downloaded NSIS setup and uninstalls through Installed Apps or the NSIS uninstaller; macOS opens the universal DMG, moves Harness Desktop to Applications, and removes it from Applications to uninstall; Linux installs the `.deb` with the distribution package manager or runs the AppImage after making it executable, then removes the selected artifact/package to uninstall. State that uninstalling an application does not delete `HARNESS_HOME`; show how to back it up or remove it only as an explicit separate action. Do not describe an application uninstall as accepting, rejecting, completing, or deleting a legacy import.

Keep CLI package contract detail in `apps/cli/README*`, desktop build/installer contract detail in `apps/desktop/README*`, and product-facing procedures in `docs/user/guide/*`; link instead of duplicating. Refresh every listed `.i18n.yaml` record with `verify-translation-pairing --write` after each pair is complete.

- [ ] **Step 5: Run documentation and link verification**

Run:

```powershell
pnpm run verify-translation-pairing --write README.md
pnpm run verify-translation-pairing --write apps/cli/README.md
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing --write docs/user/guide/index.md
pnpm exec vitest run scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
pnpm run doc-sync
git diff --check
```

Expected: all four pairs are recorded and pass; documentation tests, links, wrapping, and site build pass.

- [ ] **Step 6: Commit the bilingual release guides**

Run:

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/desktop/README.md apps/desktop/README.zh.md apps/desktop/README.i18n.yaml docs/user/guide/index.md docs/user/guide/index.zh.md docs/user/guide/index.i18n.yaml scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
git diff --cached --check
git commit -m "docs: explain Harness installation and shared Runtime"
```

### Task 7: Implement local Desktop and standalone CLI update and rollback

**Files:**
- Create: `packages/host/local-runtime/src/update-preferences.ts`
- Create: `packages/host/local-runtime/tests/update-preferences.spec.ts`
- Modify: `packages/host/local-runtime/src/runtime-client.ts`
- Modify: `packages/host/local-runtime/src/control-service.ts`
- Create: `apps/desktop/src/main/update/channel.ts`
- Create: `apps/desktop/src/main/update/manifest.ts`
- Create: `apps/desktop/src/main/update/staged-install.ts`
- Create: `apps/desktop/src/main/update/service.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/tests/desktop-updater.spec.ts`
- Create: `apps/desktop/tests/desktop-updater.e2e.ts`
- Create: `apps/desktop/tests/support/update-fixture.ts`
- Create: `apps/cli/src/update.ts`
- Modify: `apps/cli/src/command.ts`
- Create: `apps/cli/tests/update.e2e.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/cli/package.json`
- Modify: `package.json`
- Modify: `scripts/run-gates.ts`

**Interfaces:**
- Consumes: the Foundation Runtime's sole-writer settings service, the Desktop-host plan's exact redacted process-observable Desktop-ready acknowledgement, the packaged artifact names from Task 3, and a compiled-in update-manifest public-key allowlist. Desktop Main owns fetching, signature/digest validation, staging, install handoff, and rollback orchestration; channel selection remains an authenticated Dashboard application setting and Main reports only redacted native status, never a manifest URL, token, staging path, or signing key.
- Produces: `DesktopUpdateChannel = 'stable' | 'beta' | 'nightly'`; Foundation-owned `RuntimeClient.getDesktopUpdateChannel()` and `RuntimeClient.setDesktopUpdateChannel(channel)` persist that choice through the Runtime settings service, not Electron user data. `RuntimeClient.recordDesktopUpdateOutcome(...)` records only a redacted version/channel/outcome and last-known-good version; it never records a URL, token, manifest body, or installation path.
- Produces: `DesktopUpdateService.checkAndStage(): Promise<DesktopUpdateResult>` and `applyStagedUpdate(): Promise<DesktopUpdateResult>`. A result is one of `up-to-date`, `staged`, `applied`, `rolled-back`, or `failed` with a stable redacted code. The service accepts only a newer artifact from the selected channel, except an explicit rollback to the retained prior compatible stable version. It verifies HTTPS allowlisted origin, channel, exact version, platform/architecture, signature, SHA-256 digest, archive member paths, and staged executable before preserving the current version, staging the candidate, and requesting a restart.
- Produces: `harness update` behavior with one owner per install form. An npm-installed CLI reports `managed-by-npm` with the exact package-manager command and never edits its installation. A standalone archive verifies, stages, health-checks, atomically switches to, and can restore its own matching CLI archive through the same signed-manifest/digest policy; it never calls npm or self-updates an npm prefix.

- [ ] **Step 1: Write failing updater, malicious-manifest, health, rollback, and CLI-form tests**

Create `packages/host/local-runtime/tests/update-preferences.spec.ts` to prove update-channel selection and redacted outcomes are serialized by the Runtime settings service and cannot create a private Desktop persistence writer. Create `apps/desktop/tests/desktop-updater.spec.ts` with local fake HTTPS/download, signature, installer, and process adapters. Reject a bad signature or checksum, non-HTTPS/non-allowlisted URL, path traversal archive member, wrong platform/architecture, channel mismatch, duplicate version, downgrade, cross-channel rollback, and a manifest that tries to replace the retained current artifact. Require a valid stable, beta, and nightly manifest to select only its own newer channel artifact.

Create `apps/desktop/tests/desktop-updater.e2e.ts` with the real packaged-app launch fixture. Retain the current version, stage a verified candidate, restart it, and accept it only after the Desktop-host plan's unchanged redacted process-observable acknowledgement arrives after authenticated Dashboard boot. Require a missing, malformed, or failure acknowledgement to mark the candidate failed, restart the retained version, record the redacted rollback outcome through Runtime settings, and preserve `HARNESS_HOME`. Create `apps/cli/tests/update.e2e.ts` with an npm-prefix fixture and an extracted archive fixture: npm reports `managed-by-npm` without modifying files or running a package manager, while the archive performs verified stage/switch/health/rollback with no system Node, npm, or network after its local manifest/download fixture is supplied.

- [ ] **Step 2: Run focused tests and confirm the updater is absent**

Run:

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts apps/desktop/tests/desktop-updater.spec.ts apps/cli/tests/update.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- desktop-updater.e2e.ts
```

Expected: FAIL because no Runtime-owned channel/outcome API, Desktop Main updater, staged health/rollback behavior, or install-form-aware CLI update path exists.

- [ ] **Step 3: Implement local signed update, staged health, and rollback ownership**

Add the Runtime setting/control implementation first so the selected channel and redacted result use the existing shared Runtime and survive client restarts. In Desktop Main, parse manifests into an exact allowlisted schema, verify the detached signature and SHA-256 before extraction, reject unsafe members before writing, and keep the running artifact untouched until the candidate has launched and the Desktop-owned acknowledgement arrives after authenticated Dashboard boot. Commit the candidate only after that acknowledgement; otherwise record the failed version, restore the retained executable, and expose only a stable redacted failure/rollback result. A manual rollback selects the retained compatible prior stable artifact and follows the same staged verification and acknowledgement rule.

Implement `harness update` after install-form detection: the npm path prints the managed command and exits without mutation; the standalone path uses its bundled Node, target-specific archive manifest, and sibling replacement adapter. It validates the same channel, version, signature, digest, and native module target before an atomic switch, then launches `harness --help` through the new bundled runtime as its CLI health check and restores the retained archive on failure. Do not add a background updater, direct renderer filesystem access, a new ready IPC channel, a secret-bearing diagnostic, or an unverified downgrade.

- [ ] **Step 4: Add non-publishing updater commands and focused evidence**

Add root commands equivalent to:

```json
{
  "release:verify-update-manifests": "tsx scripts/release/verify-update-manifests.ts",
  "desktop:test-updater": "pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- desktop-updater.e2e.ts",
  "release:test-cli-update": "pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts"
}
```

Make the updater tests use only local fixtures and fake keys. They may verify a manifest or downloader produced by a local test server but never sign a release, upload a manifest, publish an npm package, notarize, or create a release. Add the focused commands to the release gate after archive production and before any release-candidate workflow action.

- [ ] **Step 5: Run source, built, packaged, and rollback verification**

Run:

```powershell
pnpm run build
pnpm run release:build-cli-standalone
pnpm run release:verify-update-manifests
pnpm run release:test-cli-update
pnpm run desktop:test-updater
```

Expected: source and built Desktop paths reject malicious manifests, staged installs prove the exact Desktop acknowledgement after authenticated Dashboard boot, failed candidates roll back without deleting `HARNESS_HOME`, npm installations remain package-manager-owned, and standalone archives update/roll back through their bundled runtime. No command signs, uploads, publishes, or creates a release.

- [ ] **Step 6: Commit local updater and rollback coverage**

Run:

```powershell
git add packages/host/local-runtime apps/desktop/src/main apps/desktop/tests apps/cli/src/update.ts apps/cli/src/command.ts apps/cli/tests/update.e2e.ts apps/desktop/package.json apps/cli/package.json package.json scripts/run-gates.ts pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(release): stage verified local updates with rollback"
```

### Task 8: Run release acceptance, then push only verified changes

**Files:**
- Modify: `.github/workflows/desktop-artifacts.yml`
- Modify: `scripts/run-gates.ts`
- Create: `.github/workflows/release-candidates.yml`
- Modify: `scripts/release/verify-update-manifests.ts`
- Modify: `scripts/release/verify-update-manifests.spec.ts`
- Verify: `assets/brand/harness-icon.svg`
- Verify: `apps/desktop/release/`
- Verify: `apps/cli/package.json`
- Verify: `README.md`
- Verify: `README.zh.md`

**Interfaces:**
- Consumes: the source, built, packed, installed, and local staged-update checks from Tasks 1–7.
- Produces: one non-publishing pull-request release-smoke workflow; local signed-manifest fixtures for stable, beta, and nightly update channels; a rollback verification that drives the Desktop/CLI consumers from Task 7; and a separately approval-gated release-candidate workflow. A verified branch is eligible for `git push`, not public release.

- [ ] **Step 1: Write a failing release-smoke workflow assertion**

Extend the desktop release workflow test or `scripts/desktop-release-config.spec.ts` to require every native runner to run `generate:icons`, `verify:icons`, desktop package, `release:verify-desktop-artifacts`, packed CLI verification, standalone archive production then verification, the Task 7 updater checks, and the platform-appropriate Desktop smoke. Require the pull-request workflow to contain neither `npm publish`, `gh release create`, signing, notarization, or update-manifest upload. Extend `scripts/release/verify-update-manifests.spec.ts` with stable, beta, and nightly signed-manifest fixtures: each fixture contains only the expected channel artifact names, version ordering, checksums, signature reference, and rollback predecessor. Require a downgrade/rollback fixture to select the prior compatible signed stable artifact rather than a beta or nightly build and then drive the Task 7 staging consumer; tests use fake signatures and never contact a release service.

- [ ] **Step 2: Run the workflow check and observe missing end-to-end coverage**

Run:

```powershell
pnpm exec vitest run scripts/desktop-release-config.spec.ts
```

Expected: FAIL until the workflow executes all source, built, packaged, installed, offline-prefix, standalone, staged-update, and rollback acceptance layers, and until each update-channel fixture has signed-manifest and consumer validation.

- [ ] **Step 3: Add the non-publishing release smoke workflow**

On `windows-2025`, `macos-15`, and `ubuntu-24.04`, use frozen pnpm installation, build the repository, generate and verify icons, package only the current native target with `--publish never`, inspect its artifact, install and exercise the packed CLI, build then verify a fresh offline standalone archive, run the isolated Desktop Dashboard-to-Runtime smoke, and run Task 7's local staged update/rollback fixtures. Windows owns NSIS install/uninstall, macOS owns universal-DMG mount/copy/uninstall plus `lipo`, and Ubuntu owns AppImage and Deb install/removal; no job treats another platform's archive inspection as native evidence. Upload checked artifacts and redacted logs. Set workflow permissions to `contents: read`; do not configure signing, notarization, npm credentials, publication, update upload, or GitHub Release creation.

Create a separate manually dispatched `release-candidates.yml` workflow with an explicit required `approval` input for each external action: `sign-windows`, `notarize-macos`, `sign-update-manifests`, `publish-npm`, and `create-github-release`. It rejects blank or combined approvals, defaults every action to false, and never runs on a pull request. Stable, beta, and nightly select different immutable channel labels and update-manifest locations; all consume the same already-verified artifact matrix. Signing/notarization produce channel-specific signed update manifests only after their matching approval, verify signatures against fixtures before upload, and keep the last signed stable manifest/artifacts as the rollback target. `npm publish` and GitHub Release creation each require their own newly supplied approval and run only after package, native artifact, signature, update-manifest, and rollback verification. A rollback dispatch selects the retained prior signed stable release without publishing a new package or mutating `HARNESS_HOME`.

- [ ] **Step 4: Run the final local checks appropriate to the changed surfaces**

Run:

```powershell
pnpm run generate:icons
pnpm run verify:icons
pnpm exec vitest run scripts/generate-product-icons.spec.ts scripts/desktop-release-config.spec.ts apps/desktop/tests/icon-assets.spec.ts apps/desktop/tests/packaged-artifacts.spec.ts apps/web/tests/pwa-manifest.e2e.ts scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/built-bin.e2e.ts apps/cli/tests/packed-install.e2e.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm run build
pnpm run desktop:e2e
pnpm --filter @harness-desktop/dsh-desktop run package
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:smoke-installed-desktop
pnpm run release:verify-update-manifests
pnpm run release:test-cli-update
pnpm run desktop:test-updater
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

Expected: every command exits 0 on its supported local platform. Native installer artifacts for the other two operating systems are verified by the required native CI runners, not simulated from Windows. Update-manifest tests prove stable/beta/nightly routing, malicious-manifest rejection, staged acknowledgement, and rollback through local consumers and fixtures only; no local or PR command signs, notarizes, uploads, publishes, or creates a release.

- [ ] **Step 5: Review the final diff and push the verified branch**

Run:

```powershell
git status --short
git diff --check
git log --oneline --decorate codex/harness-desktop-design..HEAD
git push -u origin HEAD
```

Expected: the working tree is clean except for deliberate local release artifacts ignored by Git; the push occurs only after Step 4 succeeds. Stop after the push. Do not run signing, notarization, update upload, `npm publish`, `pnpm run release:publish`, or `gh release create`; each external action requires its separately renewed explicit approval.

## Plan self-review

- Spec coverage: Tasks 1–2 implement original editable B artwork, native icon provenance, and the deliberately Web-only light/dark favicon pair; Tasks 2–3 implement NSIS, universal DMG, AppImage, Deb, npm dependency-closure/offline-prefix checks, deterministic standalone Node archives, and target-native module checks; Task 4 consumes rather than redefines the primary CLI/Desktop entries and Desktop-owned ready acknowledgement; Task 5 proves shared Runtime state and safe client recovery through a host-side test package; Task 6 supplies bilingual installation, lifecycle, and visible legacy-import documentation; Task 7 implements local channel selection, verified staging, health acknowledgement, rollback, and npm-versus-archive CLI updates; Task 8 verifies native artifacts and approval-gated stable/beta/nightly release workflows before an authorized push.
- Error coverage: stale generated assets, invalid builder icon paths, missing native installers/icons, unavailable Runtime, idempotent absent lease release, uninstalled Desktop, concurrent session use, legacy-import collision/retry/failure, dependency closure, missing or mismatched bundled Node, foreign native modules, malicious update manifests, failed update acknowledgement, and rollback all have named expected diagnostics or owning tests.
- Type consistency: generated asset names, `desktopIconPath`, `verifyDesktopArtifacts`, CLI/Web-owned activation interfaces, the Desktop-host plan's exact ready acknowledgement, `CrossClientFixture`, `DesktopUpdateChannel`, and `DesktopUpdateService` are consumed only from their owning plans.
- Placeholder scan: no deferred implementation markers remain; every task identifies exact files, interfaces, red/green checks, and verification commands.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-18-harness-icon-packaging-docs.md`. Execute task-by-task with `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`; do not sign, notarize, upload update manifests, publish npm, or create a GitHub Release without the separate fresh approval named for that action.
