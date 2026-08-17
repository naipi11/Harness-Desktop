# Harness Desktop 品牌与应用基础实施计划

[English](2026-08-15-harness-desktop-foundation.md) | 中文

> **供 agent 工作进程使用：** 必须使用子 skill：推荐 superpowers:subagent-driven-development，也可以使用 superpowers:executing-plans，逐项执行本计划。各步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 建立 Harness Desktop 产品身份、主命令 `harness`、兼容入口 `dsh`、可运行且安全的 Electron 壳、源码启动方式，以及不发布产物的三平台打包脚手架。

**架构：** 一个已检入的产品元数据包向 CLI 与 Desktop 代码提供品牌名称和兼容名称。CLI 保留现有运行时和数据命名空间，同时暴露两个轻量可执行入口；Electron 应用包含相互隔离的主进程、preload、共享协议和 Renderer 单元，但 Harness Host 要到 Desktop 最小闭环工作流才启动。现有 `web --daemon` 与 `web --background` 工作在命令品牌化之前合并。

**技术栈：** Node.js `^22.19.0 || >=24.0.0`、pnpm 11、TypeScript 6、Cordis、Commander、Electron、electron-vite、React 18、Vitest、Playwright、Electron Builder、GitHub Actions。

## 全局约束

- 对外产品名称为 `Harness Desktop`；仓库为 `naipi11/Harness-Desktop`；主命令为 `harness`。
- `dsh` 继续作为兼容二进制并使用相同解析器和运行器；本工作流只使用 `$DSH_HOME` 这一套数据命名空间。
- 内部 `@deepseek-ai/dsh-*` 包保留现有名称；只有集中式元数据与面向公众的应用依赖新品牌。
- Electron Renderer 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和强类型 preload API。
- 本工作流交付可启动的 Desktop 壳，不交付对话、Host 监管、会话租约、交互式 CLI、签名、发布、更新或回滚。
- `harness web --daemon` 与 `harness web --background` 在构建版和源码启动中都可用；help 绝不进入后台。
- PR 打包可以不签名，但必须使用 `--publish never`；本工作流不启用稳定版或公开发布流程。
- 每个新增用户可见字符串都有聚焦的单元测试、e2e 或无密钥快照断言。
- 每份人工编写文档都有英文文件、简体中文对侧文件和已记录的 `.i18n.yaml` 配对。

已确认的项目群架构见 [Harness Desktop Product Architecture Design](../specs/2026-08-15-harness-desktop-design.md)。本计划只实现其中的第一个交付工作流。

---

### Task 1：导入已测试的 Web 后台启动分支

**文件：**
- 合并：分支 `feat/web-daemon`，HEAD 为 `b8550d8b844701717f3da45168c627e9ed3ab8ac`
- 验证：`apps/cli/src/web-daemon.ts`
- 验证：`apps/cli/tests/web-daemon.spec.ts`
- 验证：`apps/cli/tests/web-daemon.compat.spec.ts`
- 验证：`apps/cli/tests/web-daemon.snapshot.ts`

**接口：**
- 使用：现有 CLI profile 启动路径和 `resolveDshHome()`。
- 产出：`resolveWebDaemonInvocation(args)` 与 `launchWebDaemon(input, adapters?)`，其中 `--daemon` 和 `--background` 完全等价。

- [ ] **Step 1：验证源分支和合并基线**

运行：

```powershell
git merge-base --is-ancestor 47f943859bef60e4160492346772ded9b24f765a feat/web-daemon
git log --oneline master..feat/web-daemon
```

预期：第一条命令以 0 退出；日志结束于 `b8550d8b8`，并包含 11 个 daemon 提交。

- [ ] **Step 2：合并分支，不重写已经评审的提交**

运行：

```powershell
git merge --no-ff feat/web-daemon -m "merge: integrate web background launch"
```

预期：产生一个合并提交；与 Harness Desktop spec 或 Agent Note 均无冲突。

- [ ] **Step 3：运行聚焦的生命周期与兼容性测试**

运行：

```powershell
pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts packages/bundle/web-app/tests/startup.spec.ts
```

