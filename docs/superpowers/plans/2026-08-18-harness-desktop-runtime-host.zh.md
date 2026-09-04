# Harness Desktop Runtime 宿主实施计划

[English](2026-08-18-harness-desktop-runtime-host.md) | 中文

> **面向代理执行者：** 必须使用子技能：推荐使用 `superpowers:subagent-driven-development`，或使用 `superpowers:executing-plans` 逐项执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让已安装的 Electron 应用启动或连接共享本地 Runtime，并显示真实 Harness Dashboard，同时不让 Renderer 获得 Runtime 所有权、凭据、令牌或进程句柄。

**架构：** Electron Main 是共享 Runtime 发现和 Dashboard 控制 API 的客户端。它保留端点令牌，消费 Foundation 拥有的 attachment 与一次性 handoff 协议，并只将其 `DashboardNavigation` 交给 Main 拥有的 bootstrap transport。该 transport 打开一个 file URL、launch arguments 和日志均不含密钥、但 HTML body 含隐藏 handoff field 的本地 bootstrap document，只从其不透明 file origin 的表单正文提交该字段，并跟随 Runtime 的干净 `303` 导航到 loopback Dashboard origin。Electron Renderer 要么是该现有 Dashboard，要么是很小的本地恢复文档；其版本化 preload bridge 使用字面量并 fail-closed，公开三项恢复操作以及用户发起的文件夹选择、通知和允许列表外部链接打开。

**技术栈：** Node.js `^22.19.0 || >=24.0.0`、TypeScript 6、Electron 43、electron-vite、React 18、现有 `@harness-desktop/dsh-client-web` Dashboard、Runtime 发现/控制客户端、Vitest、Playwright、Electron Builder。

**规格：** `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.zh.md`

## 全局约束

