# Harness 统一本地 Runtime 设计

[English](2026-08-18-harness-unified-local-runtime-design.md) | 中文

## 状态与范围

本文映射由 [`@harness-desktop/dsh-host-local-runtime`](../../../packages/host/local-runtime/README.md) 实现的当前 Runtime Foundation。[Harness Desktop 产品拓扑 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md)拥有长期有效的理由和未采用拓扑。[Harness Desktop 产品架构设计](2026-08-15-harness-desktop-design.md)保留更广泛的展示、打包与发布计划。

Foundation 提供一个共享本地 process、其 persistence ownership、private authentication、migration transaction、lifecycle accounting 和 public Node API。CLI、Web 与 Desktop 展示层在后续工作中消费该 API；这些展示层和 cross-client product acceptance 不属于本文所述的已发货 foundation。

## Runtime 所有权

一个 Runtime process 拥有一个 `HARNESS_HOME`，并且是其唯一 persistence writer。它在启动规范 base-and-Web Cordis composition 前取得每个 home 的 lock，再向 API、Dashboard asset、session、settings、workspace、storage 和 credential-reference provider 提供一个 injected `HarnessHomeProvider`。

Lock 记录 PID 与操作系统 process-start identity。Cross-process recovery guard 串行化 identity probing 与 stale replacement。存活或不可核验的身份保持权威；只有证明不存在的身份才允许替换。Release 只删除当前 Runtime 所取得且未变化的记录。

## Endpoint 与 Dashboard 认证

Runtime 在 `127.0.0.1` 上绑定由操作系统分配的端口。其仅当前用户可读的 endpoint record 包含 protocol version、Runtime identity、port、process identity 和 private access token。受保护的同目录 temporary file 与 atomic rename 会发布和移除记录，且不会覆盖更新 owner。

Native control 使用 private bearer token 接受精确 loopback authority。Dashboard attachment 签发一个 60 秒、单次使用的不透明 handoff，其值只通过一个 URL 编码 form body 传输。Exchange 不发送 CORS permission，并通过不带 expiry attribute 的 session `HttpOnly; SameSite=Strict; Path=/` cookie 返回干净重定向。Dashboard API 与 event 请求要求该 cookie 和精确 Runtime origin。

Endpoint token、handoff 与 session credential 不进入 public export、command line、URL、diagnostic、transcript、browser script storage 或 Renderer IPC。Public value 也不包含 credential value、原始 filesystem error 或所选 Harness home。已认证 response parsing 会在投影前拒绝畸形、超限、invalid-branded、携带 token 或携带 selected-home 的值。

## 数据根目录与迁移

`HARNESS_HOME` 是唯一可写的 Harness 数据根目录。其平台默认值在 Windows 上为 `%LOCALAPPDATA%\Harness Desktop`，在 macOS 上为 `~/Library/Application Support/Harness Desktop`，在 Linux 上为 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。Credential value 保留在其 provider 中；Runtime-owned state 存储 reference。

检测到的 `DSH_HOME` 是 import source，绝不是第二个 writable root。Native 与已认证 Dashboard request 共享一个 Runtime-owned transaction 和 retainer。Acceptance 只把受支持的非秘密根目录复制一次到原本为空的目标；acceptance 前的 decline 会持久化；retry 只接受已记录的可重试结果；并发 decision 回放已提交 outcome。Source directory 保持完整，collision 或 failure result 只公开脱敏 correction data。

## 公开 Runtime API

只有 `createRuntimeConnector()` 会发现 private endpoint，并把 token 保留在已认证 closure 中。`connect({ start: false })` 执行无副作用的 status attachment 并报告类型化 absence。`connect({ start: true })` 串行化竞争 process start、等待一个已认证健康 owner，并把所有成功调用方附加到它。

`RuntimeClient` 提供脱敏 status、legacy migration、稳定的 `web` background lease、owner-scoped active-work control、terminal attachment、Dashboard attachment 与独立 close。`TerminalConnection` 使用已组装的 session、Agent、command、model、permission 与 approval owner；其 submit、control、cancellation、event 与 close operation 保持在该 attachment 的 scope 内。`DashboardAttachment` 创建 body-only browser navigation 并独立释放。

`RuntimeUnavailableError` 报告 absence，`RuntimeBusyError` 报告同一 session 的 writer 与 recovery choice，`RuntimeProtocolError` 报告不兼容或被拒绝的 local protocol value。`normalizeRecoveryDiagnostic()` 返回稳定且不含 secret 的 recovery category、subject、correction 和 correlation id，不反射未知本地 error text。

## 生命周期与 lease

存在 client attachment、Agent work、migration 或 control-operation retainer，以及具名 `web` background lease 时，Runtime 保持存活。关闭 attachment 绝不取消 active work。Cancellation 只移除该 request 尚未 claim 的 inbox message，或向精确的已 claim operation 发出信号，随后只等待其关联 `turn/end` 与 lease cleanup。

只有每个 retainer 均不存在后才开始 idle shutdown。它关闭 private control 并结算所拥有的 operation、flush 耐久 session、移除 endpoint、释放 lock，最后 dispose Cordis root。所有阶段结算后才报告彼此独立的 failure。Background lease 保留健康 process，但不监督或在 crash、sign-out 或 upgrade 后重启它。

## 源码与构建验收

包声明的 `lib/bin.js` 与直接 `src/bin.ts` 开发入口启动相同的 canonical composition。Source startup 保留其 TypeScript launcher requirement，并消费 build-generated Typert 与 browser artifact；built startup 运行已发布 JavaScript 路径。真实 process acceptance 将 public connector 附加到两个入口，并验证 shared ownership、authentication、lifecycle、control 与 redacted protocol behavior。

这些 evidence 只确立 Runtime Foundation。它不确立已安装的 `harness` terminal interface、Web command behavior、Electron presentation、platform packaging 或 three-client convergence。

## 已知跨包 follow-up

User-skill slash admission 会在插入 request 前检查 complete catalog 与 scoped pre-step consumer。Skill definition 仍可能在该 API decision 与 consumer 在 `agent/pre-step` 的 load 之间发生变化；关闭该区间需要 skill 与 API owner 之间的 shared admission token 或等价 transaction。因此 foundation 不宣称该区间具有普遍 fail-closed 保证。