预期：全部测试通过，包括日志所有权、缺失 PID 清理、源码运行时参数和启动错误优先级。

- [ ] **Step 4：运行无密钥 daemon 快照**

运行：

```powershell
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
```

预期：不设置 `DEEPSEEK_API_KEY` 即可通过快照。

- [ ] **Step 5：验证合并提交只包含导入的功能**

运行：

```powershell
git show --stat --oneline HEAD
git status --short
```

预期：合并提交存在，工作树干净。

### Task 2：在 app-boot 中添加产品元数据 owner

**文件：**
- 在 `packages/boot/app-boot/` 下新建：`product.json`
- 在 `packages/boot/app-boot/` 下新建：`src/product-metadata.ts`
- 在 `packages/boot/app-boot/` 下新建：`tests/product-metadata.spec.ts`
- 修改：`packages/boot/app-boot/package.json`
- 修改：`packages/boot/app-boot/tsdown.config.ts`
- 修改：`packages/boot/app-boot/README.md`
- 修改：`packages/boot/app-boot/README.zh.md`
- 修改：`packages/boot/app-boot/README.i18n.yaml`

**接口：**
- 使用：现有 app-boot 包、其包级构建和双语 README 约定。
- 产出：低依赖的 `@deepseek-ai/dsh-app-boot/product-metadata` 子路径，以及 `ProductCommandName`、`ProductMetadata` 和冻结的 `productMetadata`。

- [ ] **Step 1：编写失败的元数据测试**

在 app-boot 的 `tests/product-metadata.spec.ts` 中加入测试，要求 `productMetadata` 等于以下对象，并要求 `Object.isFrozen(productMetadata)` 为 `true`：

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

- [ ] **Step 2：运行测试并确认包尚不存在**

运行：

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
```

预期：FAIL，因为 `../src/product-metadata.ts` 尚不存在。

- [ ] **Step 3：添加 JSON 真源和强类型导出**

创建 `product.json`：

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

创建公开导出：

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

- [ ] **Step 4：添加包子路径和构建入口**

添加以下 package export 和 payload 条目，不改变 app-boot 现有依赖图：

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

把 `lib/types/product-metadata.js` 加入包级 tsdown entries，使该子路径存在于构建版发布中。

- [ ] **Step 5：运行聚焦的包检查**

运行：

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run typecheck
```

预期：元数据测试通过；包不变式与类型检查通过。

- [ ] **Step 6：编写并记录包约定**

文档应说明此包只负责稳定产品标识符，`dataNamespace` 有意保留为 `dsh`，运行时默认值不属于此包。创建结构相同的中文对侧文件，然后运行：

```powershell
pnpm run verify-translation-pairing --write packages/boot/app-boot/README.md
pnpm run verify-translation-pairing packages/boot/app-boot/README.md
```

预期：形成一个一致的双语配对。

- [ ] **Step 7：提交元数据包**

运行：

```powershell
git add packages/boot/app-boot
git diff --cached --check
git commit -m "feat(brand): centralize Harness Desktop product metadata"
```

### Task 3：把 `harness` 设为主命令并保留 `dsh` 兼容

**文件：**
- 新建：`apps/cli/src/main.ts`
- 新建：`apps/cli/src/dsh-bin.ts`
- 修改：`apps/cli/src/bin.ts`
- 修改：`apps/cli/src/args.ts`
- 修改：`apps/cli/src/plugin.ts`
- 修改：`apps/cli/src/web-daemon.ts`
- 修改：`apps/cli/tsdown.config.ts`
- 修改：`apps/cli/package.json`
- 修改：`apps/cli/tests/args.spec.ts`
- 修改：`apps/cli/tests/built-bin.e2e.ts`
- 修改：`apps/cli/tests/source-launch.compat.spec.ts`
- 修改：`apps/cli/tests/web-daemon.snapshot.ts`
- 修改：`package.json`

**接口：**
- 使用：`productMetadata`、现有 `DshInvocation` 命令语法、profile 运行器和 daemon 启动器。
- 产出：`CliCommandName`、`runCli(commandName, argv?)`、供 `harness` 使用的 `lib/bin.js`、供 `dsh` 使用的 `lib/dsh-bin.js`，以及匹配的源码脚本。

