# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包拥有[统一本地 Runtime 设计](../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md)所述的共享本地 Harness Runtime。Runtime 是一个 `HARNESS_HOME` 的唯一持久化 owner。原生客户端使用其公开 connector 与 client API，不直接打开 session、settings、workspace、storage 或 credential-reference 状态。

## 配置与所有权

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

Runtime 在启动已发货的 base-and-Web Cordis 组合前取得每个 home 的排他锁。一个注入的 `HarnessHomeProvider` 向每个 writer 提供所选根目录。锁记录 PID 与操作系统进程启动身份；串行 recovery guard 只有在证明该精确身份不存在后才替换陈旧记录，释放操作也只删除当前 Runtime 所取得且未变化的锁。

## 私有 endpoint 与认证

组装后的 WebServer 在 `127.0.0.1` 上绑定由操作系统分配的端口。仅 owner 可读的 endpoint 记录包含协议版本、Runtime 身份、端口、进程身份和私有访问 token。发布和移除使用受保护的同目录文件及原子重命名；移除操作会恢复已 claim 的 replacement，但不会覆盖更新的 endpoint。

原生控制要求精确的 loopback authority 与 bearer token。原生调用方创建一个 60 秒、单次使用、仅正文的 handoff。`POST /_harness/handoff` 只从一个 URL 编码表单正文接受该值，不发送 CORS permission，并通过不带 expiry attribute 的 session `HttpOnly; SameSite=Strict; Path=/` cookie 返回干净重定向。Dashboard API 与 event 请求需要该 cookie 和精确 Runtime origin，从而提供 cookie-only Dashboard authentication。launcher 拥有的 cleanup controller 会在 dispatch、exchange settlement 或 expiry 后只删除其私有 bootstrap document 与目录。

## 非披露保证

- 包根入口绝不导出 endpoint parser、writer、filename、private record、access token、handoff secret 或 browser session credential。
- URL、launch argument、diagnostic、transcript、browser script storage、Renderer IPC 和公开 Runtime 值绝不包含这些 secret。
- 公开 status、migration、lease、busy、active-work、terminal 与 diagnostic 值绝不公开 credential value、原始 filesystem error 或所选 Harness home。
- 已认证 response parsing 会把精确 private-token 泄露、绝对路径组件边界上的 selected-home 泄露、畸形字段、无效 branded value，以及超过所配置 byte 或 item 上限的值作为 `RuntimeProtocolError` 拒绝。

## 公开 Runtime API 与失败

只有 `createRuntimeConnector()` 会发现 endpoint，并将其 token 保留在已认证 request closure 中。`connect({ start: false })` 执行只读发现，在不创建 home、lock、endpoint 或 process 的前提下抛出 `RuntimeUnavailableError`。`connect({ start: true })` 通过 owner lock 串行化竞争启动，等待已认证的健康 owner，并把成功调用方附加到该 Runtime。

`RuntimeClient` 提供脱敏 status、稳定的 `web` background lease、耐久 legacy migration、owner-scoped active-work control、terminal attachment、Dashboard attachment 和独立 close。`TerminalConnection` 通过已组装的 API 与 Agent owner 提交 task 和 approval，运行已注册的 model、permission、session 与 command control，流式发送有界 protocol event，只取消其关联 operation，并且只关闭自身 attachment。`DashboardAttachment` 创建 body-only handoff 并独立释放。关闭 attachment 绝不取消活动 work。

`RuntimeUnavailableError` 标识缺失，`RuntimeBusyError` 标识同一 session 的 writer 并携带其 branded session id，`RuntimeProtocolError` 标识不兼容、畸形、超限或携带 secret 的本地 response。`normalizeRecoveryDiagnostic()` 将这些错误及未知本地失败投影为稳定且不含 token、path 和 secret 的 recovery field，并提供可复制的 diagnostic id。

## 迁移与提供方所有权

旧数据决定与结果存放在 `HARNESS_HOME` 下，并通过一个 Runtime-owned transaction queue 与私有 Runtime retainer。接受操作只把受支持的非秘密根目录复制一次到原本为空的目标；接受前的拒绝会持久化；retry 只接受精确的可重试 collision 或 failure。并发调用方回放已提交结果，source directory 始终保留，公开 failure value 只包含脱敏 correction data。

规范组合在同一 ownership lock 后挂载 API、Dashboard asset、session、settings、workspace、storage 和 credential-reference provider。Credential value 留在其 credential provider 中；只有 reference 进入 Runtime-owned state。

## 生命周期与 lease

Runtime 计数实际 client attachment、Agent work 和具名 background lease。只有三类计数都为零时才开始空闲关闭。Migration 与 terminal-control transaction 会保留 Runtime 直至结算；存在任何 retainer 时，直接 dispose 会拒绝且不开始关闭。

有序关闭会关闭 private control 并结算其 operation、flush 耐久 session、移除 endpoint、释放 lock，最后 dispose Cordis root。所有阶段结算后才报告彼此独立的失败。Background retention 让健康进程保持存活，但不监督或重启它。

## 源码与构建入口

声明的 `lib/bin.js` 与直接开发入口 `src/bin.ts` 启动相同的完整组合。源码入口需要先执行 `pnpm run build:lib`，因为 Typert contribution 与 browser bundle 是生成产物。源码和构建 process acceptance 通过这些真实入口演练公开 connector；产品展示层仍是 `RuntimeConnector` 与 `RuntimeClient` 的独立 consumer。

## 模型体验

### Runtime 所有权与控制

#### 模型所见内容

`RuntimeConnector` discovery、ownership、authentication、status、migration、attachment、lease 与 diagnostic 不添加 prompt text、message、tool schema 或 tool result。提交的 terminal task 通过既有 session API 进入普通的耐久 user message 与 Agent turn；Runtime 不添加 transport wrapper。

#### Token 影响

Runtime control 不消耗模型 token。提交的 task 及其回答正常消耗模型输入和输出 token。

#### KV Cache 影响

Runtime metadata 不改变模型 request prefix。模型可见 task 与 command effect 保留既有 session 路径的 cache 行为。

## 已知限制与延期工作

- **Background retention 不是 supervision** — 具名 Web lease 不会在 Runtime crash、sign-out 或 upgrade 后重启它。
- **Skill admission 仍有跨包 race** — API 根据一次完整 catalog observation 准入精确且 user-invocable 的 skill，但其 definition 可能在 pre-step consumer 加载前发生变化。关闭该区间需要共享 admission token 或等价的 skill/API transaction；Runtime 不宣称该区间具有普遍 fail-closed 保证。