- 一个 Runtime 实例拥有一个 `HARNESS_HOME`；Desktop 是客户端，绝不创建 Desktop 私有的 Runtime、持久化数据库、凭据存储或会话格式。
- Main 通过共享 Runtime 发现 API 启动或连接；它只能用不透明端点令牌执行私有 loopback 控制调用。
- Renderer 绝不接收 Runtime 令牌、端点记录、`HARNESS_HOME`、凭据提供方值、子进程句柄或未脱敏诊断数据。
- 高熵、短期、一次性（最长 60 秒）的 handoff 绝不放入 URL、hash、query、header、history entry、referrer、browser storage、log、diagnostic、transcript、IPC result 或 Renderer value。Main 只把 Foundation `DashboardNavigation` 交给其私有 `BrowserHandoffTransport`；它创建仅所有者 local-file bootstrap 目录和 document，验证 POSIX mode 或 Windows 当前用户 ACL，并拒绝权限更宽的位置。其 file URL、launch arguments 和日志不含密钥，但 HTML body 含隐藏 handoff field。document 从不透明 origin 向精确 Runtime target 的表单正文只 POST 一次 handoff。绑定到 `expiresAt` 的幂等 launcher cleanup timer 在 dispatch failure、exchange success 或 failure、expiry 以及 never-dispatched document 后精确一次删除所属 document 和目录，再跟随无 CORS 的干净 `303` Dashboard navigation。exchange handler 不要求 Origin 相等：它只认证原子消费的正文 handoff。Foundation 拥有交换后的随机或签名会话凭据，它只出现在 Runtime `Set-Cookie`、浏览器 `Cookie` 请求头和浏览器 HttpOnly cookie jar；它使用不带 expiry attribute 的 `HttpOnly; SameSite=Strict; Path=/`，且绝不暴露给 Dashboard JavaScript、Renderer IPC、脚本存储、应用持久化、日志、诊断、快照或会话记录。
- Electron 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`、严格 CSP、拒绝创建子窗口、仅由 Main 打开允许列表外部链接，以及 loopback origin 导航检查。
- 加载的 UI 是现有 `@harness-desktop/dsh-client-web` Dashboard 组合。不得嵌入、复制或维护 Desktop 聊天、工作区、会话、设置、凭据或审批实现。
- Runtime 或 Dashboard 失败时显示本地恢复页，提供重试和可复制脱敏诊断。绝不显示欢迎壳或看似 agent 已就绪的空页面。
- 每份可复制诊断都说明失败对象、稳定代码、修正方式和诊断标识符，并脱敏密钥、授权头、端点令牌和数据根路径。
- 源码、构建和未打包安装包路径都使用同一 Main/preload 代码，从干净输出树重新生成 `out/` 与 `release/`，并在每条相关生命周期路径证明 Dashboard 的精确 WebSocket CSP；已安装产物 smoke 由图标/发布计划负责。
- 每个新增产品可见状态都通过真实 Dashboard 组合或 Electron 端到端测试得到聚焦的无密钥覆盖；测试不得断言替代欢迎壳。
- Main 只在干净精确 origin Dashboard 完成已认证启动后发出一次脱敏、进程可观察的 `DesktopReadyAcknowledgement`。源码、构建、未打包和已安装 smoke 都消费同一 acknowledgement；它是同步信号，绝不是 renderer API。

---

## 所需共享 Runtime 输入

在实施本计划前，Runtime 基础计划提供精确公开、Node-only 的 `RuntimeClient.attachDashboard(): Promise<DashboardAttachment>` API。Desktop 导入 Foundation 拥有的 `RuntimeClient`、`DashboardAttachment`、`DashboardNavigation`、`DashboardOrigin`、`BrowserHandoff`、`RedactedRuntimeDiagnostic`、`ActiveWorkStatus`、`OwnUiWorkStopResult` 和 `normalizeRecoveryDiagnostic`；不得重新声明或包装竞争性的客户端类型。CLI、Web 启动器与 Electron Main 共用它；它不属于 Electron 包，绝不向浏览器代码导出携带令牌的值。

`RuntimeClient.attachDashboard()` 创建 Desktop 拥有的 `DashboardAttachment`。`DashboardAttachment.createBrowserHandoff(): Promise<DashboardNavigation>` 返回 `{ origin: DashboardOrigin; handoff: BrowserHandoff }`，其中 `BrowserHandoff` 精确为 `{ id: Branded<'BrowserHandoffId'>; expiresAt: number }`。Main 只把该瞬态结果交给 `BrowserHandoffTransport.open(navigation)`，并在 attachment 被替换或窗口最终销毁时调用 `DashboardAttachment.close()`。Main 在应用退出时于 attachment 关闭后调用 `RuntimeClient.close()`。这些操作只释放此 Desktop 客户端的 attachment 和客户端连接；绝不停止 Runtime、取消活动工作、释放其他客户端租约或终止其他客户端。所有 attachment、bootstrap transport 或启动失败均须先经过 `normalizeRecoveryDiagnostic`，再进入 Main 状态或 IPC。

`DashboardNavigation.handoff` 是 Main-only 瞬态数据。`BrowserHandoffTransport.open(navigation)` 在已验证仅所有者目录中创建一次性私有 bootstrap HTML document，用隐藏 form value 保存 `handoff.id`，经干净本地 file URL 打开它，然后从其不透明 origin 仅向 `${origin}/_harness/handoff` POST 表单。file URL、launch arguments 和日志不含 handoff；document body 有意包含 hidden form value。transport 拒绝权限更宽的位置，将精确一次的幂等 cleanup timer 绑定到 `expiresAt`，并在 dispatch failure、exchange success 或 failure、expiry 及 never-dispatched document 后精确一次删除所属 document 和目录。Foundation 不要求 Origin 相等，只认证 single-use、未过期的正文值，不发送 CORS permission，脱敏 capture，设置会话 cookie，并以 `303` 返回干净的 `${origin}/` Dashboard URL。Desktop shared type、IPC result、测试 snapshot、log、preload value、Renderer prop、初始 navigation request、request URL 或 header、referrer、history entry、browser storage entry、diagnostic 和 transcript 均不得包含 handoff。

Runtime 基础计划拥有 loopback static host、私有 native-control route、Dashboard control protocol（不透明 file origin 的仅正文 handoff exchange、原子 single-use/60-second 强制、无 CORS 的干净 `303`、脱敏 body capture、session cookie 与精确 origin API/event 认证）、Dashboard response CSP、`normalizeRecoveryDiagnostic`、`observeActiveWork()` 和 `stopOwnUiWork()`。CLI/Web 计划拥有普通浏览器的 launcher bootstrap transport 和无密钥 Runtime-hosted Dashboard fixture。本 Desktop 计划拥有 Electron 专用私有 bootstrap transport、Renderer-safe diagnostic projection、readiness acknowledgement、Dashboard workbench implementation 与 Desktop lifecycle；不修改 Runtime authentication、cookie、CSP、static-host 代码或浏览器恢复行为。

### 任务 1：新增仅 Main 使用的 Runtime Dashboard 控制器

**文件：**

- 新建：`apps/desktop/src/main/runtime-dashboard.ts`
- 新建：`apps/desktop/src/main/browser-handoff-transport.ts`
- 新建：`apps/desktop/src/main/readiness.ts`
- 新建：`apps/desktop/tests/runtime-dashboard.spec.ts`
- 新建：`apps/desktop/tests/browser-handoff-transport.spec.ts`
- 新建：`apps/desktop/tests/desktop-ready.spec.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/package.json`

**接口：**

- 使用：Foundation 拥有的 `RuntimeClient.attachDashboard(): Promise<DashboardAttachment>`、`DashboardAttachment.createBrowserHandoff(): Promise<DashboardNavigation>`、`DashboardAttachment.close()`、`RuntimeClient.close()` 和 `normalizeRecoveryDiagnostic`。
- 产出：`RuntimeDashboardController.open(window): Promise<DesktopStartupResult>` 与 `RuntimeDashboardController.retryAfterUserAction(window): Promise<DesktopStartupResult>`。
- 产出：`DesktopStartupResult = { kind: 'dashboard-loaded' } | { kind: 'recovery'; diagnostic: DesktopRecoveryDiagnostic }`；该 Renderer-safe 结果没有 URL、handoff、令牌、端口、PID 或数据根字段。
- 产出：仅 Main 使用的 `BrowserHandoffTransport.open(navigation: DashboardNavigation): Promise<void>`，以及 `DesktopReadyAcknowledgement = { readonly kind: 'desktop-dashboard-ready'; readonly version: 1 }`；它作为一条 JSONL record 仅一次写到已启动 Desktop 进程的 stdout。

- [ ] **步骤 1：编写失败的控制器测试**

在 `apps/desktop/tests/runtime-dashboard.spec.ts` 中用假的 Foundation `RuntimeClient`、`DashboardAttachment`、`BrowserHandoffTransport` 和窗口。先要求 attachment failure 规范化为完全相同的脱敏诊断且不导航。再要求并发 `open()` 调用共享一次 attachment、只调用一次 `createBrowserHandoff()`，并把未经修改的 Foundation `DashboardNavigation` 只一次传给 transport。要求显式 `retryAfterUserAction()` 关闭被替换的 attachment、创建新的 attachment 与 navigation，同时覆盖其成功 bootstrap 和规范化的脱敏 recovery 结果，并证明用户操作前不会重试。要求窗口销毁关闭其 attachment，应用退出在 attachment 之后关闭 Runtime client，且两者均不得调用 Runtime stop、lease release 或 work cancellation。

创建 `browser-handoff-transport.spec.ts`，检查每个 `loadFile`/navigation value 与捕获 request：验证 bootstrap 目录和文件的仅所有者 POSIX mode 或当前用户 Windows ACL，并拒绝权限更宽的位置；bootstrap file URL、launch arguments、干净 Dashboard URL、URL/hash/query、referrer、history、除已认证 session `Cookie` 外的 request header、script storage、log 与 diagnostic capture 均排除 fixture handoff text，只有 bootstrap HTML body 具有 hidden form value。精确只有一个来自不透明 file origin 的表单 `POST /_harness/handoff` 只在 body 含它，其 response 不发送 CORS permission，且 capture 已脱敏。把 never-dispatched document 推进至 `expiresAt`；dispatch failure 和两种 exchange outcome 都必须使用同一个精确一次 cleanup，删除所属 document 和目录。证明错误、过期或第二次使用都会失败，并要求非 `127.0.0.1` target、带 query/fragment/userinfo 的 origin、第二次 dispatch 和失败 `303` 都得到规范化脱敏 recovery result。创建 `desktop-ready.spec.ts`，要求仅在观察到干净预期 Dashboard origin 及其已认证 `data-harness-dashboard-ready="true"` marker 后，精确写一次 `{"kind":"desktop-dashboard-ready","version":1}` 加一个换行；recovery、bootstrap、未认证 URL、失败 marker 或重复 navigation 不得发出或重复 acknowledgement。

- [ ] **步骤 2：运行聚焦测试并确认控制器不存在**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/browser-handoff-transport.spec.ts apps/desktop/tests/desktop-ready.spec.ts
```