- [ ] **Step 1：编写失败的双名称解析器和构建入口断言**

扩展解析器测试并加入捕获输出的 helper。要求 `helpOutput('harness')` 包含 `harness --profile web` 且不含 `dsh --profile web`；要求 `helpOutput('dsh')` 包含 `dsh --profile web`；要求 `parseDshArgs(['web'], '1.2.3', 'harness')` 等于 `{ mode: 'profile', profile: 'web', patches: [], args: [] }`。

扩展 built-bin 覆盖，断言 `lib/bin.js --help` 使用 `harness`，`lib/dsh-bin.js --help` 使用 `dsh`，两者解析出相同的 `web` 调用。

- [ ] **Step 2：运行聚焦测试并观察缺少参数和入口**

运行：

```powershell
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts
```

预期：FAIL，因为 `parseDshArgs` 尚无 command-name 参数，`dsh-bin.ts` 也不存在。

- [ ] **Step 3：提取共享命令运行器并添加轻量入口**

在 `apps/cli/src/main.ts` 中把 `CliCommandName` 定义为 `@deepseek-ai/dsh-app-boot/product-metadata` 导出的 `ProductCommandName`。导出 `runCli(commandName: CliCommandName, argv: readonly string[] = process.argv.slice(2)): Promise<void>`；它调用 `parseDshArgs(argv, readVersion(), commandName)`，再等待 `dispatchInvocation(commandName, invocation)`。

版本读取和现有 mode switch 保留在该模块中。让 `apps/cli/src/bin.ts` 只包含 `import { runCli } from './main.ts'`，随后执行 `await runCli('harness')`。让 `apps/cli/src/dsh-bin.ts` 包含相同 import，随后执行 `await runCli('dsh')`。

- [ ] **Step 4：参数化可见 CLI 正文，但不改变存储名称**

让 `parseDshArgs` 接受 `commandName: CliCommandName = 'harness'`，根据该值生成示例，并将它用于 Commander 名称和错误。把 `commandName` 传给插件诊断和 detached 启动成功提示。继续用兼容数据命名空间调用 `loadLayeredEnv('dsh')`、`resolveDshHome()` 和现有 profile 函数。

- [ ] **Step 5：构建两个入口并暴露两个二进制名称**

把 CLI 包和构建入口设为：

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

在 `apps/cli/tsdown.config.ts` 中把该对象传给 `defineConfig`。

添加值严格如下的根目录源码脚本：

```json
{
  "harness": "node --import tsx/esm apps/cli/src/bin.ts",
  "dsh": "node --import tsx/esm apps/cli/src/dsh-bin.ts"
}
```

- [ ] **Step 6：运行源码、构建版、daemon 和快照验证**

运行：

```powershell
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/web-daemon.spec.ts
pnpm run build:lib:host
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/built-bin.e2e.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
```

预期：两个名称均可用；`harness` 为主名称；`dsh` 保持相同 profile 和数据行为；daemon 快照通过。

- [ ] **Step 7：提交双入口**

运行：

```powershell
git add apps/cli package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(cli): add primary harness command"
```

### Task 4：构建沙箱化 Electron 应用壳

**文件：**
- 新建：`apps/desktop/package.json`
- 新建：`apps/desktop/tsconfig.json`
- 新建：`apps/desktop/electron.vite.config.ts`
- 新建：`apps/desktop/src/shared/desktop-api.ts`
- 新建：`apps/desktop/src/main/window-options.ts`
- 新建：`apps/desktop/src/main/index.ts`
- 新建：`apps/desktop/src/preload/bridge.ts`
- 新建：`apps/desktop/src/preload/index.ts`
- 新建：`apps/desktop/src/renderer/index.html`
- 新建：`apps/desktop/src/renderer/src/global.d.ts`
- 新建：`apps/desktop/src/renderer/src/DesktopShell.tsx`
- 新建：`apps/desktop/src/renderer/src/main.tsx`
- 新建：`apps/desktop/src/renderer/src/styles.css`
- 新建：`apps/desktop/tests/window-options.spec.ts`
- 新建：`apps/desktop/tests/preload-bridge.spec.ts`
- 新建：`apps/desktop/tests/desktop-shell.snapshot.tsx`
- 修改：`vitest.snapshot.config.ts`
- 修改：`pnpm-workspace.yaml`
- 修改：`pnpm-lock.yaml`

