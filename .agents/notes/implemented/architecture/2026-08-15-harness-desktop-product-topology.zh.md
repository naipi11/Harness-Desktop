# Agent Note: Harness Desktop 产品拓扑

Status: implemented

[English](2026-08-15-harness-desktop-product-topology.md) | 中文

## 问题

DeepSeek Harness 提供 plugin-based agent runtime、browser application、CLI launcher、persistence 和 SDK process protocol。让每个产品客户端拥有自己的 runtime 会复制 plugin composition、settings、permissions、session semantics 和 model-visible behavior。把 privileged agent work 放在 Electron process 中还会把这些工作耦合到 window 与 updater lifecycle。

Desktop、Web 和 terminal 展示计划需要一个本地 data owner，同时不能允许并发 writer 分裂 session。Ownership layer 还需要独立 process recovery 与私有 browser-authentication 路径，且不能把 native endpoint credential 暴露给 browser code。

## 决策

[`@harness-desktop/dsh-host-local-runtime`](../../../../packages/host/local-runtime/README.md) 为每个 `HARNESS_HOME` 实现一个按需本地 Runtime。该 Runtime 拥有规范 Cordis composition、persistence provider、credential reference、已认证 local API、session-writer admission、endpoint record 和 idle lifetime。它是唯一向所选 home 下 Harness-owned state 写入的 process。

Runtime 在 `127.0.0.1` 上绑定由操作系统分配的端口。其 owner lock 同时记录 PID 与 process-start identity；stale recovery 只有在证明精确记录身份不存在后才替换记录。其 private endpoint record 仅当前操作系统用户可读，并携带 native control 使用的 token。

公开 `RuntimeConnector` 把 endpoint discovery 与 token 保留在已认证 request closure 中。Dashboard attachment 把 native authority 转换为 60 秒单次使用的 form-body handoff，随后转换为 cookie-only exact-origin browser session。Endpoint token、handoff、session credential、所选 Harness home、credential value 和原始 filesystem error 不进入 public value 或 browser script storage。

公开 `RuntimeClient`、`TerminalConnection` 与 `DashboardAttachment` API 在同一 process 上提供独立 attachment。Per-session writer admission、owner-scoped cancellation、active-work accounting、migration transaction 和稳定的 `web` background lease 都会在其精确 operation 期间保留 Runtime。有序关闭会在 endpoint retirement、lock release 与 Cordis disposal 前结算 control work 和 durable flush。

Foundation 通过声明的 built binary 与直接 source entry 启动相同的完整 base-and-Web composition。Terminal、Web 与 Desktop 展示工作作为独立产品层消费该公开 API；foundation acceptance 不会把这些展示客户端或 cross-client product acceptance 描述为已发货。

完整的当前 Runtime 约定位于[包 README](../../../../packages/host/local-runtime/README.md)。更广泛的产品与发布约束仍位于 [Harness Desktop 产品架构设计](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md)，[统一本地 Runtime 设计](../../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md)则把该决策映射到当前 foundation。

## 考虑过的替代方案

**Tauri with a Node.js sidecar.** 这会减少一部分 shell footprint，但增加 Rust application、sidecar lifecycle、两套 dependency toolchain，以及更多 native signing 与 packaging interaction。Runtime 仍依赖 Node.js、`node-pty` 和 native loader，因此 Tauri 不会移除 Node distribution。

**A desktop-owned Host child with a standalone CLI runtime.** 这会为 desktop shell 提供 private child，却让 browser 与 terminal client 发现并修改不同的 runtime instance。它无法为所有 client 提供一个 writer、一个 token-protected API 或一个 session view。

**Run Harness inside Electron main.** 这会移除一次 process connection，却让 agent crash、native module failure、plugin disposal 和 terminal teardown 影响 window 与 updater owner。独立 Runtime 为 privileged work 提供独立 lifecycle。

**Build a separate desktop runtime and CLI runtime.** Client-specific engine 可以分别优化各 interface，却会产生分叉的 session、permission、tool 和 model behavior。一个 shared Runtime 将这些 semantics 保留在一个 owner 中。

## 后果

- 一个 `HARNESS_HOME`、一个 process identity lock 与一个 injected home provider 定义 persistence ownership unit。Client 无法绕过 Runtime 而不违反产品拓扑。
- Loopback endpoint 与 body-only handoff 增加了 private-file、origin、cookie、cleanup 和 response-validation 义务，但 browser code 绝不接收 native authority。
- Attachment 与 lease 让 client exit 独立于 active work，而 idle shutdown 需要显式 accounting 与 ordered quiescence。
- Source 与 built process acceptance 固定相同的 public connector 与 canonical composition。CLI、Web、Desktop、packaging 和 cross-client presentation acceptance 仍属于下游工作。
- User-skill admission 在 API catalog admission 与 pre-step definition loading 之间仍有跨包区间。Foundation 记录该 follow-up，而不宣称具有普遍 fail-closed 保证。