预期：失败，因为 `src/main/runtime-dashboard.ts` 不存在。

- [ ] **步骤 3：实现最小 Main-only 控制器**

创建构造参数为 Foundation `RuntimeClient` 和仅 Main 使用的 `BrowserHandoffTransport` 的 `RuntimeDashboardController`。它拥有当前 `DashboardAttachment`，调用 `attachment.createBrowserHandoff()` 并把未经修改的 `DashboardNavigation` 传给 `transport.open()`。transport 在转为 URL 后校验 branded target origin（协议必须为 `http:`、hostname 必须为 `127.0.0.1`、不得有用户名、密码、query 或 fragment，且必须有端口），创建并验证一次性仅所有者 bootstrap 目录和 document，拒绝权限更宽的位置，且绝不把 `handoff.id` 插入 URL。file URL、launch arguments 和日志无密钥，document body 含 hidden form value。将精确一次的幂等 cleanup timer 绑定到 `expiresAt`；dispatch failure、exchange success 或 failure、expiry 和无 dispatch 均精确一次删除所属 document 和目录。其顶级表单 POST 有意从不透明 file origin 跨 origin；Foundation 只认证正文 handoff，且不返回 CORS permission。等待干净 Dashboard redirect 和非密钥的已认证 ready marker 后才返回 `dashboard-loaded`，随后把唯一常量 acknowledgement 写到 `process.stdout`。在 replacement、destruction 或 app quit 时，每个拥有的 attachment 都恰好关闭一次；只在应用退出时关闭 Runtime client。无效 origin、handoff、bootstrap transport、attachment、marker 或 load 拒绝都通过 `normalizeRecoveryDiagnostic` 转换；不得把被拒绝 URL 放进 Renderer 结果。

- [ ] **步骤 4：在 Main 中接入首次启动且不公开控制数据**

在 `ready-to-show` 后仅由 Main 创建控制器并调用一次 `open(window)`；若为 recovery 结果则保留本地恢复文档。只通过该控制器创建 attachment、签发 handoff、导航和释放 attachment，绝不由 preload 或 Renderer 执行。不得通过 `webContents.send`、命令行参数、Renderer 全局变量或环境变量传递 attachment 对象。只在 Main 保存当前脱敏诊断，供任务 2 的只读恢复 IPC handler 使用。将 `BrowserWindow` destruction 和 `before-quit`/`will-quit` 接线，使拥有的 attachment 随后 Desktop client 关闭；带有活动工作的窗口关闭则遵循任务 6 的显式用户选择，绝不终止共享 Runtime 工作。

- [ ] **步骤 5：运行聚焦 Main 与类型检查**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
```

预期：没有 navigation URL 含 fragment 或 handoff；exchange 是唯一脱敏且不发送 CORS permission 的不透明 file-origin 表单 POST body；进程 acknowledgement 在已认证 Dashboard boot 后发出且只含常量 kind/version；recovery 结果只含脱敏字段；attachment/client close 只作用于本机客户端，不能停止共享 Runtime 工作。

- [ ] **步骤 6：提交控制器工作**

```powershell
git add apps/desktop/src/main apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(desktop): attach Main to the local Runtime"
```

### 任务 2：用版本化、fail-closed 原生 bridge 替换元数据 IPC

**文件：**

- 修改：`apps/desktop/src/shared/desktop-api.ts`
- 修改：`apps/desktop/src/preload/bridge.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/renderer/src/global.d.ts`
- 修改：`apps/desktop/tests/preload-bridge.spec.ts`
- 新建：`apps/desktop/tests/desktop-api.spec.ts`

**接口：**

- 使用：Foundation `RedactedRuntimeDiagnostic`、Main 拥有的 `toDesktopRecoveryDiagnostic(diagnostic)`、`DesktopStartupResult`、Main 拥有的 `copyText(text): Promise<void>` adapter、Electron `dialog`、`Notification` 和 `shell.openExternal`。
- 产出：版本为 1 的 `DesktopBridge`，包括三项恢复操作——`readRecoveryDiagnostic()`、`retryDashboard()`、`copyRecoveryDiagnostic()`——以及三项原生操作——`selectFolder()`、`showNotification(notification)`、`openExternalLink(url)`。
- 产出精确六个字面量 `desktopChannels` entry：`'desktop:read-recovery-diagnostic'`、`'desktop:retry-dashboard'`、`'desktop:copy-recovery-diagnostic'`、`'desktop:select-folder'`、`'desktop:show-notification'` 和 `'desktop:open-external-link'`。

- [ ] **步骤 1：编写失败的权限边界测试**

把元数据 channel 断言替换成调用六个精确 channel 各一次并拒绝所有未知 channel 和畸形 payload 的测试。新增 `desktop-api.spec.ts`，序列化只读 recovery diagnostic 和 recovery result，断言后者顶层仅有 `kind` 与 `diagnostic`；断言两个序列化文本都不含 `handoff`、`token`、`authorization`、`HARNESS_HOME`、`process` 和 fixture 数据根路径。测试文件夹选择只返回用户选中的项目路径或取消、notification 输入具有有界字面量字段、外部打开只接受文档化 `https:` allowlist。

- [ ] **步骤 2：运行测试并观察旧 bridge 合同失败**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts
```