**接口：**
- 使用：`productMetadata`、Electron main/preload API、React 和现有仓库测试栈。
- 产出：`DesktopBridge.getProductMetadata()`、`createDesktopBridge(invoke)`、`createWindowOptions(preload)` 和首个组装后的 Desktop 壳快照。

- [ ] **Step 1：编写失败的窗口安全与 preload bridge 测试**

在创建实现文件之前加入断言。要求 `createWindowOptions('C:\\app\\preload.js').webPreferences` 包含相同 preload 路径，以及 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`。mock `invoke` 使其返回 `productMetadata`，要求 `createDesktopBridge(invoke).getProductMetadata()` resolve 为该值，并要求调用 channel 等于 `desktop:get-product-metadata`。

- [ ] **Step 2：编写失败的 Renderer 快照**

用 `renderToStaticMarkup` 渲染真实组件：

```tsx
const html = renderToStaticMarkup(<DesktopShell metadata={productMetadata} />)
expect(html).toMatchInlineSnapshot(`
  "<main class=\"desktop-shell\"><header><p>Local coding agent</p><h1>Harness Desktop</h1></header><section aria-label=\"Workspace\"><p>Open a workspace to begin.</p></section></main>"
`)
```

- [ ] **Step 3：运行新测试并确认文件尚不存在**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-shell.snapshot.tsx
```

预期：FAIL，因为 Desktop 模块和 snapshot include pattern 尚不存在。

- [ ] **Step 4：定义强类型 preload API**

使用一个 channel 常量和一个收窄 bridge。`desktopChannels.productMetadata` 必须精确等于 `desktop:get-product-metadata`。`DesktopBridge` 只公开 `getProductMetadata(): Promise<ProductMetadata>`。`DesktopInvoke` 只接受 `typeof desktopChannels.productMetadata` 并 resolve `ProductMetadata`；`createDesktopBridge(invoke)` 返回该单方法 bridge。

preload 入口调用 `contextBridge.exposeInMainWorld('harnessDesktop', createDesktopBridge(channel => ipcRenderer.invoke(channel)))`。Renderer 全局声明只暴露 `DesktopBridge`。

- [ ] **Step 5：实现安全 BrowserWindow 所有者**

把 `createWindowOptions(preload: string): Electron.BrowserWindowConstructorOptions` 实现为纯 factory。它返回宽 `1280`、高 `820`、最小宽度 `900`、最小高度 `640`、`show: false`、标题 `productMetadata.productName`，以及包含给定 preload 路径、`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true` 的 `webPreferences`。

主进程入口只注册 `desktopChannels.productMetadata`，调用 `app.setAppUserModelId(productMetadata.appId)`，在 `ready-to-show` 后显示窗口，只在开发环境加载 `ELECTRON_RENDERER_URL`，其他情况加载已构建的 Renderer 文件。

- [ ] **Step 6：实现 Renderer 壳和样式**

`DesktopShell` 接受必需的 `metadata: ProductMetadata` prop，并渲染与快照完全一致的文本。bootstrap 组件通过 `window.harnessDesktop.getProductMetadata()` 获取元数据，并在 Promise 被拒绝时渲染明确的启动错误。Renderer HTML 把 `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws:` 声明为 Content Security Policy。CSS 提供中性的明暗主题基础，不复制 ChatGPT、Claude 或 Antigravity 资产。

- [ ] **Step 7：添加包配置与依赖**

