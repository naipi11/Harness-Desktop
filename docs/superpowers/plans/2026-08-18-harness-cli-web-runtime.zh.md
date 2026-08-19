# Harness CLI 与 Web Runtime 客户端实施计划

[English](2026-08-18-harness-cli-web-runtime.md) | 中文

> **供代理执行者使用：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 让 `harness`、`harness web` 和兼容别名 `dsh` 连接同一个本地 Runtime，而不是启动各自私有的 profile 应用树。

**架构：** Runtime 基础工作流拥有 `HARNESS_HOME`、锁、端点发现、携带令牌的控制请求、持久化、凭据和托管 Dashboard。本工作流只增加轻量终端与 Web 启动器：它们解析产品命令，通过基础 API 获取 Runtime 客户端，并仅渲染或交接 Runtime 提供的状态。`dsh` 与 `harness` 调用同一解析器和分发器；desktop 仅委托已安装应用的激活器，绝不由 CLI 子进程模拟。

**技术栈：** TypeScript ESM、Commander、Node 子进程/浏览器打开适配器、Vitest、现有源码/构建 CLI 与快照测试框架。

**规格：** [English design](../specs/2026-08-18-harness-unified-local-runtime-design.md) 和 [Harness 统一本地 Runtime 设计](../specs/2026-08-18-harness-unified-local-runtime-design.zh.md)

## 全局约束

- `HARNESS_HOME` 是唯一可写的 Harness 数据根目录；CLI、Web、Dashboard JavaScript 和 Electron renderer 均不得直接写持久化或凭据。
- 客户端调用 Runtime 发现/连接；若健康端点已存在，绝不启动第二个 Runtime。只有 Runtime 基础层能取得或恢复每数据根目录锁。
- 应用绝不读取、解析或披露端点记录；基础层 `RuntimeConnector` 封装发现及其私有控制令牌。
- Runtime loopback 控制令牌绝不进入 argv、JSONL stdout、stderr 诊断、浏览器 URL、浏览器存储、快照、会话记录、日志或异常文本。
- 不带 `--profile` 的 `harness` 是当前目录的交互式终端客户端；`harness "task"` 提供初始任务。
- `harness run "task" --json` 只向 stdout 输出 JSONL 协议记录；人类可读诊断和所有失败都进入 stderr。
- `harness web` 启动或连接 Runtime、取得 Runtime 所有的 Dashboard 附加、签发一个高熵、60 秒单次使用的浏览器 handoff，并在验证仅所有者 POSIX mode 或当前用户 Windows ACL、拒绝权限更宽的位置后打开只允许当前用户访问的本地 bootstrap 目录和 document。其不透明 file origin 有意使顶级表单向精确 Runtime `/_harness/handoff` target 发出的 POST 跨 origin；交换只认证其表单正文 handoff、以原子方式消费它、不发送 CORS permission，并返回干净 `303`。launcher 将一个幂等 cleanup timer 绑定到 `expiresAt`，在 dispatch failure、exchange success 或 failure，或 expiry 后精确一次删除所属 document 和目录，包括 never-dispatched document。handoff 绝不进入导航 URL、hash、query、header、referrer、history、存储、日志、诊断或会话记录。只有交换后的会话凭据可使用 Runtime `Set-Cookie`、浏览器 `Cookie` 请求头和浏览器 HttpOnly cookie jar；普通 Dashboard 请求必须使用不带 expiry attribute 的 `HttpOnly; SameSite=Strict; Path=/` 会话 cookie 和精确 Runtime origin。
- `--daemon` 和 `--background` 是同一个有持久名称的 Runtime 后台租约的别名，而不是分离的 Web 服务器进程。`--status` 绝不启动 Runtime；`--stop` 仅释放该租约，并在租约已不存在时幂等成功。
- `--no-open` 禁止浏览器导航；除非与 `--daemon` 或 `--background` 组合，否则不创建租约。
- `dsh` 与 `harness` 使用相同解析器、Runtime 数据根、命令图、错误映射以及源码/构建行为。兼容性不保留 `--profile` 作为公共 Runtime 客户端要求。
- 本计划是共享 parser、installed-app resolver/activator 和 `web --stop` 行为的唯一所有者。Icon/release 工作流消费这些 API 并打包它们；不得新增第二个 dispatcher、resolver、activator 或 stop 规则。
- `harness desktop` 只激活已安装的 Harness Desktop 应用。未安装时输出平台对应安装路径并退出；绝不启动隐藏 Electron 或 Web 替代进程。
- 保持 ESM、严格 TypeScript、公共 JSDoc、脱敏类型化错误，以及仓库源码面/产物面分离。本工作流不编辑 `specs/`、README 或 `.superpowers/dist`；只有任务 2 可以编辑 `apps/cli/package.json`，以加入狭义所需 workspace dependency 例外、CLI runtime graph、源码/构建暂存和构建条目。这一前提不接管 Icon/release 的分发与发布打包职责。