预期：失败，因为当前 bridge 公开的是 `getProductMetadata()`，而非版本化六操作 bridge。

- [ ] **步骤 3：定义可判别、对 Renderer 安全的 API**

在 `desktop-api.ts` 中只 type-import Foundation 的 `RedactedRuntimeDiagnostic`；不得把 endpoint record、control client、handoff 或携带令牌的 type 导入此 shared 模块。把 Renderer payload 定义为精确字段投影 `DesktopRecoveryDiagnostic = Readonly<Pick<RedactedRuntimeDiagnostic, 'code' | 'subject' | 'message' | 'correction' | 'diagnosticId'>>`。仅 Main 实现纯 `toDesktopRecoveryDiagnostic(diagnostic)` mapper，在 IPC serialization 前只复制这五个字段。`DesktopStartupResult` 使用该 projection；它绝不携带或重构 `DashboardNavigation`、`BrowserHandoff`、origin 或 token。`DesktopBridge` 的版本为 `1`，且只包含：

```ts ignore-check
import type { RedactedRuntimeDiagnostic } from '@harness-desktop/dsh-host-local-runtime'

type DesktopRecoveryDiagnostic = Readonly<Pick<
  RedactedRuntimeDiagnostic,
  'code' | 'subject' | 'message' | 'correction' | 'diagnosticId'
>>

type DesktopStartupResult =
  | { readonly kind: 'dashboard-loaded' }
  | { readonly kind: 'recovery'; readonly diagnostic: DesktopRecoveryDiagnostic }

interface DesktopBridge {
  readonly version: 1;
  readRecoveryDiagnostic(): Promise<DesktopRecoveryDiagnostic | undefined>;
  retryDashboard(): Promise<DesktopStartupResult>;
  copyRecoveryDiagnostic(): Promise<void>;
  selectFolder(): Promise<{ readonly kind: 'selected'; readonly path: string } | { readonly kind: 'cancelled' }>;
  showNotification(notification: { readonly title: string; readonly body: string }): Promise<void>;
  openExternalLink(url: string): Promise<void>;
}
```

让 `DesktopInvoke` 成为六个字面量 channel 的可判别 overload/map。禁止通用 `invoke(channel: string, ...args: unknown[])`、shell 访问、文件系统 API、令牌 getter、任意剪贴板 API、任意 notification payload 或任意外部 URL。bridge 不公开 Runtime、Node、filesystem、process 或 credential access。

- [ ] **步骤 4：注册 fail-closed Main handler**

将 `readRecoveryDiagnostic` 注册为只读返回 Main 当前脱敏诊断。只在 Renderer 用户点击调用后通过控制器注册 `retryDashboard`；它是唯一重试路径。仅在 Main 有 recovery diagnostic 时注册复制；由 Main 用其脱敏字段格式化复制文本，再调用 Electron `clipboard.writeText`。没有 recovery diagnostic 时，以固定 `desktop:no-recovery-diagnostic` 错误 reject。只从 focused BrowserWindow 注册文件夹选择，返回已选项目文件夹或取消，绝不返回 `HARNESS_HOME`；只从有界 title/body 字段显示 notification；并在 Main 调用 `shell.openExternal` 前检查每个外部 URL 是否属于固定 `https:` host allowlist。检查失败时以固定脱敏错误码 reject。不得把 clipboard、Runtime、BrowserWindow、dialog、notification 或 shell 的异常消息回传 IPC。

- [ ] **步骤 5：只公开和校验类型化 bridge**

保留 `contextBridge.exposeInMainWorld('harnessDesktop', createDesktopBridge(...))`；更新 `global.d.ts` 只声明 `DesktopBridge`。新增测试断言 `Object.keys(window.harnessDesktop)` 精确为 `['copyRecoveryDiagnostic', 'openExternalLink', 'readRecoveryDiagnostic', 'retryDashboard', 'selectFolder', 'showNotification', 'version']`、其 version 是字面量 `1`，且 sandbox 页面没有 `window.require`、`process` 和任何旧 metadata 方法。

- [ ] **步骤 6：运行聚焦测试**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
```

预期：Renderer 可见的 native 操作只有上述六项字面量、类型化操作；Dashboard state 必须通过其已认证 DOM 和 test hook 观察，绝不可通过此 bridge。

- [ ] **步骤 7：提交 preload 边界**

```powershell
git add apps/desktop/src/shared apps/desktop/src/preload apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/global.d.ts apps/desktop/tests
git diff --cached --check
git commit -m "feat(desktop): expose fail-closed native bridge"
```

### 任务 3：用本地恢复页替换欢迎壳

**文件：**

- 删除：`apps/desktop/src/renderer/src/DesktopShell.tsx`
- 删除：`apps/desktop/tests/desktop-shell.snapshot.tsx`
- 修改：`apps/desktop/src/renderer/src/DesktopStartup.tsx`
- 新建：`apps/desktop/src/renderer/src/DesktopRecovery.tsx`
- 修改：`apps/desktop/src/renderer/src/main.tsx`
- 修改：`apps/desktop/src/renderer/src/styles.css`
- 修改：`apps/desktop/src/renderer/index.html`
- 修改：`apps/desktop/tests/desktop-startup.spec.ts`
- 新建：`apps/desktop/tests/desktop-recovery.snapshot.tsx`

**接口：**

- 使用：任务 2 的 `DesktopBridge` 与 `DesktopStartupResult`。
- 产出：`DesktopRecovery({ bridge, diagnostic }): React.JSX.Element`，只在本地 Runtime/Dashboard 路径不可用时显示。

- [ ] **步骤 1：编写失败的恢复渲染测试**

把 “Local coding agent” 与 “Open a workspace to begin.” 断言替换为通过 `readRecoveryDiagnostic()` 读取 `dashboard-unavailable` diagnostic 并渲染 `DesktopRecovery` 的测试。要求 `role="alert"` 标明 Dashboard、稳定代码、修正方式和 diagnostic identifier；要求 `Retry Dashboard` 与 `Copy diagnostic` 按钮可用。重试 pending 时两个控件必须禁用。成功重试必须调用 bridge 并离开本地页面以供 Main 导航；recovery retry 必须替换当前 diagnostic。断言初始渲染绝不调用 `retryDashboard()`。

- [ ] **步骤 2：运行 Renderer 测试并观察欢迎断言失败**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/desktop-startup.spec.ts apps/desktop/tests/desktop-recovery.snapshot.tsx
```