把 `apps/desktop/package.json` 设为 `name: "@deepseek-ai/dsh-desktop"`、`version: "0.1.0-rc.5"`、`private: true`、`main: "out/main/index.js"`，并提供 `dev`、`build`、`typecheck`、`test` 和 `test:e2e` 脚本。添加 `@deepseek-ai/dsh-app-boot` workspace 依赖，以及 Electron、electron-vite、React 18、React DOM 18、Vite React plugin、TypeScript、Vitest、Playwright 和相关类型包。在 manifest 存在后运行以下命令，在 `pnpm-workspace.yaml` 的 `allowBuilds` 中加入 `electron: true`，并扩展 `vitest.snapshot.config.ts` 使其包含 `apps/desktop/tests/**/*.snapshot.tsx`：

```powershell
pnpm --filter @deepseek-ai/dsh-desktop add '@deepseek-ai/dsh-app-boot@workspace:^' 'react@^18.2.0' 'react-dom@^18.2.0'
pnpm --filter @deepseek-ai/dsh-desktop add -D electron electron-vite electron-builder '@playwright/test' '@vitejs/plugin-react' 'vite@^7.0.0' typescript vitest '@types/react@~18.3.1' '@types/react-dom@~18.3.1'
```

- [ ] **Step 8：运行测试并提交应用壳**

运行：

```powershell
pnpm install
pnpm exec vitest run apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-shell.snapshot.tsx
git add apps/desktop vitest.snapshot.config.ts pnpm-workspace.yaml pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(desktop): add sandboxed Electron shell"
```

预期：测试和快照在提交前通过。

### Task 5：接通 Desktop 源码启动、构建和 Electron e2e

**文件：**
- 新建：`apps/desktop/playwright.config.ts`
- 新建：`apps/desktop/tests/desktop-shell.e2e.ts`
- 修改：`apps/desktop/electron.vite.config.ts`
- 修改：`apps/desktop/package.json`
- 修改：`package.json`
- 修改：`scripts/clean.ts`

**接口：**
- 使用：Task 4 的 Desktop 主进程、preload 和 Renderer 入口。
- 产出：`pnpm desktop`、`desktop:build`、`desktop:test`、`desktop:e2e`，以及运行真实 preload bridge 的已构建进程 e2e 路径。

- [ ] **Step 1：编写失败的 Electron e2e**

创建 Playwright Electron 测试，启动 `../out/main/index.js`，并始终在 `finally` 中关闭应用。要求 `Harness Desktop` 标题和 `Open a workspace to begin.` 文字可见，要求 `typeof Reflect.get(window, 'require')` 等于 `undefined`，要求正好存在一个 `meta[http-equiv="Content-Security-Policy"]`，并要求 `window.harnessDesktop.getProductMetadata()` 返回 `commandName: 'harness'` 和 `legacyCommandName: 'dsh'`。

- [ ] **Step 2：运行 e2e 并确认没有构建入口**