---

## 文件映射

- `apps/cli/src/args.ts`：两个可执行名称共享的产品命令解析器。
- `apps/cli/src/main.ts`：共享分发和明确 stdout/stderr 所有权。
- `apps/cli/src/runtime-client.ts`：在 Runtime 基础客户端 API 之上的非耐久 CLI 适配器。
- `apps/cli/src/terminal-client.ts`：Ink/React 交互与 JSONL 终端呈现；不启动 profile，也不访问持久化。
- `apps/cli/src/web-daemon.ts`：改为 Runtime Web 调用/租约编排；移除分离子进程启动和日志所有权。
- `apps/cli/src/browser.ts`：启动器拥有的瞬态本地 file bootstrap transport，验证仅所有者目录和 document，只在跨 origin 表单 POST body 中向精确 Runtime target 提交不透明 handoff，并使用绑定 `expiresAt` 的精确一次 cleanup 后只跟随干净 Dashboard URL。
- `apps/cli/src/desktop.ts`：可注入已安装应用激活适配器。
- `apps/cli/tests/args.spec.ts`、`main.spec.ts`、`terminal-client.spec.ts`、`web-daemon.spec.ts`、`desktop.spec.ts`：聚焦解析器和客户端行为。
- `apps/cli/tests/source-launch.compat.spec.ts`、`runtime-client.e2e.ts`、`interactive-terminal.pty.e2e.ts`、`web-daemon.compat.spec.ts`、`web-daemon.snapshot.ts`：真实源码/构建、PTY 与会话记录验证。
- `apps/web/src/main.ts`：只有瞬态 bootstrap POST 重定向至干净、cookie 已认证的 URL 后才启动现有 Dashboard shell。
- `apps/web/tests/runtime-bootstrap.e2e.ts` 和 `runtime-bootstrap.snapshot.ts`：无浏览器可见 handoff 的干净 URL、cookie 已认证 Dashboard 验证。

## Runtime 基础依赖

本计划使用但不实现 Runtime 基础层的以下公共 API。不得在 `apps/cli` 或 `apps/web` 中复制这些类型。

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type RuntimeId = Branded<'RuntimeId'>
export type RuntimeClientId = Branded<'RuntimeClientId'>
export type SessionId = Branded<'SessionId'>
export type BackgroundLeaseId = Branded<'BackgroundLeaseId'>
export type BrowserHandoffId = Branded<'BrowserHandoffId'>
export type ApprovalId = Branded<'ApprovalId'>
export type ActiveWorkId = Branded<'ActiveWorkId'>
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>
export type DashboardOrigin = Branded<'DashboardOrigin'>

export interface TerminalOpenRequest {
  readonly workspace: string
  readonly initialTask?: string
  readonly sessionId?: SessionId
}
export type TerminalProtocolEvent =
  | { readonly kind: 'session-opened'; readonly sessionId: SessionId }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'tool-activity'; readonly title: string }
  | { readonly kind: 'approval-requested'; readonly approvalId: ApprovalId; readonly prompt: string }
  | { readonly kind: 'model-changed'; readonly model: string }
  | { readonly kind: 'permission-changed'; readonly permission: string }
  | { readonly kind: 'diagnostic'; readonly diagnostic: RedactedRuntimeDiagnostic }
export type TerminalInput =
  | { readonly kind: 'task'; readonly text: string }
  | { readonly kind: 'approval'; readonly approvalId: ApprovalId; readonly decision: 'approve' | 'reject' }