预期：删除欢迎壳和 metadata startup 路径前失败。

- [ ] **步骤 3：实现仅恢复用途的本地渲染**

让本地 `index.html` 成为使用 `connect-src 'none'` 的 recovery bootstrap document：无 inline script、remote source、宽泛 `ws:` 或网络重试。Runtime 拥有的 Dashboard response CSP 只允许精确本地 `ws://127.0.0.1:<port>` event-stream origin（或同源时的 `'self'`），绝不允许宽泛 `ws:`。`DesktopStartup` 读取 Main 的脱敏 diagnostic 并渲染 `DesktopRecovery`；它绝不启动、连接、签发、导航或重试。不得渲染伪工作区、对话 placeholder、产品 metadata 或 Dashboard 内容。

- [ ] **步骤 4：实现不持久化本地状态的重试与复制**

`DesktopRecovery` 只拥有 pending UI state。只有 Retry 按钮等待 `bridge.retryDashboard()`；Copy 按钮等待 `bridge.copyRecoveryDiagnostic()` 并显示 “Diagnostic copied”，不读取文本。它不得接收或缓存数据根路径、令牌、凭据、原始错误或进程信息。Main 在重新加载恢复后的 Dashboard 前执行新的 attachment 与 handoff。普通浏览器路径仍是 CLI/Web 拥有的可复制 `harness web` 命令，而非此 Electron 专用恢复 UI。

- [ ] **步骤 5：移除欢迎壳测试并添加无密钥快照**

删除 `DesktopShell` 及其 snapshot。录制只含 recovery page 的无密钥 snapshot，包括可见脱敏 diagnostic 字段和控件。断言 snapshot 不含 fixture token、路径或凭据。这是替换而非补充欢迎壳断言。