运行：

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run test:e2e
```

预期：FAIL，因为 `out/main/index.js` 尚未构建。

- [ ] **Step 3：完成 electron-vite 构建输入和根脚本**

在 `electron.vite.config.ts` 中使用明确入口：main input 为 `src/main/index.ts`，preload input 为 `src/preload/index.ts`，renderer root 为 `src/renderer`，并启用 React plugin。不要依赖 Electron Vite 的文件名推断。

添加根脚本：

```json
{
  "desktop": "pnpm --filter @deepseek-ai/dsh-desktop run dev",
  "desktop:build": "pnpm --filter @deepseek-ai/dsh-desktop run build",
  "desktop:test": "pnpm --filter @deepseek-ai/dsh-desktop run test",
  "desktop:e2e": "pnpm --filter @deepseek-ai/dsh-desktop run test:e2e"
}
```

- [ ] **Step 4：把 Desktop 纳入聚合构建和清理所有权**

让根 `build` 运行 `build:lib`、`build:web` 和 `desktop:build`。让根 `typecheck` 在现有 host/client 检查后包含 Desktop 包类型检查。扩展 `scripts/clean.ts`，仅通过脚本现有的已验证输出机制删除 `apps/desktop/out`、`apps/desktop/release` 和 `apps/desktop/test-results`。

- [ ] **Step 5：构建并运行真实 Electron 测试**

运行：

```powershell
pnpm run desktop:build
pnpm run desktop:e2e
pnpm run desktop:test
pnpm run typecheck
```

预期：已构建应用打开，preload bridge 返回产品元数据，全部命令以 0 退出。

- [ ] **Step 6：提交源码与构建集成**

运行：

```powershell
git add apps/desktop package.json scripts/clean.ts vitest.snapshot.config.ts
git diff --cached --check
git commit -m "build(desktop): wire source and e2e launches"
```

### Task 6：迁移公共身份并重命名 GitHub 仓库

**文件：**
- 新建：`scripts/product-identity.ts`
- 新建：`scripts/product-identity.spec.ts`
- 修改：`README.md`
- 修改：`README.zh.md`
- 修改：`README.i18n.yaml`
- 修改：`apps/cli/README.md`
- 修改：`apps/cli/README.zh.md`
- 修改：`apps/cli/README.i18n.yaml`
- 修改：`apps/cli/reference/README.md`
- 修改：`apps/cli/reference/README.zh.md`
- 修改：`apps/cli/reference/README.i18n.yaml`
- 修改：`apps/cli/package.json`
- 修改：`apps/web/index.html`
- 修改：`apps/web/public/manifest.webmanifest`
- 修改：`apps/web/tests/pwa-manifest.e2e.ts`
- 修改：`apps/web/tests/assembled-boot.ts`
- 修改：`website/.vitepress/config.ts`
- 修改：`website/docs.ts`
- 修改：`apps/cli/config/agent-presets/cordis/agent.cordis.yml`
- 刷新：`apps/cli/tests/` 与 `apps/web/tests/snapshots/` 下受影响的无密钥 CLI 和 Web 预期输出
- 修改：`package.json`

**接口：**
- 使用：`productMetadata`、CLI 双入口、现有 Web manifest/site 配置，以及已认证的 `naipi11/deepseek-harness` fork。
- 产出：仓库 `naipi11/Harness-Desktop`、对外 Harness Desktop 正文与模型身份，以及用于防止漂移的 `verify:product-identity`。

- [x] **Step 1：编写失败的身份验证器**

定义纯 collector 和测试，要求每组精确的 owner/value：

| Owner | 必需值 |
| --- | --- |
| `rootReadme` | `productMetadata.productName` |
| `rootReadme` | `productMetadata.repositoryUrl` |
| `rootReadme` | `` `harness` `` |
| `cliManifest` | `"harness"` |
| `webHtml` | `<title>${productMetadata.productName}</title>` |
| `webManifest` | `"name": "${productMetadata.productName}"` |
| `websiteConfig` | `title: '${productMetadata.productName}'` |
| `agentPreset` | `productMetadata.productName` |

`collectProductIdentityViolations(files)` 为每组缺失的配对返回一条诊断；所有配对存在时不返回诊断。

文件系统入口只读取上面六个具名 owner，并在返回任一 violation 时失败。

- [x] **Step 2：运行验证器测试并证明当前品牌不通过**

运行：

```powershell
pnpm exec vitest run scripts/product-identity.spec.ts
```

预期：FAIL，因为实现尚不存在，当前 owner 仍把 DeepSeek Harness 与 `dsh` 作为主名称。

- [x] **Step 3：重命名已认证 GitHub fork 并更新 remote**

运行：

```powershell
gh auth status
gh repo view naipi11/deepseek-harness --json nameWithOwner,url
gh repo rename Harness-Desktop --repo naipi11/deepseek-harness --yes
git remote set-url origin git@github.com:naipi11/Harness-Desktop.git
gh repo view naipi11/Harness-Desktop --json nameWithOwner,url
git remote -v
```

预期：GitHub 报告 `naipi11/Harness-Desktop`；origin 的 fetch/push URL 都使用已重命名仓库。如果认证或仓库所有权失败，停止本任务且不编辑文件。

- [x] **Step 4：在所属真源中替换对外名称**

更新根 README 的安装和源码命令，使其以 Harness Desktop 与 `harness` 为主，并只为 `dsh` 保留一条兼容说明。本工作流期间将 CLI 以 `@harness-desktop/cli` 发布，并保留 `dsh` 作为兼容命令名。以相同方式更新 CLI README/reference 命令，同时保持 `$DSH_HOME`、`dsh.profile` 和内部包标识符不变。根据产品元数据更新 Web `<title>`、manifest `name`、manifest `short_name`、VitePress title/description/edit link 和公共仓库 URL。把网站 DeepSeek wordmark lockup 替换为 Harness Desktop 文字 lockup；不要虚构最终 logo 资产。

- [x] **Step 5：更新模型可见产品身份及其直接断言**

把 agent preset 的产品名称改为 Harness Desktop，不改变工具、安全或运行时指令。先更新 `apps/web/tests/assembled-boot.ts` 中的直接测试断言和相关场景输入，再刷新派生预期输出。

- [x] **Step 6：只刷新受影响的无密钥预期输出**

在 PowerShell 中运行：

```powershell
$env:DSH_SNAPSHOT = 'refresh'
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/dsh-badge.snapshot.ts
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/pwa-manifest.e2e.ts apps/web/tests/built-boot.snapshot.ts apps/web/tests/image-display.snapshot.ts apps/web/tests/max-tokens-notice.snapshot.ts apps/web/tests/search-card.snapshot.ts apps/web/tests/todo-row.snapshot.ts
Remove-Item Env:DSH_SNAPSHOT
```

预期：只有渲染对外产品名称或主命令的预期输出发生变化。

- [x] **Step 7：运行身份、聚焦行为和双语检查**

运行：

```powershell
pnpm run verify:product-identity
pnpm exec vitest run scripts/product-identity.spec.ts apps/web/tests/pwa-manifest.e2e.ts
pnpm run verify-translation-pairing --write README.md apps/cli/README.md apps/cli/reference/README.md
pnpm run verify-translation-pairing README.md apps/cli/README.md apps/cli/reference/README.md
pnpm run verify-public-repository-links
```

预期：全部检查针对已重命名仓库通过。

- [x] **Step 8：提交公共身份迁移**

运行：

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli apps/web website scripts/product-identity.ts scripts/product-identity.spec.ts package.json
git diff --cached --check
git commit -m "feat(brand): adopt Harness Desktop public identity"
```