export type TerminalControlCommand =
  | { readonly command: 'model'; readonly model?: string }
  | { readonly command: 'permissions'; readonly permission?: string }
  | { readonly command: 'plan' }
  | { readonly command: 'compact' }
  | { readonly command: 'resume'; readonly sessionId?: SessionId }
  | { readonly command: 'diff' }
  | { readonly command: 'terminal' }
  | { readonly command: 'doctor' }
  | { readonly command: 'exit' }
export interface TerminalConnection {
  events(): AsyncIterable<TerminalProtocolEvent>
  submit(input: TerminalInput): Promise<void>
  runControl(command: TerminalControlCommand): Promise<void>
  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  close(): Promise<void>
}
export interface BrowserHandoff { readonly id: BrowserHandoffId; readonly expiresAt: number }
export interface DashboardNavigation { readonly origin: DashboardOrigin; readonly handoff: BrowserHandoff }
export interface DashboardAttachment {
  createBrowserHandoff(): Promise<DashboardNavigation>
  close(): Promise<void>
}
export interface BrowserHandoffTransport { open(navigation: DashboardNavigation): Promise<void> }
export interface RuntimeLease { readonly id: BackgroundLeaseId }
export interface RuntimeStatus {}
export interface RuntimeLeaseStatus { readonly id: BackgroundLeaseId; readonly state: 'present' | 'absent' }
export type RuntimeRecoveryCode = 'runtime-unavailable' | 'runtime-version-mismatch' | 'runtime-start-failed' | 'dashboard-unavailable'
export interface RedactedRuntimeDiagnostic {
  readonly code: RuntimeRecoveryCode
  readonly subject: 'Runtime' | 'Dashboard'
  readonly message: string
  readonly correction: string
  readonly diagnosticId: RuntimeDiagnosticId
}
export type LegacyMigrationState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'decision-required'; readonly sourceLabel: 'DSH_HOME'; readonly retryable: boolean }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly copied: readonly string[] }
  | { readonly kind: 'target-not-empty'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
  | { readonly kind: 'failed'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
export interface ActiveWorkStatus { readonly ownUiWork: readonly ActiveWorkId[] }
export type OwnUiWorkStopResult = { readonly kind: 'stopped'; readonly work: readonly ActiveWorkId[] } | { readonly kind: 'none-active' } | { readonly kind: 'failed'; readonly diagnostic: RedactedRuntimeDiagnostic }

export interface RuntimeClient {
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  attachDashboard(): Promise<DashboardAttachment>
  acquireBackgroundLease(): Promise<RuntimeLease>
  status(): Promise<RuntimeStatus>
  releaseBackgroundLease(): Promise<RuntimeLeaseStatus>
  getLegacyMigration(): Promise<LegacyMigrationState>
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  declineLegacyMigration(): Promise<LegacyMigrationState>
  retryLegacyMigration(): Promise<LegacyMigrationState>
  observeActiveWork(): Promise<ActiveWorkStatus>
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
  close(): Promise<void>
}

export interface RuntimeConnector {
  connect(options: { readonly start: boolean }): Promise<RuntimeClient>
}

export declare class RuntimeUnavailableError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeBusyError extends Error { readonly sessionId: SessionId; readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeProtocolError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare function normalizeRecoveryDiagnostic(error: unknown): RedactedRuntimeDiagnostic
```

`connect({ start: false })` 在不存在健康 Runtime 时以 `RuntimeUnavailableError` 拒绝，且不得创建文件、进程、锁或端点记录。`TerminalConnection`、`DashboardAttachment` 和 `RuntimeClient` 各有自己的必需 `close()` 生命周期。Web 启动器在打开后关闭 Dashboard 附加；Electron Main 使用相同附加，并在应用退出时关闭它。`TerminalConnection` 提供协议事件；其事件值已可安全呈现。所有恢复输出使用基础层 normalizer，它不携带令牌、handoff、cookie、凭据、端点记录字段或绝对 home 路径。

### 任务 1：以一个产品命令图替换 profile 必填解析

**文件：**
- 修改：`apps/cli/src/args.ts`
- 修改：`apps/cli/tests/args.spec.ts`
- 修改：`apps/cli/tests/source-launch.compat.spec.ts`

**接口：**
- 产出 `ProductInvocation = InteractiveInvocation | RunInvocation | WebInvocation | DesktopInvocation`。
- `parseProductArgs(argv, commandName): ProductInvocation` 由两个 bin 调用；仅为呈现保留 `commandName: 'harness' | 'dsh'`。
- `WebInvocation` 包含 `mode: 'web'`、`open: boolean`、`lease: 'none' | 'background'` 与 `operation: 'open' | 'status' | 'stop'`。
- 解析错误使用带修正建议的 `ProductArgumentError`，由 `main.ts` 输出到 stderr。

- [ ] **Step 1：编写失败解析器测试**

加入精确断言：裸 `harness` 解析为 `{ mode: 'interactive', initialTask: undefined }`，`harness "task"` 解析为带任务的同一模式，`harness run "task" --json` 解析为 `{ mode: 'run', task: 'task', json: true }`。断言 `web --daemon` 与 `web --background` 都是 `lease: 'background'`；`web --status` 和 `web --stop` 解析相应 operation 且 `lease: 'none'`；`web --status --daemon`、缺任务的 `run --json`、重复任务和每一个公开 `--profile` 输入都带修正建议地拒绝。

- [ ] **Step 2：运行 RED 解析器测试**

运行：`pnpm exec vitest run apps/cli/tests/args.spec.ts`

预期：FAIL，因为当前解析器要求 `--profile` 并返回 `DshInvocation`。

- [ ] **Step 3：实现最小命令语法**

以判别联合 `ProductInvocation` 和解析器替换 `DshInvocation`/`parseDshArgs`。保留 Commander help/version，但使 `harness` 示例使用产品命令，并为 `dsh` 生成完全相同的语法图。解析 `web --no-open`、租约别名、status 与 stop 后再处理位置任务；不再向 profile 转发启动器 flag。

- [ ] **Step 4：验证解析器与源码入口行为**

运行：`pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts`

预期：PASS；源码入口接受裸 `harness`/`dsh` 解析，并拒绝格式错误输入，且不提及 `--profile`。

- [ ] **Step 5：提交解析器边界**

运行：`git add apps/cli/src/args.ts apps/cli/tests/args.spec.ts apps/cli/tests/source-launch.compat.spec.ts && git diff --cached --check && git commit -m "feat(cli): parse Runtime product commands"`

### 任务 2：添加交互式 Ink 终端 Runtime 客户端和 JSONL 渲染器

**文件：**
- 新建：`apps/cli/src/runtime-client.ts`
- 新建：`apps/cli/src/terminal-client.ts`
- 修改：`apps/cli/package.json`
- 修改：`apps/cli/src/main.ts`
- 新建：`apps/cli/tests/main.spec.ts`
- 新建：`apps/cli/tests/terminal-client.spec.ts`
- 新建：`apps/cli/tests/interactive-terminal.pty.e2e.ts`
- 新建：`apps/cli/tests/runtime-client.e2e.ts`

**接口：**
- 使用上节基础 API 的 `RuntimeConnector`、`RuntimeClient`、`RuntimeBusyError` 和 `TerminalConnection`。
- 产出 `runTerminalInvocation(invocation, io, connector): Promise<number>`；`io.stdout` 仅在 `run --json` 模式接收协议 JSONL，`io.stderr` 接收诊断。
- `TerminalRenderer` 有 `writeEvent(event: TerminalProtocolEvent): void` 和 `writeDiagnostic(error: RuntimeClientError): void`；它绝不接收数据根路径或凭据提供方。
- 交互模式使用 Ink/React、保留普通终端 scrollback，且绝不切换到 alternate screen。它将 `/model [model]`、`/permissions [preset]`、`/plan`、`/compact`、`/resume [session]`、`/diff`、`/terminal`、`/doctor` 和 `/exit` 一一映射到 `TerminalControlCommand`；文本输入和 approval reply 使用 `submit()`，流式 Runtime event 驱动全部输出。第一次 Ctrl+C 调用 `cancel()` 并保持终端附加；在取消窗口内第二次 Ctrl+C 执行已批准的 forced exit，不等待新的 Runtime 输出。exit code 精确为 `0`（正常完成或 `/exit`）、`2`（参数错误）、`3`（Runtime 不可用）、`4`（session busy）、`5`（protocol/internal failure）、`130`（已完成用户取消）和 `131`（强制第二次 Ctrl+C 退出）。

- [ ] **Step 1：编写失败终端与分发测试**

使用假的 `RuntimeConnector` 断言交互和任务模式将 `workspace`、`initialTask` 和可选的带品牌 resumed `sessionId` 传给 `openTerminal()`、消费 `events()`、提交任务文本和 approval decision、把全部九个 slash command 映射到精确 `TerminalControlCommand`，并仅关闭自身 connection/client 而不停止被其他客户端使用的 Runtime。断言 `run "task" --json` 将每个 `TerminalProtocolEvent` 作为一个以换行结束的 `JSON.stringify(event)` 记录写入 stdout、只向 stderr 写入已规范化诊断，且 JSONL 记录前后之间没有 prose。在源码和构建的真实 PTY 中分别断言普通 scrollback/无 alternate screen、每个已命名 slash command、流式 output/tool/approval 往返、第一次 Ctrl+C `cancel()`、第二次 Ctrl+C forced exit、每个数字 exit code、resize 重渲染和 color-capability 降级。

- [ ] **Step 2：运行 RED 测试**

运行：`pnpm exec vitest run apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts`

预期：FAIL，因为 `main.ts` 仍调用 `runProfile`，且不存在终端 Runtime 适配器。

- [ ] **Step 3：实现最小 Runtime 专属终端路径**

将 `@harness-desktop/dsh-host-local-runtime`、Ink 和 React 作为显式 workspace/runtime dependency 例外加入 `apps/cli/package.json`，并通过包构建暂存完整 CLI Runtime dependency graph 及源码/构建入口产物。本任务为自身客户端测试提供该 graph；Icon/release 计划仍拥有可分发 archive 与 installer 打包。将 `runtime-client.ts` 实现为基础 `RuntimeConnector` 的 factory；它只能连接、打开终端会话、读取 `getLegacyMigration()`、只从明确用户动作调用 accept/decline/retry，并关闭自身附加。用 Ink/React 交互 renderer 和独立 JSONL renderer 实现 `terminal-client.ts`。将 Foundation migration state 渲染为显式首启提示及其耐久结果/retry correction；非交互 `run` 渲染同一个已规范化 `migration-decision-required` 诊断而不复制文件。将 `RuntimeBusyError`、Runtime 不可用、协议失败和迁移决定经 `normalizeRecoveryDiagnostic()` 映射为脱敏 stderr 诊断。更新 `dispatchInvocation` 以选择该客户端，并从公开命令移除 `runProfile`。

- [ ] **Step 4：验证聚焦与真实入口路径**

运行：`pnpm exec vitest run apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts`

运行：

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built terminal verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
```

预期：PASS；PTY e2e 演练普通 scrollback、slash controls、两阶段 Ctrl+C、resize、颜色和 exit-code matrix。Runtime e2e 断言可执行的源码和构建模式的两个调用只有一个 Runtime 所有者，且 JSONL stdout 可逐行解析、stderr 只含诊断。

- [ ] **Step 5：提交终端客户端**

运行：`git add apps/cli/package.json apps/cli/src/main.ts apps/cli/src/runtime-client.ts apps/cli/src/terminal-client.ts apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/runtime-client.e2e.ts && git diff --cached --check && git commit -m "feat(cli): attach terminal commands to Runtime"`

### 任务 3：使 `harness web` 成为 Runtime handoff 和租约客户端

**文件：**
- 新建：`apps/cli/src/browser.ts`
- 修改：`apps/cli/src/web-daemon.ts`
- 修改：`apps/cli/src/main.ts`
- 修改：`apps/cli/tests/web-daemon.spec.ts`
- 修改：`apps/cli/tests/web-daemon.compat.spec.ts`
- 新建：`apps/cli/tests/web-runtime.e2e.ts`
- 修改：`apps/cli/tests/web-daemon.snapshot.ts`

**接口：**
- `BrowserHandoffTransport.open(navigation: DashboardNavigation): Promise<void>` 可注入；只有 `DashboardAttachment.createBrowserHandoff()` 提供其 origin 和不透明 handoff。
- `runWebInvocation(invocation, connector, opener, io): Promise<number>` 使用 `connect({ start: invocation.operation === 'open' })`。
- `RuntimeStatus` 与 `RuntimeLeaseStatus` 以脱敏形式呈现；status 的 `RuntimeUnavailableError` 报告 Runtime 缺失、非零退出且绝不启动它。

- [ ] **Step 1：编写失败 Web 操作测试**

断言普通 `web` 用 `start: true` 连接、附加一个 Dashboard client、只调用一次其 `createBrowserHandoff()`，并只将得到的 `DashboardNavigation` 传给 transport。transport 创建仅所有者本地 bootstrap 目录和 document，验证 POSIX mode 或 Windows 当前用户 ACL、拒绝权限更宽的位置，并证明其不透明 file origin 能在一个表单正文中到达精确 `http://127.0.0.1:<port>/_harness/handoff` target。拒绝错误、复用或过期 handoff，不收到 CORS permission，并要求绑定 `expiresAt` 的 cleanup 在 dispatch failure、exchange success 或 failure 以及 expiry 后精确一次删除所属 document 和目录；把 never-dispatched transport 推进到 expiry 并要求相同 cleanup。到达干净 `http://127.0.0.1:<port>/` 而不把秘密写入 stdout/stderr。断言 `--no-open` 跳过 transport，daemon/background 各取得一个租约，两个别名同时给出仍为该 `HARNESS_HOME` 的持久命名 `web` 租约寻址，`--status` 只调用 `connect({ start: false })` 和 `status()`，`--stop` 只调用 `connect({ start: false })` 和 `releaseBackgroundLease()`；租约不存在时 stop 仍是幂等成功。

- [ ] **Step 2：运行 RED Web 测试**

运行：`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts`

预期：FAIL，因为当前模块移除 flag 后启动带私有日志的分离 web profile 子进程。

- [ ] **Step 3：用 Runtime 操作替换分离服务器所有权**

从 `web-daemon.ts` 删除 `spawn`、日志目录、PID 与子进程清理行为；为避免无关移动保留文件名。通过 `attachDashboard()`、`createBrowserHandoff()` 及每个附加的 `close()` 实现瞬态 bootstrap transport 和 Runtime 编排。创建新的仅所有者本地 bootstrap 目录和 document，验证其 POSIX mode 或 Windows 当前用户 ACL，并拒绝权限更宽的位置。file URL、launch arguments 和日志干净，但 document 只在 hidden form field 中包含 handoff。将精确一次的幂等 cleanup timer 绑定到 `expiresAt`；dispatch failure、exchange success 或 failure、expiry 和 never-dispatched document 都通过该 cleanup 精确一次删除所属 document 和目录。document 从其不透明 origin 自动 POST 到精确 Runtime endpoint；handler 只认证被原子消费且未过期的表单值、不发送 CORS permission，并在 Dashboard 启动前返回干净 `303`。`--status` 不得回退为 start，`--stop` 不得终止工作或断开客户端，全部结果使用基础层 recovery normalizer 并脱敏端点令牌和 handoff。

- [ ] **Step 4：验证源码、构建与快照表面**

运行：`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-runtime.e2e.ts`

运行：`pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts`

运行：

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/web-runtime.e2e.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built Web runtime verification failed.' }
  pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built Web snapshot verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
```

预期：PASS。真实入口测试运行两个独立 CLI 进程，让两个 Web 命令连接同一 Runtime，验证别名为一个租约命名、由较晚进程释放该租约，证明重复 stop 安全且 status 未创建端点，并证明 stop 保留活动终端工作。

- [ ] **Step 5：提交 Web 启动器**

运行：`git add apps/cli/src/browser.ts apps/cli/src/web-daemon.ts apps/cli/src/main.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/web-daemon.snapshot.ts && git diff --cached --check && git commit -m "feat(web): hand off browsers through Runtime"`

### 任务 4：仅在瞬态 bootstrap 重定向后启动 Dashboard

**文件：**
- 修改：`apps/cli/src/browser.ts`
- 新建：`apps/cli/tests/browser-bootstrap.spec.ts`
- 修改：`apps/web/src/main.ts`
- 新建：`apps/web/tests/runtime-bootstrap.e2e.ts`
- 新建：`apps/web/tests/runtime-bootstrap.snapshot.ts`

**接口：**
- 瞬态本地 bootstrap document 从其不透明 file origin 只提交 handoff 表单正文。只有 Runtime 会话 cookie 被设置后重定向至干净 Dashboard URL，`apps/web/src/main.ts` 才启动。
- cookie 已认证的 Dashboard 请求失败时，它以 `DashboardHandoffError` 失败并带用户安全的重连指令；异常和任一 DOM 字符串均不得含 handoff 或 token。

- [ ] **Step 1：编写失败 Dashboard bootstrap 测试**

使用通过瞬态 bootstrap document 启动的真实浏览器页面。断言其 hidden field 是唯一原始 handoff 位置、目录和 document 具有已验证的仅所有者 POSIX mode 或当前用户 Windows ACL，且权限更宽的位置被拒绝。断言其不透明 file origin POST 不依赖 CORS permission 或 Origin 相等认证而到达当前 `127.0.0.1` target，且请求体采集已脱敏。将 never-dispatched document 推进至 `expiresAt`，随后覆盖 dispatch failure 和两种 exchange outcome；每一种都必须调用同一精确一次 cleanup，删除 document 和目录。断言所有浏览器 navigation URL、非 cookie request header、referrer、history、脚本存储、日志、诊断、DOM value、console 输出和快照均排除 handoff；受保护 Dashboard 仅在带 `HttpOnly; SameSite=Strict; Path=/` 会话 cookie 的 redirect 后的干净 `/` 出现。断言错误、过期或复用 handoff 精确显示 `Dashboard connection expired. Run harness web to reconnect.`，不挂载受保护状态，并且 localStorage、sessionStorage、IndexedDB、console 输出或快照文本没有 handoff 或 session 值。

- [ ] **Step 2：运行 RED Web bootstrap 测试**

运行：`pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

预期：FAIL，因为现有启动路径没有瞬态 bootstrap transport 或 cookie 已认证的干净 Dashboard 启动。

- [ ] **Step 3：实现最小仅正文 local-file bootstrap**

令 `main.ts` 拒绝任何非干净初始 Dashboard location，并只在 Runtime 的仅正文 local-file bootstrap handler 已设置 cookie 且重定向到干净 `/` 后启动 `new AppWebEntry(el).run()`。不得新增 Dashboard handoff reader、hash 处理、history replacement 或持久浏览器存储写入。cookie 认证失败时渲染稳定恢复文本 `Dashboard connection expired. Run harness web to reconnect.`；不得暴露令牌、会话标识符、原始 Runtime 错误或原始 handoff。

- [ ] **Step 4：验证 Web 源码/构建及客户端 handoff**

运行：`pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

运行：

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/browser-bootstrap.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built browser bootstrap verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/runtime-bootstrap.e2e.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap e2e verification failed.' }
pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/runtime-bootstrap.snapshot.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap snapshot verification failed.' }
```

预期：PASS；构建瞬态 bootstrap 验证仅所有者文件访问，只提交一次 body-only handoff，并在每条 dispatch/exchange/expiry 路径上精确一次清理所属 document 和目录，重定向到干净 Dashboard URL，Dashboard 使用 Runtime cookie 进行后续受保护请求而不接收 handoff。

- [ ] **Step 5：提交 Dashboard bootstrap**

运行：`git add apps/cli/src/browser.ts apps/cli/tests/browser-bootstrap.spec.ts apps/web/src/main.ts apps/web/tests/runtime-bootstrap.e2e.ts apps/web/tests/runtime-bootstrap.snapshot.ts && git diff --cached --check && git commit -m "feat(web): bootstrap Dashboard through Runtime handoff"`

### 任务 5：路由 desktop 激活并完成共享客户端验收矩阵

**文件：**
- 新建：`apps/cli/src/desktop.ts`
- 修改：`apps/cli/src/main.ts`
- 新建：`apps/cli/tests/desktop.spec.ts`
- 修改：`apps/cli/tests/source-launch.compat.spec.ts`
- 新建：`apps/cli/tests/runtime-clients.acceptance.e2e.ts`
- 修改：`apps/cli/tests/web-daemon.snapshot.ts`

**接口：**
- `InstalledDesktopActivator.activate(): Promise<'activated'>` 绝不接收 Runtime token、持久化路径、凭据对象或回退浏览器 URL。它是 `harness desktop` 与 `dsh desktop` 使用的唯一 installed-app resolver/activator；Desktop packaging 只消费它而不得重建。
- `DesktopNotInstalledError` 只包含平台安装路径和诊断标识符。
- `runDesktopInvocation(activator, io): Promise<number>` 将未安装映射到 stderr，且不调用 `RuntimeConnector`。

- [ ] **Step 1：编写失败 desktop 与跨客户端测试**

断言 `harness desktop` 只调用一次 activator，绝不调用 Runtime connect；未安装时将平台路径写到 stderr、非零退出，且不打开浏览器或启动 Electron。在验收 fixture 中，启动终端任务、连接 Web、确认二者观察相同 Runtime 会话标识；用 `--stop` 释放 Web 租约，并证明终端操作仍活动。所有断言都分别经过 `harness` 和 `dsh` 一次。

- [ ] **Step 2：运行 RED 测试**

运行：`pnpm exec vitest run apps/cli/tests/desktop.spec.ts apps/cli/tests/runtime-clients.acceptance.e2e.ts apps/cli/tests/source-launch.compat.spec.ts`

预期：FAIL，因为 desktop 尚不是命令，且兼容入口仍是 profile-only 分发路径。

- [ ] **Step 3：实现仅已安装应用分发**

加入 desktop 适配器和分发分支。它只能激活已注册安装应用或报告 `DesktopNotInstalledError`；不得 import `electron`、启动 Runtime、创建 handoff 或启动替代子进程。确保两个 bin 仍调用相同 `runCli` 解析器/分发器，差别仅为打印的兼容命令名。

- [ ] **Step 4：运行最终客户端验证**

运行：`pnpm exec vitest run apps/cli/tests/args.spec.ts apps/cli/tests/main.spec.ts apps/cli/tests/terminal-client.spec.ts apps/cli/tests/interactive-terminal.pty.e2e.ts apps/cli/tests/web-daemon.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/desktop.spec.ts apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/runtime-clients.acceptance.e2e.ts apps/cli/tests/source-launch.compat.spec.ts`

运行：`pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts apps/web/tests/runtime-bootstrap.snapshot.ts`

运行：

```powershell
pnpm run build
$env:DSH_EXAMPLE_MODE = 'lib'
try {
  pnpm exec vitest run apps/cli/tests/runtime-client.e2e.ts apps/cli/tests/interactive-terminal.pty.e2e.ts apps/cli/tests/web-runtime.e2e.ts apps/cli/tests/runtime-clients.acceptance.e2e.ts apps/cli/tests/source-launch.compat.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Built CLI Runtime verification failed.' }
} finally {
  Remove-Item Env:DSH_EXAMPLE_MODE -ErrorAction SilentlyContinue
}
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/runtime-bootstrap.e2e.ts
if ($LASTEXITCODE -ne 0) { throw 'Built Dashboard bootstrap e2e verification failed.' }
```

预期：源码和构建入口模式均 PASS。所有可见 CLI 诊断与快照无令牌；status 无启动副作用；没有测试证明第二个 Runtime 或客户端持久化写入。

- [ ] **Step 5：提交完成的客户端图**

运行：`git add apps/cli/src/desktop.ts apps/cli/src/main.ts apps/cli/tests/desktop.spec.ts apps/cli/tests/source-launch.compat.spec.ts apps/cli/tests/runtime-clients.acceptance.e2e.ts apps/cli/tests/web-daemon.snapshot.ts && git diff --cached --check && git commit -m "feat(cli): activate installed desktop client"`

## 自检

- 裸终端、初始任务、Ink 普通 scrollback 交互、slash controls、两阶段 Ctrl+C、resize/color、稳定 exit codes、`run --json`、Web handoff、租约别名、不会启动的 status、幂等的仅释放租约 stop、dsh 一致性和仅已安装 desktop 均有单独任务与聚焦测试。
- 每个触及 Runtime 的任务均使用基础 API，并禁止直接持久化、凭据、锁、端点、token 及第二 Runtime 所有权。CLI/Web 拥有 Desktop/Icon packaging 所消费的命令图、resolver/activator 和 stop 语义。
- 最终任务包括源码、构建、PTY、快照和跨客户端真实入口验证。没有实施指令编辑统一本地 Runtime 规格、README、除任务 2 已声明 CLI 例外之外的 manifest 或生成的 `.superpowers/dist` 输出。

计划已保存至 `docs/superpowers/plans/2026-08-18-harness-cli-web-runtime.zh.md`。可选择子代理驱动开发或带审查检查点的内联执行。