- [ ] **步骤 6：运行聚焦 Renderer 检查**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/desktop-startup.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-recovery.snapshot.tsx
```

预期：用户要么在 Main 导航后看到真实 Dashboard，要么看到可操作本地恢复页，绝不看到看似就绪的空壳。

- [ ] **步骤 7：提交恢复 Renderer**

```powershell
git add -A apps/desktop/src/renderer apps/desktop/tests
git diff --cached --check
git commit -m "feat(desktop): replace welcome shell with recovery"
```

### 任务 4：实现已认证 Dashboard focus mode 和工程工作台

**文件：**

- 修改：`packages/client/web/src/app.tsx`
- 修改：`packages/client/web/src/AppRoot.module.css`
- 修改：`packages/client/web/src/boot.tsx`
- 修改：`packages/client/web/tests/app.client.spec.tsx`
- 新建：`apps/web/tests/dashboard-workbench.e2e.ts`
- 新建：`apps/web/tests/dashboard-ready.e2e.ts`

**接口：**

- 使用：既有已认证 client connection、workspace/session/tool/todo/deliverable projection，以及由 `observeActiveWork(): Promise<ActiveWorkStatus>` 和 `stopOwnUiWork(): Promise<OwnUiWorkStopResult>` 支持的 Foundation 精确已认证 Dashboard control operation。
- 产出：具有 `focus` state 和精确五个 panel id 的 `EngineeringWorkbench`：`'files' | 'diff' | 'terminal' | 'artifacts' | 'tasks'`；每个 panel 呈现 Runtime 支持的数据并调用既有已认证 action path。它还只在 `AppWebEntry` 完成已认证 application boot 后产出无密钥 `data-harness-dashboard-ready="true"` marker。

- [ ] **步骤 1：编写失败的 Dashboard client 和已认证 e2e 测试**

扩展 `app.client.spec.tsx`，使用 workspace file tree、带 diff 的 tool event、terminal transcript、deliverables 和 todos 的 fixture client store。要求 focus control 隐藏周边 Dashboard chrome 但保留 active session，并在不重新连接时恢复。要求 Files、Diff、Terminal、Artifacts 和 Tasks 分别选择其 panel、呈现对应已认证 projection，并经既有 client command/service 路由其 action，而非 Electron preload 或 fixture global。要求 active-work indicator 原样呈现 Foundation status，safe-stop action 只发出 Foundation 支持的精确 Dashboard operation。

以无密钥 Runtime-hosted Dashboard fixture 创建 `dashboard-workbench.e2e.ts`。通过受支持 Runtime test API seed 每个 projection，经真实 handoff/cookie flow 认证，并要求 focus 与全部五个 panel state/action 的 DOM/test hook。证明没有 panel 经 `window.harnessDesktop`、本地 recovery state、localStorage 或新 Desktop-specific API 接收数据。创建 `dashboard-ready.e2e.ts`，要求 ready marker 只在 cookie-authenticated Dashboard boot 后出现，拒绝未认证 response 和失败 plugin boot，并证明 marker 没有 origin、handoff、cookie、token、credential、path、process 或 session field。

- [ ] **步骤 2：运行 Dashboard 测试并观察缺失 owner**

运行：

```powershell
pnpm exec vitest run packages/client/web/tests/app.client.spec.tsx
pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/tests/dashboard-workbench.e2e.ts apps/web/tests/dashboard-ready.e2e.ts
```

预期：当前 Dashboard 既没有 engineering-workbench composition，也没有 authenticated-ready marker，故失败。

- [ ] **步骤 3：实现 Dashboard 拥有的 view 和 ready marker**

在 `packages/client/web/src/app.tsx` 中实现 `EngineeringWorkbench`，并经 `buildRenderApp` 挂载；它拥有 focus state、panel selection、accessible label 以及既有 client projection 的组合。把其范围内样式加入 `AppRoot.module.css`。Files 使用 selected workspace projection 和 file action；Diff 使用 selected tool/diff projection；Terminal 使用 attached terminal projection 和 input action；Artifacts 使用 deliverables；Tasks 使用 todo projection 和 update action。所有 request 使用既有已认证 connection 与 Foundation 既有 control route；不得有 panel 读取 `HARNESS_HOME`、endpoint record、cookie、handoff、credential 或 Electron API。仅在 `AppWebEntry` 的每个 entry 均 active 后且已认证 Dashboard view 已挂载时，在其 root 设置 `data-harness-dashboard-ready="true"`；dispose 时清除它，任意 boot failure 时保持不存在。

- [ ] **步骤 4：运行聚焦 Dashboard 验证**

运行：

```powershell
pnpm exec vitest run packages/client/web/tests/app.client.spec.tsx packages/client/web/tests/app-root.client.spec.tsx
pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/tests/dashboard-workbench.e2e.ts apps/web/tests/dashboard-ready.e2e.ts
```

预期：真实已认证 Dashboard（而非 Desktop shell）拥有 focus 和全部五个 workbench panel，ready marker 只证明已认证 boot 成功。

- [ ] **步骤 5：提交 Dashboard workbench**

```powershell
git add packages/client/web apps/web
git diff --cached --check
git commit -m "feat(web): add the authenticated engineering workbench"
```

### 任务 5：锁定 Desktop 导航并证明真实 Electron 路径

**文件：**

- 修改：`apps/desktop/src/main/window-options.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/window-options.spec.ts`
- 删除：`apps/desktop/tests/desktop-shell.e2e.ts`
- 新建：`apps/desktop/tests/desktop-dashboard.e2e.ts`
- 新建：`apps/desktop/tests/desktop-recovery.e2e.ts`
- 新建：`apps/desktop/tests/support/runtime-fixture.ts`
- 修改：`apps/desktop/playwright.config.ts`

**接口：**

- 使用：Runtime 基础测试入口，以及 CLI/Web 计划已经认证的 loopback Dashboard、handoff exchange、cookie、CSP 和无密钥 Dashboard boot manifest。
- 产出：到达与 `apps/web` 相同 Dashboard 组合的 Electron 测试路径，以及没有特权 Renderer 访问的 recovery/retry 路径。

- [ ] **步骤 1：编写失败的 Electron 安全与 Dashboard e2e 测试**

创建 `desktop-dashboard.e2e.ts`，构建/启动 fixture Runtime，启动 `out/main/index.js`，等待进程未经修改的 `DesktopReadyAcknowledgement`，随后等待由同一个 Runtime 支持的已认证 Dashboard DOM/test hook 中真实 workspace picker、session history、conversation、streaming-tool rendering、approval control、model selector、credential-reference setting 和 application-setting view。通过已认证 Dashboard 和 Runtime 支持的 test API 创建或更新 project/session state，再通过 Dashboard DOM/test hook 观察——绝不可用 recovery IPC 或 preload state API。断言 bootstrap URL、干净地址栏页面 URL、`history.state`、每个 request URL/referrer/body 以及除已认证 session `Cookie` 外的每个 request header、browser script storage、diagnostic 和 transcript output 都排除 handoff；唯一不透明 file-origin exchange `POST` 只在 raw request body 包含它、不发送 CORS permission，且其 captured body/diagnostic 已脱敏。断言 Dashboard response CSP 不含宽泛 `ws:`，只允许精确 loopback event-stream origin，且外部 `ws://127.0.0.1:<different-port>` 连接被拒绝。断言 `window.require`、`process`、`Buffer` 和 token getter 均未定义；`window.harnessDesktop` 精确公开任务 2 的六项版本化 native 操作。

创建 `desktop-recovery.e2e.ts`，让 Runtime fixture 首先返回脱敏 start failure，随后成功 attachment。断言初始 recovery 会读取但不会调用 retry；用户点击只重试一次并到达真实 Dashboard；失败的点击重试会替换脱敏 diagnostic；Copy 通过 Main 的 clipboard seam 写入脱敏文本。断言任意 `window.open()` 都不创建子窗口；只有通过 `openExternalLink()` 打开的文档化 allowlisted `https:` URL 到达 Main 的 external-open seam，而不允许的 URL 被拒绝；尝试导航到 `http://localhost:43123` 被拦截。

- [ ] **步骤 2：运行 e2e 并确认当前壳无法满足**

运行：

```powershell
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/tests/desktop-recovery.e2e.ts
```

预期：任务 1–4 完成前失败，因为构建应用缺少私有 bootstrap transport、authenticated-ready acknowledgement 和 Runtime Dashboard。

- [ ] **步骤 3：执行 Main-process 导航策略**