### Task 7：添加不发布产物的 Desktop 打包 CI

**文件：**
- 新建：`apps/desktop/electron-builder.config.mjs`
- 新建：`scripts/desktop-release-config.ts`
- 新建：`scripts/desktop-release-config.spec.ts`
- 新建：`.github/workflows/desktop-artifacts.yml`
- 修改：`.github/workflows/release.yml`
- 修改：`apps/desktop/package.json`
- 修改：`package.json`
- 修改：`scripts/run-gates.ts`
- 修改：`pnpm-lock.yaml`

**接口：**
- 使用：`product.json`、已构建 Electron 输出和 GitHub Actions 原生 runner。
- 产出：已验证的 Windows NSIS、macOS 通用 DMG、Linux AppImage/DEB 配置、关闭发布的未签名 PR 产物，以及只执行 pack 的旧 dsh workflow。

- [x] **Step 1：编写失败的发布配置断言**

创建测试，加载配置并要求：

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

同时断言 Desktop workflow 正文包含 `--publish never`、`windows-2025`、`macos-15` 和 `ubuntu-24.04`，并且不包含 npm 或 GitHub release 发布命令。断言旧 `.github/workflows/release.yml` 不包含 `release:publish` 调用或 `NODE_AUTH_TOKEN`。

- [x] **Step 2：运行测试并确认配置缺失**

运行：

```powershell
pnpm exec vitest run scripts/desktop-release-config.spec.ts
```

预期：FAIL，因为 builder config 和 workflow 尚不存在。

- [x] **Step 3：添加 Electron Builder 配置**

使用 JSON import attribute 导入 `product.json` 并导出：

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

向 Desktop manifest 添加 `package` 和 `package:dir` 脚本；两者都传入 `--publish never`。

- [x] **Step 4：添加原生 runner 产物 workflow**

