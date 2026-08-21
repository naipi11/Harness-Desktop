# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包拥有[统一本地运行时设计](../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md)所述的共享本地 Harness 运行时。运行时是一个 `HARNESS_HOME` 的唯一持久化所有者。原生客户端使用其公开连接器与客户端 API，不直接打开会话、设置、工作区、存储或凭据引用状态。

## 配置与所有权

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

运行时在启动已发货的基础与 Web Cordis 组合前取得每个数据根目录的排他锁。一个注入的 `HarnessHomeProvider` 向每个写入方提供所选根目录。锁记录 PID 与操作系统进程启动身份；串行恢复保护器只有在证明该精确身份不存在后才替换陈旧记录，释放操作也只删除当前运行时所取得且未变化的锁。

## 私有端点与认证

组装后的 WebServer 在 `127.0.0.1` 上绑定由操作系统分配的端口。仅所有者可读的端点记录包含协议版本、运行时身份、端口、进程身份和私有访问 token。发布和移除使用受保护的同目录文件及原子重命名；移除操作会恢复已取得的替代记录，但不会覆盖更新的端点。

原生控制要求精确的回环 authority 与 bearer token。原生调用方创建一个 60 秒、单次使用、仅正文的 handoff。`POST /_harness/handoff` 只从一个 URL 编码表单正文接受该值，不发送 CORS 权限，并通过不带 expiry attribute 的会话 `HttpOnly; SameSite=Strict; Path=/` cookie 返回干净重定向。畸形、未知、过期或已重放的 handoff 会收到一个 no-store `403` HTML 恢复文档，其内容只有 `Dashboard connection expired. Run harness web to reconnect.`。Dashboard API 与事件请求需要该 cookie 和精确运行时 origin，从而提供仅使用 cookie 的 Dashboard 认证。启动器拥有的清理控制器会在分发、交换结算或过期后只删除其私有 bootstrap 文档与目录。

## 非披露保证

- 包根入口绝不导出端点解析器、写入方、文件名、私有记录、访问 token、handoff 密钥或浏览器会话凭据。
- URL、启动参数、诊断、transcript（文本记录）、浏览器脚本存储、Renderer IPC 和公开运行时值绝不包含这些密钥。
- 公开状态、迁移、租约、忙碌状态、活动工作、终端与诊断值绝不公开凭据值、原始文件系统错误或所选 Harness home。
- 已认证响应解析会把精确 private-token 泄露、绝对路径组件边界上的 selected-home 泄露、畸形字段、无效品牌化值，以及超过所配置字节或条目上限的值作为 `RuntimeProtocolError` 拒绝。

## 公开运行时 API 与失败

只有 `createRuntimeConnector()` 会发现端点，并将其 token 保留在已认证请求闭包中。`connect({ start: false })` 执行只读发现，在不创建数据根目录、锁、端点或进程的前提下抛出 `RuntimeUnavailableError`。`connect({ start: true })` 通过所有者锁串行化竞争启动，等待已认证的健康所有者，并把成功调用方附加到该运行时。

`RuntimeClient` 提供脱敏状态、稳定的 `web` 后台租约、耐久旧数据迁移、按所有者划分作用域的活动工作控制、终端附加项、Dashboard 附加项和独立关闭。`TerminalConnection` 通过已组装的 API 与 agent（智能体）所有者提交任务和审批，运行已注册的模型、权限、会话与命令控制，流式发送有界协议事件，只取消其关联操作，并且只关闭自身附加项。`DashboardAttachment` 创建仅正文 handoff 并独立释放。关闭附加项绝不取消活动工作。Dashboard 在 prompt 关联前停止工作或 Runtime 在此时关闭，都会中止该 carrier 的准入；发生竞态而迟到、且携带相同 `rpcId` 的消息会在 Agent 领取 Turn 前从 inbox 移除。

`RuntimeUnavailableError` 标识缺失，`RuntimeBusyError` 标识同一会话的写入方并携带其品牌化会话 id，`RuntimeProtocolError` 标识不兼容、畸形、超限或携带密钥的本地响应。`normalizeRecoveryDiagnostic()` 将这些错误及未知本地失败投影为稳定且不含 token、路径和密钥的恢复字段，并提供可复制的诊断 id。

## 迁移与提供方所有权

旧数据决定与结果存放在 `HARNESS_HOME` 下，并通过一个由运行时拥有的事务队列与私有运行时保留项。接受操作只把受支持的非秘密根目录复制一次到原本为空的目标；接受前的拒绝会持久化；重试只接受精确的可重试冲突或失败。并发调用方回放已提交结果，源目录始终保留，公开失败值只包含脱敏修正数据。

规范组合在同一所有权锁后挂载 API、Dashboard 资源、会话、设置、工作区、存储和凭据引用提供方。凭据值留在其凭据提供方中；只有引用进入运行时拥有的状态。

## 生命周期与租约

运行时计数实际客户端附加项、agent 工作和具名后台租约。只有三类计数都为零时才开始空闲关闭。迁移与终端控制事务会保留运行时直至结算；存在任何保留项时，直接 dispose（资源释放）会拒绝且不开始关闭。

有序关闭会关闭私有控制并结算其操作、flush 耐久会话、移除端点、释放锁，最后 dispose Cordis 根。所有阶段结算后才报告彼此独立的失败。后台保留让健康进程保持存活，但不监督或重启它。

## 源码与构建入口

构建版完整产品证据通过声明的 `lib/bin.js` 启动规范的基础与 Web 组合、加载构建版运行时产物，并针对该进程演练公开 `RuntimeConnector` 状态与后台租约控制。

声明的源码入口 `src/bin.ts` 会在执行 `pnpm run build:lib` 后启动相同组合，因为 Typert contribution 与浏览器 bundle 仍是生成的 `lib/` 产物。其直接 bin 进程证据观察源码模块加载、生成产物边界、端点发布、脱敏启动失败和关闭时的所有权清理；它本身并不证明公开连接器等价。

源码公开连接器与控制行为通过 Loader 启动的仅源码后端 fixture（测试前置数据）演练，其中禁止工作区 `lib/` 导入，并显式声明测试后端与回放 overlay。该证据验证源码包与控制兼容性，但不把 fixture 描述为完整产品源码 bin。产品展示层仍是 `RuntimeConnector` 与 `RuntimeClient` 的独立消费方。

## 模型体验

### 运行时所有权与控制

#### 模型所见内容

`RuntimeConnector` 发现、所有权、认证、状态、迁移、附加项、租约与诊断不添加提示词、消息、工具 schema 或工具结果。提交的终端任务通过既有会话 API 进入普通的耐久用户消息与 agent 轮次；运行时不添加传输包装层。

#### Token 影响

运行时控制不消耗模型 token。提交的任务及其回答正常消耗模型输入和输出 token。

#### KV Cache 影响

运行时元数据不改变模型请求前缀。模型可见任务与命令效果保留既有会话路径的缓存行为。

## 已知限制与延期工作

- **后台保留不是监督** — 具名 Web 租约不会在运行时崩溃、退出登录或升级后重启它。
- **skill（技能）准入仍有跨包竞态** — API 根据一次完整目录观察准入精确且可由用户调用的 skill，但其定义可能在 pre-step 消费方加载前发生变化。关闭该区间需要共享准入 token 或等价的 skill/API 事务；运行时不宣称该区间具有普遍 fail-closed 保证。