保留既有安全 `webPreferences`。在 Main 中拒绝每个 `setWindowOpenHandler` request，使 Renderer request 都不能创建子窗口。Dashboard link 改用字面量 `openExternalLink()` IPC：Main 检查固定 `https:` host allowlist，只用 `shell.openExternal` 打开已批准 URL，仍拒绝新窗口 request。只允许顶级导航到本地 recovery file 或控制器的当前精确 `http://127.0.0.1:<port>` origin；对其他导航全部调用 `event.preventDefault()`。把 Renderer crash、failed load 和 Dashboard 401/handoff expiry 处理为返回本地 recovery document 并带新规范化的脱敏 diagnostic；retry 获得新的 attachment 与 handoff，不复用 URL。

- [ ] **步骤 4：实现可复用无密钥 Runtime fixture**

Desktop e2e adapter 以临时 `HARNESS_HOME` 启动 Runtime 基础测试入口，消费 CLI/Web 计划已经构建的 Dashboard artifact，并在其既有测试约定适用时复用 `packages/test-support/client-runtime`。它绝不创建不存在的 `packages/support` 包，也不实现 static host、API、handoff exchange、cookie、CSP、event stream 或 `AppWebEntry` 组合。它通过 Runtime 支持的测试 API 提供 fixture project/session 数据，不需要 `DEEPSEEK_API_KEY`，公开脱敏 failure injection，并提供显式 async close，等待 Runtime listener 和 Electron child 退出。

- [ ] **步骤 5：运行聚焦源码与 e2e 验证**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/preload-bridge.spec.ts apps/desktop/tests/desktop-api.spec.ts apps/desktop/tests/desktop-startup.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/desktop-recovery.snapshot.tsx apps/web/tests/built-boot.snapshot.ts
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm --filter @harness-desktop/dsh-desktop run test:e2e
```

预期：无密钥测试证明真实 Dashboard 功能和 workbench state、Foundation 拥有的一次性 handoff exchange 及其唯一脱敏 POST-body 例外、精确 WebSocket CSP、仅 Main native access、首次 recovery、并发导航合并及成功/失败的用户点击重试。

- [ ] **步骤 6：提交 Electron 验收覆盖**

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "test(desktop): exercise Runtime-hosted Dashboard"
```

### 任务 6：添加活动工作关闭选择和 tray 生命周期

**文件：**

- 修改：`apps/desktop/src/main/index.ts`
- 新建：`apps/desktop/src/main/close-policy.ts`
- 修改：`apps/desktop/src/shared/desktop-api.ts`
- 修改：`apps/desktop/src/renderer/src/DesktopStartup.tsx`
- 修改：`apps/desktop/tests/desktop-dashboard.e2e.ts`
- 新建：`apps/desktop/tests/close-policy.spec.ts`

**接口：**

- 使用：Foundation 精确 `RuntimeClient.observeActiveWork(): Promise<ActiveWorkStatus>` 与 `RuntimeClient.stopOwnUiWork(): Promise<OwnUiWorkStopResult>`、任务 1 中仅 Desktop 拥有的 attachment/client lifecycle，以及任务 4 的已认证 Dashboard workbench DOM/test hook。
- 产出：精确为 `minimize-to-tray`、`safely-stop-own-ui-work` 和 `cancel` 的关闭决策，以及可恢复现有窗口或请求同一关闭决策的 tray。

- [ ] **步骤 1：编写失败的关闭、tray 和 Dashboard-state 测试**

创建 `close-policy.spec.ts`，要求每个 close decision 前调用 `observeActiveWork()` 并原样使用其返回的 `ActiveWorkStatus`。要求 active-work close request 显示全部三个选择。`minimize-to-tray` 隐藏窗口但不销毁窗口或关闭 attachment；`safely-stop-own-ui-work` 只调用 `stopOwnUiWork()`，等待其精确 `OwnUiWorkStopResult`，然后才关闭此 Desktop attachment/client，且不停止其他客户端；`cancel` 保持窗口和工作不变。要求没有活动 UI work 的关闭正常释放 Desktop attachment/client。断言没有分支臆造 process kill、Runtime stop、background-lease release、session identifier 或其他客户端 cancellation。保留任务 4 的已认证 Dashboard focus/workbench 断言作为产品 UI owner。

- [ ] **步骤 2：运行测试并观察缺失的生命周期行为**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/close-policy.spec.ts apps/desktop/tests/runtime-dashboard.spec.ts
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts --grep "workbench|focus|tray"
```

预期：Main 原样消费 Foundation active-work observation 和 owner-scoped safe-stop result 前失败。

- [ ] **步骤 3：只实现 Desktop 拥有的关闭与 tray 行为**

只有在用户选择或已配置的后台偏好后才使用平台 tray，并提供可见的 Restore 和 Quit 操作。Desktop client 拥有 UI work 时，先调用 `observeActiveWork()` 再拦截关闭，显示三个字面量选择，并遵守选择结果。`safely-stop-own-ui-work` 等待 `stopOwnUiWork()` 的类型化安全完成或脱敏失败；它绝不发送 process kill、Runtime stop、background-lease release 或其他客户端 session cancellation。tray 在窗口隐藏时继续存在，并恢复/聚焦既有 Dashboard window；应用退出遵循任务 1 的 attachment-then-client close 顺序。Dashboard workbench 仍由任务 4 拥有；Main 只拥有 native lifecycle，不得复制其 view。

- [ ] **步骤 4：运行聚焦生命周期和产品检查**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/close-policy.spec.ts apps/desktop/tests/runtime-dashboard.spec.ts apps/desktop/tests/window-options.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- --grep "close|tray|workbench|focus"
```

预期：每条关闭路径原样消费 Foundation status/result，tray 隐藏保留活动工作，且没有 Desktop lifecycle branch 可以停止共享工作。