workflow 在 PR 和手动触发时运行，使用 Node 24 与 frozen pnpm install，构建 Desktop，只打包当前 runner 的原生目标，并上传 `apps/desktop/release/*`。它只授予 `contents: read`，不声明 environment，不接收签名或 npm secret，绝不创建 GitHub Release。

把现有 release workflow 的显示名称改成旧 dsh pack audit，移除 `publish` 输入和完整 `publish` job，保留不使用凭据的 pack/install 验证 job。这样，fork 在内部名称仍使用上游 scope 时无法发布这些包。

- [x] **Step 5：把静态发布配置验证器加入仓库检查**

`scripts/desktop-release-config.ts` 加载产品元数据、builder config、Desktop manifest 和 workflow 正文。应用 ID、产品名称、可执行文件名、仓库 owner/name、目标矩阵不匹配，或发布模式不是 `never` 时，它都必须拒绝。把 `verify:desktop-release-config` 加入根脚本，并在 `scripts/run-gates.ts` 的 artifact gate 中执行。

- [x] **Step 6：运行配置测试和本地 unpacked 构建**

运行：

```powershell
pnpm install
pnpm exec vitest run scripts/desktop-release-config.spec.ts
pnpm run verify:desktop-release-config
pnpm run desktop:build
pnpm --filter @deepseek-ai/dsh-desktop run package:dir
```

预期：测试和验证器通过；当前平台在 `apps/desktop/release` 下生成 unpacked app，且没有发布。

- [x] **Step 7：提交打包脚手架**

运行：

```powershell
git add apps/desktop/electron-builder.config.mjs apps/desktop/package.json .github/workflows/desktop-artifacts.yml .github/workflows/release.yml scripts/desktop-release-config.ts scripts/desktop-release-config.spec.ts scripts/run-gates.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "build(desktop): add non-publishing artifact matrix"
```

### Task 8：记录并验证基础里程碑

**文件：**
- 新建：`apps/desktop/README.md`
- 新建：`apps/desktop/README.zh.md`
- 新建：`apps/desktop/README.i18n.yaml`

**接口：**
- 使用：Task 1-7 的全部交付物和命令，以及仓库文档与 pre-push 工作流。
- 产出：Desktop 包级约定，以及 foundation 分支的新鲜验证证据。

- [ ] **Step 1：编写 Desktop 包约定及中文对侧文件**

记录 main/preload/renderer 职责、源码和构建命令、安全设置、输出目录、打包目标、测试命令，以及本里程碑不含 Host 与对话循环这一明确限制。不要把未签名产物 CI 描述成稳定版发布。

- [ ] **Step 2：记录并验证 Desktop 双语配对**

运行：

```powershell
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing apps/desktop/README.md
```

预期：Desktop README 配对通过。

- [ ] **Step 3：运行聚焦行为与快照套件**

运行：

```powershell
pnpm exec vitest run packages/boot/app-boot/tests/product-metadata.spec.ts
pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/desktop/tests/window-options.spec.ts apps/desktop/tests/preload-bridge.spec.ts scripts/product-identity.spec.ts scripts/desktop-release-config.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts apps/cli/tests/dsh-badge.snapshot.ts apps/desktop/tests/desktop-shell.snapshot.tsx
pnpm run desktop:build
pnpm run desktop:e2e
```

预期：全部聚焦测试、快照、Desktop 构建和 Electron e2e 通过。

- [ ] **Step 4：运行与变更范围匹配的仓库检查**

运行：

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

预期：每条命令以 0 退出。不要用完整测试或覆盖率套件替代这些聚焦检查。

- [ ] **Step 5：提交里程碑文档并检查分支**

运行：

```powershell
git add apps/desktop/README.md apps/desktop/README.zh.md apps/desktop/README.i18n.yaml
git diff --cached --check
git commit -m "docs(desktop): document the application foundation"
git status --short
git log --oneline --decorate codex/harness-desktop-design..HEAD
```

预期：工作树干净，分支包含导入的 daemon 合并，以及每个基础任务各自可评审的提交。
