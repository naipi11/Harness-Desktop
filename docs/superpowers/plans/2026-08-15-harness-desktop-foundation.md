# Harness Desktop Brand and Application Foundation Implementation Plan

English | [中文](2026-08-15-harness-desktop-foundation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Harness Desktop product identity, primary `harness` command, compatible `dsh` entry, runnable secure Electron shell, source launch, and non-publishing three-platform packaging scaffold.

**Architecture:** One checked-in product metadata package supplies the brand and compatibility names to CLI and Desktop code. The CLI keeps the existing runtime and data namespace while exposing two thin executable entries; the Electron application contains isolated main, preload, shared-protocol, and renderer units but does not start the Harness Host until the Desktop minimum-loop workstream. Existing `web --daemon` and `web --background` work is merged before the command is branded.

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`, pnpm 11, TypeScript 6, Cordis, Commander, Electron, electron-vite, React 18, Vitest, Playwright, Electron Builder, GitHub Actions.

## Global Constraints

- The outward product name is `Harness Desktop`; the repository is `naipi11/Harness-Desktop`; the primary command is `harness`.
- `dsh` remains a compatibility binary backed by the same parser and runners; `$DSH_HOME` remains the only data namespace in this workstream.
- Internal `@deepseek-ai/dsh-*` packages keep their names; only centralized metadata and public-facing applications depend on the new brand.
- The Electron renderer uses `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and a typed preload API.
- This workstream delivers a launchable Desktop shell, not conversation, Host supervision, session leases, interactive CLI, signing, publishing, updating, or rollback.
- `harness web --daemon` and `harness web --background` work from built and source launches; help never detaches.
- Pull-request packaging may be unsigned but must use `--publish never`; no stable or public release workflow is enabled here.
- Every new user-visible string has a focused unit, e2e, or keyless snapshot assertion.
- Every authored document has an English file, Simplified Chinese counterpart, and recorded `.i18n.yaml` pair.

The approved program architecture is [Harness Desktop Product Architecture Design](../specs/2026-08-15-harness-desktop-design.md). This plan implements only its first delivery workstream.

---

### Task 1: Import the tested Web background-launch branch

**Files:**
- Merge: branch `feat/web-daemon` at `b8550d8b844701717f3da45168c627e9ed3ab8ac`
- Verify: `apps/cli/src/web-daemon.ts`
- Verify: `apps/cli/tests/web-daemon.spec.ts`
- Verify: `apps/cli/tests/web-daemon.compat.spec.ts`
- Verify: `apps/cli/tests/web-daemon.snapshot.ts`

**Interfaces:**
- Consumes: the existing CLI profile launch path and `resolveDshHome()`.
- Produces: `resolveWebDaemonInvocation(args)` and `launchWebDaemon(input, adapters?)`, with `--daemon` and `--background` as equivalent flags.

- [ ] **Step 1: Verify the source branch and merge base**

Run:

```powershell
git merge-base --is-ancestor 47f943859bef60e4160492346772ded9b24f765a feat/web-daemon
git log --oneline master..feat/web-daemon
```

Expected: the first command exits 0; the log ends at `b8550d8b8` and contains the eleven daemon commits.

- [ ] **Step 2: Merge the branch without rewriting its reviewed commits**

Run:

```powershell
git merge --no-ff feat/web-daemon -m "merge: integrate web background launch"
```

Expected: one merge commit; no conflict with the Harness Desktop spec or Agent Note.

- [ ] **Step 3: Run the focused lifecycle and compatibility tests**

Run:

```powershell
pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts packages/bundle/web-app/tests/startup.spec.ts
```

Expected: all tests pass, including log ownership, missing PID cleanup, source runtime arguments, and startup error precedence.

- [ ] **Step 4: Run the keyless daemon snapshot**

Run:

```powershell
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
```

Expected: the snapshot passes without `DEEPSEEK_API_KEY`.

- [ ] **Step 5: Verify the merge commit owns only the imported feature**

Run:

```powershell
git show --stat --oneline HEAD
git status --short
```

Expected: the merge commit is present and the worktree is clean.

### Task 2: Add the product metadata owner to app-boot

**Files:**
- Create under `packages/boot/app-boot/`: `product.json`
- Create under `packages/boot/app-boot/`: `src/product-metadata.ts`
- Create under `packages/boot/app-boot/`: `tests/product-metadata.spec.ts`
- Modify: `packages/boot/app-boot/package.json`
- Modify: `packages/boot/app-boot/tsdown.config.ts`
- Modify: `packages/boot/app-boot/README.md`
- Modify: `packages/boot/app-boot/README.zh.md`
- Modify: `packages/boot/app-boot/README.i18n.yaml`

**Interfaces:**
- Consumes: the existing app-boot package, its package-local build, and bilingual README conventions.
- Produces: the dependency-light `@deepseek-ai/dsh-app-boot/product-metadata` subpath with `ProductCommandName`, `ProductMetadata`, and frozen `productMetadata`.

- [ ] **Step 1: Write the failing metadata test**

Add a test to app-boot's `tests/product-metadata.spec.ts` that requires `productMetadata` to equal this object and requires `Object.isFrozen(productMetadata)` to be `true`:

```json
{
  "productName": "Harness Desktop",
  "commandName": "harness",
  "legacyCommandName": "dsh",
  "repository": "naipi11/Harness-Desktop",
  "repositoryUrl": "https://github.com/naipi11/Harness-Desktop",
  "appId": "io.github.naipi11.harness-desktop",
  "npmPackage": "@harness-desktop/cli",
  "dataNamespace": "dsh"
}
```

- [ ] **Step 2: Run the test and confirm the package is absent**

Run:

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
```

Expected: FAIL because `../src/product-metadata.ts` does not exist.

- [ ] **Step 3: Add the JSON source and typed export**

Create `product.json`:

```json
{
  "productName": "Harness Desktop",
  "commandName": "harness",
  "legacyCommandName": "dsh",
  "repository": "naipi11/Harness-Desktop",
  "repositoryUrl": "https://github.com/naipi11/Harness-Desktop",
  "appId": "io.github.naipi11.harness-desktop",
  "npmPackage": "@harness-desktop/cli",
  "dataNamespace": "dsh"
}
```

Create the public export:

```ts ignore-check
import metadata from '../product.json' with { type: 'json' }

/** Stable product names shared by launchers, clients, packaging, and verification. */
export interface ProductMetadata {
  readonly productName: string
  readonly commandName: string
  readonly legacyCommandName: string
  readonly repository: string
  readonly repositoryUrl: string
  readonly appId: string
  readonly npmPackage: string
  readonly dataNamespace: string
}

/** Command names accepted by the shared CLI implementation. */
export type ProductCommandName = 'harness' | 'dsh'

/** Frozen product metadata loaded from the package-owned JSON source. */
export const productMetadata: Readonly<ProductMetadata> = Object.freeze({ ...metadata })
```

- [ ] **Step 4: Add the package subpath and build entry**

Add these package exports and payload entries without changing app-boot's existing dependency graph:

```json
{
  "exports": {
    "./product-metadata": {
      "types": "./lib/types/product-metadata.d.ts",
      "default": "./lib/product-metadata.js"
    },
    "./product.json": "./product.json"
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/product-metadata.js",
    "lib/types/**/*.d.ts",
    "product.json"
  ]
}
```

Add `lib/types/product-metadata.js` to the package-local tsdown entries so the subpath exists in built releases.

- [ ] **Step 5: Run the focused package checks**

Run:

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run typecheck
```

Expected: the metadata test passes; package invariant and type checks pass.

- [ ] **Step 6: Write and record the package contract**

Document that this package owns only stable product identifiers, that `dataNamespace` deliberately remains `dsh`, and that runtime defaults do not belong here. Create the Chinese counterpart with identical structure, then run:

```powershell
pnpm run verify-translation-pairing --write packages/boot/app-boot/README.md
pnpm run verify-translation-pairing packages/boot/app-boot/README.md
```

Expected: one consistent bilingual pair.

- [ ] **Step 7: Commit the metadata package**

Run:

```powershell
git add packages/boot/app-boot
git diff --cached --check
git commit -m "feat(brand): centralize Harness Desktop product metadata"
```

### Task 3: Make `harness` primary and keep `dsh` compatible

**Files:**
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/src/dsh-bin.ts`
- Modify: `apps/cli/src/bin.ts`
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/src/plugin.ts`
- Modify: `apps/cli/src/web-daemon.ts`
- Modify: `apps/cli/tsdown.config.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tests/args.spec.ts`
- Modify: `apps/cli/tests/built-bin.e2e.ts`
- Modify: `apps/cli/tests/source-launch.compat.spec.ts`
- Modify: `apps/cli/tests/web-daemon.snapshot.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `productMetadata`, the existing `DshInvocation` command grammar, profile runners, and daemon launcher.
- Produces: `CliCommandName`, `runCli(commandName, argv?)`, built `lib/bin.js` for `harness`, built `lib/dsh-bin.js` for `dsh`, and matching source scripts.

- [ ] **Step 1: Write failing dual-name parser and built-entry assertions**

Extend the parser tests with a captured-output helper. Require `helpOutput('harness')` to contain `harness --profile web` and exclude `dsh --profile web`; require `helpOutput('dsh')` to contain `dsh --profile web`; require `parseDshArgs(['web'], '1.2.3', 'harness')` to equal `{ mode: 'profile', profile: 'web', patches: [], args: [] }`.

Extend built-bin coverage to assert that `lib/bin.js --help` names `harness`, `lib/dsh-bin.js --help` names `dsh`, and both resolve the same `web` invocation.

- [ ] **Step 2: Run the focused tests and observe the missing parameter and entry**

Run:

```powershell
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts
```

Expected: FAIL because `parseDshArgs` has no command-name parameter and `dsh-bin.ts` does not exist.

- [ ] **Step 3: Extract the shared command runner and add thin entries**

Define `CliCommandName` as `ProductCommandName` from `@deepseek-ai/dsh-app-boot/product-metadata` in `apps/cli/src/main.ts`. Export `runCli(commandName: CliCommandName, argv: readonly string[] = process.argv.slice(2)): Promise<void>`; it calls `parseDshArgs(argv, readVersion(), commandName)` and awaits `dispatchInvocation(commandName, invocation)`.

Keep version loading and the existing mode switch inside this module. Make `apps/cli/src/bin.ts` contain only `import { runCli } from './main.ts'` followed by `await runCli('harness')`. Make `apps/cli/src/dsh-bin.ts` contain the same import followed by `await runCli('dsh')`.

- [ ] **Step 4: Parameterize visible CLI prose without changing storage names**

Change `parseDshArgs` to accept `commandName: CliCommandName = 'harness'`, generate examples from that value, and use it for Commander names and errors. Pass `commandName` into plugin diagnostics and the detached-start success line. Continue calling `loadLayeredEnv('dsh')`, `resolveDshHome()`, and existing profile functions with the compatibility data namespace.

- [ ] **Step 5: Build both entries and expose both binary names**

Set the CLI package and build entries to:

```json
{
  "bin": {
    "harness": "lib/bin.js",
    "dsh": "lib/dsh-bin.js"
  }
}
```

```json
{
  "entry": ["lib/types/bin.js", "lib/types/dsh-bin.js"],
  "outDir": "lib",
  "format": ["esm"],
  "platform": "node",
  "target": "es2024",
  "fixedExtension": false,
  "dts": false,
  "clean": false
}
```

Pass that object to `defineConfig` in `apps/cli/tsdown.config.ts`.

Add root source scripts whose values are exactly:

```json
{
  "harness": "node --import tsx/esm apps/cli/src/bin.ts",
  "dsh": "node --import tsx/esm apps/cli/src/dsh-bin.ts"
}
```

- [ ] **Step 6: Run source, built, daemon, and snapshot verification**

Run:

```powershell
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/web-daemon.spec.ts
pnpm run build:lib:host
pnpm exec vitest run apps/cli/tests/built-bin.e2e.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
```

Expected: both names work; `harness` is primary; `dsh` keeps the same profile and data behavior; daemon snapshots pass.

- [ ] **Step 7: Commit the dual entry**

Run:

```powershell
git add apps/cli package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(cli): add primary harness command"
```

### Task 4: Build the sandboxed Electron application shell

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/shared/desktop-api.ts`
- Create: `apps/desktop/src/main/window-options.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/bridge.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/global.d.ts`
- Create: `apps/desktop/src/renderer/src/DesktopShell.tsx`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/styles.css`
- Create: `apps/desktop/tests/window-options.spec.ts`
- Create: `apps/desktop/tests/preload-bridge.spec.ts`
- Create: `apps/desktop/tests/desktop-shell.snapshot.tsx`
- Modify: `vitest.snapshot.config.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `productMetadata`, Electron main/preload APIs, React, and the existing repository test stack.
- Produces: `DesktopBridge.getProductMetadata()`, `createDesktopBridge(invoke)`, `createWindowOptions(preload)`, and the first assembled Desktop shell snapshot.

- [ ] **Step 1: Write failing window-security and preload-bridge tests**

Add assertions before creating implementation files. Require `createWindowOptions('C:\\app\\preload.js').webPreferences` to contain the same preload path plus `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Mock `invoke` to resolve `productMetadata`, require `createDesktopBridge(invoke).getProductMetadata()` to resolve that value, and require the call channel to equal `desktop:get-product-metadata`.

- [ ] **Step 2: Write the failing renderer snapshot**

Render the real component with `renderToStaticMarkup`:

```tsx
const html = renderToStaticMarkup(<DesktopShell metadata={productMetadata} />)
expect(html).toMatchInlineSnapshot(`
  "<main class=\"desktop-shell\"><header><p>Local coding agent</p><h1>Harness Desktop</h1></header><section aria-label=\"Workspace\"><p>Open a workspace to begin.</p></section></main>"
`)
```

- [ ] **Step 3: Run the new tests and confirm the files are absent**

Run:

```powershell
pnpm exec vitest run apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-shell.snapshot.tsx
```

Expected: FAIL because the Desktop modules and snapshot include pattern do not exist.

- [ ] **Step 4: Define the typed preload API**

Use one channel constant and one narrow bridge. `desktopChannels.productMetadata` is exactly `desktop:get-product-metadata`. `DesktopBridge` exposes only `getProductMetadata(): Promise<ProductMetadata>`. `DesktopInvoke` accepts only `typeof desktopChannels.productMetadata` and resolves `ProductMetadata`; `createDesktopBridge(invoke)` returns that one-method bridge.

The preload entry calls `contextBridge.exposeInMainWorld('harnessDesktop', createDesktopBridge(channel => ipcRenderer.invoke(channel)))`. The renderer global declaration exposes only `DesktopBridge`.

- [ ] **Step 5: Implement the secure BrowserWindow owner**

Implement `createWindowOptions(preload: string): Electron.BrowserWindowConstructorOptions` as a pure factory. It returns width `1280`, height `820`, minimum width `900`, minimum height `640`, `show: false`, title `productMetadata.productName`, and `webPreferences` containing the supplied preload path, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`.

The main entry registers only `desktopChannels.productMetadata`, calls `app.setAppUserModelId(productMetadata.appId)`, shows the window after `ready-to-show`, loads `ELECTRON_RENDERER_URL` only in development, and otherwise loads the built renderer file.

- [ ] **Step 6: Implement the renderer shell and styling**

`DesktopShell` accepts a required `metadata: ProductMetadata` prop and renders the exact snapshot text. The bootstrap component obtains metadata through `window.harnessDesktop.getProductMetadata()` and renders an explicit startup error when the Promise rejects. The renderer HTML declares `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws:` as its Content Security Policy. CSS provides a neutral light/dark foundation without copying ChatGPT, Claude, or Antigravity assets.

- [ ] **Step 7: Add package configuration and dependencies**

Set `apps/desktop/package.json` to `name: "@deepseek-ai/dsh-desktop"`, `version: "0.1.0-rc.5"`, `private: true`, `main: "out/main/index.js"`, and scripts `dev`, `build`, `typecheck`, `test`, and `test:e2e`. Add `@deepseek-ai/dsh-app-boot` as a workspace dependency and Electron, electron-vite, React 18, React DOM 18, Vite React plugin, TypeScript, Vitest, Playwright, and relevant type packages. Run the following after the manifest exists, add `electron: true` to `pnpm-workspace.yaml` `allowBuilds`, and extend `vitest.snapshot.config.ts` to include `apps/desktop/tests/**/*.snapshot.tsx`:

```powershell
pnpm --filter @deepseek-ai/dsh-desktop add '@deepseek-ai/dsh-app-boot@workspace:^' 'react@^18.2.0' 'react-dom@^18.2.0'
pnpm --filter @deepseek-ai/dsh-desktop add -D electron electron-vite electron-builder '@playwright/test' '@vitejs/plugin-react' vite typescript vitest '@types/react@~18.3.1' '@types/react-dom@~18.3.1'
```

- [ ] **Step 8: Run tests and commit the shell**

Run:

```powershell
pnpm install
pnpm exec vitest run apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-shell.snapshot.tsx
git add apps/desktop vitest.snapshot.config.ts pnpm-workspace.yaml pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(desktop): add sandboxed Electron shell"
```

Expected: the tests and snapshot pass before the commit.

### Task 5: Wire Desktop source launch, build, and Electron e2e

**Files:**
- Create: `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/tests/desktop-shell.e2e.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `scripts/clean.ts`

**Interfaces:**
- Consumes: the Desktop main/preload/renderer entries from Task 4.
- Produces: `pnpm desktop`, `desktop:build`, `desktop:test`, `desktop:e2e`, and a packaged-process e2e path that exercises the real preload bridge.

- [ ] **Step 1: Write the failing Electron e2e**

Create a Playwright Electron test that launches `../out/main/index.js` and always closes the application in `finally`. Require a visible `Harness Desktop` heading and `Open a workspace to begin.` text, require `typeof Reflect.get(window, 'require')` to equal `undefined`, require exactly one `meta[http-equiv="Content-Security-Policy"]`, and require `window.harnessDesktop.getProductMetadata()` to return `commandName: 'harness'` and `legacyCommandName: 'dsh'`.

- [ ] **Step 2: Run the e2e and confirm no built entry exists**

Run:

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run test:e2e
```

Expected: FAIL because `out/main/index.js` has not been built.

- [ ] **Step 3: Finish electron-vite build inputs and root scripts**

Use explicit entries in `electron.vite.config.ts`: main input `src/main/index.ts`, preload input `src/preload/index.ts`, renderer root `src/renderer`, and the React plugin. Do not rely on Electron Vite's filename inference.

Add root scripts:

```json
{
  "desktop": "pnpm --filter @deepseek-ai/dsh-desktop run dev",
  "desktop:build": "pnpm --filter @deepseek-ai/dsh-desktop run build",
  "desktop:test": "pnpm --filter @deepseek-ai/dsh-desktop run test",
  "desktop:e2e": "pnpm --filter @deepseek-ai/dsh-desktop run test:e2e"
}
```

- [ ] **Step 4: Include Desktop in aggregate build and cleanup ownership**

Make root `build` run `build:lib`, `build:web`, and `desktop:build`. Make root `typecheck` include the Desktop package typecheck after existing host/client checks. Extend `scripts/clean.ts` to remove only `apps/desktop/out`, `apps/desktop/release`, and `apps/desktop/test-results` through the script's existing validated-output mechanism.

- [ ] **Step 5: Build and run the real Electron test**

Run:

```powershell
pnpm run desktop:build
pnpm run desktop:e2e
pnpm run desktop:test
pnpm run typecheck
```

Expected: the built application opens, the preload bridge returns product metadata, and all commands exit 0.

- [ ] **Step 6: Commit source and build integration**

Run:

```powershell
git add apps/desktop package.json scripts/clean.ts vitest.snapshot.config.ts
git diff --cached --check
git commit -m "build(desktop): wire source and e2e launches"
```

### Task 6: Migrate public identity and rename the GitHub repository

**Files:**
- Create: `scripts/product-identity.ts`
- Create: `scripts/product-identity.spec.ts`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `apps/cli/README.md`
- Modify: `apps/cli/README.zh.md`
- Modify: `apps/cli/README.i18n.yaml`
- Modify: `apps/cli/reference/README.md`
- Modify: `apps/cli/reference/README.zh.md`
- Modify: `apps/cli/reference/README.i18n.yaml`
- Modify: `apps/cli/package.json`
- Modify: `apps/web/index.html`
- Modify: `apps/web/public/manifest.webmanifest`
- Modify: `apps/web/tests/pwa-manifest.e2e.ts`
- Modify: `apps/web/tests/assembled-boot.ts`
- Modify: `website/.vitepress/config.ts`
- Modify: `website/docs.ts`
- Modify: `apps/cli/config/agent-presets/cordis/agent.cordis.yml`
- Refresh: affected keyless CLI and Web expected outputs under `apps/cli/tests/` and `apps/web/tests/snapshots/`
- Modify: `package.json`

**Interfaces:**
- Consumes: `productMetadata`, the CLI dual entry, existing Web manifest/site configuration, and the authenticated `naipi11/deepseek-harness` fork.
- Produces: repository `naipi11/Harness-Desktop`, outward Harness Desktop prose and model identity, and `verify:product-identity` for drift detection.

- [ ] **Step 1: Write a failing identity verifier**

Define a pure collector and tests that require every exact owner/value pair:

| Owner | Required value |
| --- | --- |
| `rootReadme` | `productMetadata.productName` |
| `rootReadme` | `productMetadata.repositoryUrl` |
| `rootReadme` | `` `harness` `` |
| `cliManifest` | `"harness"` |
| `webHtml` | `<title>${productMetadata.productName}</title>` |
| `webManifest` | `"name": "${productMetadata.productName}"` |
| `websiteConfig` | `title: '${productMetadata.productName}'` |
| `agentPreset` | `productMetadata.productName` |

`collectProductIdentityViolations(files)` returns one diagnostic for each missing pair and no diagnostics when all pairs are present.

The filesystem entry reads only the six named owners above and fails on any returned violation.

- [ ] **Step 2: Run the verifier test and prove current branding fails**

Run:

```powershell
pnpm exec vitest run scripts/product-identity.spec.ts
```

Expected: FAIL because the implementation is absent and current owners still use DeepSeek Harness and `dsh` as the primary command.

- [ ] **Step 3: Rename the authenticated GitHub fork and update the remote**

Run:

```powershell
gh auth status
gh repo view naipi11/deepseek-harness --json nameWithOwner,url
gh repo rename Harness-Desktop --repo naipi11/deepseek-harness --yes
git remote set-url origin git@github.com:naipi11/Harness-Desktop.git
gh repo view naipi11/Harness-Desktop --json nameWithOwner,url
git remote -v
```

Expected: GitHub reports `naipi11/Harness-Desktop`; both origin URLs use the renamed repository. Stop this task without editing files if authentication or repository ownership fails.

- [ ] **Step 4: Replace outward names in their owning sources**

Update root README installation and source commands to lead with Harness Desktop and `harness`, with one compatibility note for `dsh`. During this workstream, document `npx --package @deepseek-ai/dsh harness web`; do not claim that `@harness-desktop/cli` is published. Update CLI README/reference commands the same way, while keeping `$DSH_HOME`, `dsh.profile`, and internal package identifiers unchanged. Set Web `<title>`, manifest `name`, manifest `short_name`, VitePress title/description/edit links, and public repository URLs from product metadata values. Replace the website's DeepSeek wordmark lockup with a text Harness Desktop lockup; do not invent a final logo asset.

- [ ] **Step 5: Update the model-visible product identity and its direct assertions**

Change the agent preset's product name to Harness Desktop without changing tool, safety, or runtime instructions. Update direct test assertions in `apps/web/tests/assembled-boot.ts` and related scenario inputs before refreshing derivative expected outputs.

- [ ] **Step 6: Refresh only the affected keyless expected outputs**

Run on PowerShell:

```powershell
$env:DSH_SNAPSHOT = 'refresh'
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/dsh-badge.snapshot.ts
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts
Remove-Item Env:DSH_SNAPSHOT
```

Expected: expected outputs change only where the outward product name or primary command is rendered.

- [ ] **Step 7: Run identity, focused behavior, and bilingual checks**

Run:

```powershell
pnpm run verify:product-identity
pnpm exec vitest run scripts/product-identity.spec.ts apps/web/tests/pwa-manifest.e2e.ts
pnpm run verify-translation-pairing --write README.md apps/cli/README.md apps/cli/reference/README.md
pnpm run verify-translation-pairing README.md apps/cli/README.md apps/cli/reference/README.md
pnpm run verify-public-repository-links
```

Expected: all checks pass against the renamed repository.

- [ ] **Step 8: Commit the public identity migration**

Run:

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli apps/web website scripts/product-identity.ts scripts/product-identity.spec.ts package.json
git diff --cached --check
git commit -m "feat(brand): adopt Harness Desktop public identity"
```

### Task 7: Add non-publishing desktop packaging CI

**Files:**
- Create: `apps/desktop/electron-builder.config.mjs`
- Create: `scripts/desktop-release-config.ts`
- Create: `scripts/desktop-release-config.spec.ts`
- Create: `.github/workflows/desktop-artifacts.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `scripts/run-gates.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `product.json`, built Electron output, and native GitHub Actions runners.
- Produces: validated Windows NSIS, macOS universal DMG, Linux AppImage/DEB configuration, unsigned pull-request artifacts with publishing disabled, and a pack-only legacy dsh workflow.

- [ ] **Step 1: Write failing release-config assertions**

Create tests that load the config and require:

```json
{
  "appId": "io.github.naipi11.harness-desktop",
  "productName": "Harness Desktop",
  "publish": null,
  "win": { "target": ["nsis"] },
  "mac": { "target": [{ "target": "dmg", "arch": ["universal"] }] },
  "linux": { "target": ["AppImage", "deb"] }
}
```

Also assert that the Desktop workflow text contains `--publish never`, `windows-2025`, `macos-15`, and `ubuntu-24.04`, and contains no npm or GitHub release publishing command. Assert that the legacy `.github/workflows/release.yml` contains no `release:publish` invocation or `NODE_AUTH_TOKEN`.

- [ ] **Step 2: Run the test and confirm configuration is missing**

Run:

```powershell
pnpm exec vitest run scripts/desktop-release-config.spec.ts
```

Expected: FAIL because the builder config and workflow do not exist.

- [ ] **Step 3: Add the Electron Builder configuration**

Import `product.json` with a JSON import attribute and export:

```js
export default {
  appId: productMetadata.appId,
  productName: productMetadata.productName,
  executableName: 'harness-desktop',
  directories: { output: 'release' },
  files: ['out/**', 'package.json'],
  asar: true,
  publish: null,
  win: { target: ['nsis'] },
  mac: { target: [{ target: 'dmg', arch: ['universal'] }], category: 'public.app-category.developer-tools' },
  linux: { target: ['AppImage', 'deb'], category: 'Development' },
}
```

Add `package` and `package:dir` scripts to the Desktop manifest; both pass `--publish never`.

- [ ] **Step 4: Add the native-runner artifact workflow**

The workflow runs on pull requests and manual dispatch, uses Node 24 and frozen pnpm install, builds Desktop, packages only the runner's native targets, and uploads `apps/desktop/release/*`. It grants `contents: read`, declares no environment, receives no signing or npm secret, and never creates a GitHub Release.

Rename the existing release workflow to a legacy dsh pack audit in its displayed name, remove its `publish` input and complete `publish` job, and keep the credential-free pack/install verification job. This prevents the fork from publishing upstream-scoped packages while their names remain internal.

- [ ] **Step 5: Add the static release-config verifier to repository gates**

`scripts/desktop-release-config.ts` loads product metadata, builder config, Desktop manifest, and workflow text. It rejects mismatched app ID, product name, executable name, repository owner/name, target matrix, or any publishing mode other than `never`. Add `verify:desktop-release-config` to root scripts and the artifact gate in `scripts/run-gates.ts`.

- [ ] **Step 6: Run config tests and a local unpacked build**

Run:

```powershell
pnpm install
pnpm exec vitest run scripts/desktop-release-config.spec.ts
pnpm run verify:desktop-release-config
pnpm run desktop:build
pnpm --filter @deepseek-ai/dsh-desktop run package:dir
```

Expected: tests and verifier pass; the current platform produces an unpacked app under `apps/desktop/release` without publishing.

- [ ] **Step 7: Commit packaging scaffolding**

Run:

```powershell
git add apps/desktop/electron-builder.config.mjs apps/desktop/package.json .github/workflows/desktop-artifacts.yml .github/workflows/release.yml scripts/desktop-release-config.ts scripts/desktop-release-config.spec.ts scripts/run-gates.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "build(desktop): add non-publishing artifact matrix"
```

### Task 8: Document and verify the foundation milestone

**Files:**
- Create: `apps/desktop/README.md`
- Create: `apps/desktop/README.zh.md`
- Create: `apps/desktop/README.i18n.yaml`

**Interfaces:**
- Consumes: every deliverable and command from Tasks 1-7 plus the repository documentation and pre-push workflows.
- Produces: a package-level Desktop contract and fresh verification evidence for the foundation branch.

- [ ] **Step 1: Write the Desktop package contract and Chinese counterpart**

Document the main/preload/renderer responsibilities, source and built commands, security settings, output directories, package targets, test commands, and the explicit limitation that the Host and conversation loop are absent from this milestone. Do not present unsigned artifact CI as a stable release.

- [ ] **Step 2: Record and validate the Desktop bilingual pair**

Run:

```powershell
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing apps/desktop/README.md
```

Expected: the Desktop README pair passes.

- [ ] **Step 3: Run the focused behavior and snapshot suite**

Run:

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts scripts/product-identity.spec.ts scripts/desktop-release-config.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts apps/cli/tests/dsh-badge.snapshot.ts apps/desktop/tests/desktop-shell.snapshot.tsx
pnpm run desktop:build
pnpm run desktop:e2e
```

Expected: all focused tests, snapshots, Desktop build, and Electron e2e pass.

- [ ] **Step 4: Run repository checks matched to the changed surfaces**

Run:

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

Expected: every command exits 0. Do not substitute the full test or coverage suite for these focused checks.

- [ ] **Step 5: Commit the milestone documentation and inspect the branch**

Run:

```powershell
git add apps/desktop/README.md apps/desktop/README.zh.md apps/desktop/README.i18n.yaml
git diff --cached --check
git commit -m "docs(desktop): document the application foundation"
git status --short
git log --oneline --decorate codex/harness-desktop-design..HEAD
```

Expected: the worktree is clean and the branch contains the imported daemon merge plus one reviewable commit for each foundation task.