- [ ] **步骤 5：提交生命周期和工作台集成**

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "feat(desktop): preserve active work through close and tray"
```

### 任务 7：从干净树验证源码、构建与未打包安装包输出

**文件：**

- 修改：`apps/desktop/tests/preload-build.spec.ts`
- 修改：`apps/desktop/tests/desktop-dashboard.e2e.ts`
- 修改：`apps/desktop/electron.vite.config.ts`
- 修改：`apps/desktop/electron-builder.config.mjs`
- 修改：`apps/desktop/package.json`

**接口：**

- 使用：Main/preload build entry 与 Runtime-hosted Web asset 合同。
- 产出：不携带重复持久化、凭据或 Dashboard runtime，且从其生产 artifact 解析共享 Runtime client 的打包 Desktop。

- [ ] **步骤 1：编写失败的干净输出断言**

扩展 `preload-build.spec.ts`，在 build 前删除 `apps/desktop/out`，然后要求一个 CommonJS preload 和 Main output；Main 可以导入共享 Runtime client，但不得含 endpoint token、`HARNESS_HOME`、credential-provider implementation 或 `DesktopShell` 字面量。新增未打包安装包测试，删除 `apps/desktop/release`，运行 `package:dir`，启动平台未打包 executable，等待未经修改的 `DesktopReadyAcknowledgement`，并用无密钥 Runtime fixture 重复真实 Dashboard e2e，包括精确 Dashboard WebSocket CSP 和唯一脱敏不透明 file-origin handoff 表单正文例外。

- [ ] **步骤 2：运行检查并确认陈旧输出不能满足它们**

运行：

```powershell
Remove-Item -Recurse -Force apps/desktop/out, apps/desktop/release -ErrorAction SilentlyContinue
pnpm exec vitest run apps/desktop/tests/preload-build.spec.ts
```

预期：build 配置包含每个新 Main/preload dependency 且打包启动 helper 存在前失败。

- [ ] **步骤 3：保持源码与生产模块解析显式**

只为 source-owned、Node-safe Runtime client entry point 更新 `electron.vite.config.ts` alias；生产输出解析已构建 workspace export。保持 Renderer 与 Main/preload bundling 分离，不要把 Runtime implementation、database、credential provider 或 Web bundle copy 加进 Electron Builder `files`。Runtime static host 仍是唯一 Dashboard asset owner。

- [ ] **步骤 4：使打包可检查且不发布**

保持 `package` 与 `package:dir` 使用 `--publish never`。只包含 Main、preload、本地 recovery document 与其声明的生产依赖。新增 package 测试，验证未打包应用启动 Runtime fixture、未经修改消费精确 Main stdout acknowledgement，并到达与源码/构建测试相同的 Dashboard selector；不得只接受拿到 Electron process、readiness lookalike 或 welcome heading。图标/发布计划中的 installed-artifact fixture 不经替代 IPC、DOM guess 或特权测试 channel，原样消费同一个 JSONL acknowledgement。

- [ ] **步骤 5：从干净输出运行源码、构建和打包验证**

运行：

```powershell
Remove-Item -Recurse -Force apps/desktop/out, apps/desktop/release -ErrorAction SilentlyContinue
pnpm --filter @harness-desktop/dsh-desktop run typecheck
pnpm --filter @harness-desktop/dsh-desktop run build
pnpm exec vitest run apps/desktop/tests/preload-build.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e
pnpm --filter @harness-desktop/dsh-desktop run package:dir
pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/desktop-dashboard.e2e.ts --grep "unpacked"
```

预期：重新生成的 output 与未打包安装包均只在已认证真实 Dashboard 加载后发出同一脱敏 readiness acknowledgement，并执行相同的已认证 DOM、handoff、CSP、native-bridge 和生命周期保证；没有测试依赖 `out/` 或 `release/` 残留。

- [ ] **步骤 6：运行最终范围内仓库验证并提交**

运行：

```powershell
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

预期：所有命令退出 0。随后只提交实现工作：

```powershell
git add apps/desktop
git diff --cached --check
git commit -m "build(desktop): package the Runtime Dashboard host"
```

## 计划自检

- 规格覆盖：任务 1 保留 Main 中的 start-or-attach 与本地控制令牌，只使用 Foundation body-only handoff API，并在已认证 Dashboard boot 后发出一个脱敏 ready acknowledgement；任务 2 只把 Foundation 脱敏 diagnostic 投影给 Renderer；任务 3 删除欢迎壳并加入只读 recovery/用户点击 retry/copy；任务 4 拥有真实已认证 Dashboard focus/workbench 实现和 ready marker；任务 5 通过 Electron 验证 Dashboard 功能、权限隔离、recovery 和 acknowledgement；任务 6 原样消费 Foundation active-work observation 和 owner-scoped safe-stop；任务 7 验证干净源码、构建和未打包输出，图标/发布计划用同一 acknowledgement 做已安装产物 smoke。
- 没有 Desktop 私有状态：每项任务均使用 Runtime 发现/控制与既有 Web 组合。没有任务创建 Desktop 持久化、凭据提供方、Runtime server 或 Dashboard 副本。
- 安全自检：Renderer IPC 只有六项版本化字面量操作；携带令牌的对象止于 Main；Renderer 只接收 Foundation 脱敏 diagnostic 的纯字段 projection；所有成功 Dashboard 导航只通过 Main bootstrap transport 使用新的 Foundation `DashboardNavigation`；bootstrap 的仅所有者目录和 document 得到验证并拒绝权限更宽的位置，其 `expiresAt` timer 在无 dispatch、dispatch failure、exchange success 或 failure 以及 expiry 后精确一次 cleanup。handoff 不会进入 file URL、launch argument、日志、URL、hash、query、header、referrer、history、storage、Renderer、diagnostic 或 transcript，只会出现在 bootstrap HTML hidden form value 和单个不透明 file-origin 表单 POST body，且其 capture 已脱敏。exchange 不发送 CORS permission，普通 Dashboard 流量使用精确 Runtime origin 和 HttpOnly 会话 cookie。stdout acknowledgement 只含常量 kind/version 字段。
- 占位扫描：没有任务依赖未指定测试、泛化错误处理或欢迎壳验收。
