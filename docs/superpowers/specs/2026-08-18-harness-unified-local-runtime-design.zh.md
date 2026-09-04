# Harness 统一本地运行时设计

[English](2026-08-18-harness-unified-local-runtime-design.md) | 中文

## 状态与范围

本文映射由 [`@harness-desktop/dsh-host-local-runtime`](../../../packages/host/local-runtime/README.md) 实现的当前运行时基础。[Harness Desktop 产品拓扑 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md)拥有长期有效的理由和未采用拓扑。[Harness Desktop 产品架构设计](2026-08-15-harness-desktop-design.md)保留更广泛的展示、打包与发布计划。

基础提供一个共享本地进程、其持久化所有权、私有认证、迁移事务、生命周期计数和公开 Node API。CLI（命令行界面）、Web 与 Desktop 展示层在后续工作中消费该 API；这些展示层和跨客户端产品验收不属于本文所述的已发货基础。

## 运行时所有权

一个运行时进程拥有一个 `HARNESS_HOME`，并且是其唯一持久化写入方。它在启动规范的基础与 Web Cordis 组合前取得每个数据根目录的锁，再向 API、Dashboard 资源、会话、设置、工作区、存储和凭据引用提供方提供一个注入的 `HarnessHomeProvider`。

锁记录 PID 与操作系统进程启动身份。跨进程恢复保护器串行化身份探测与陈旧记录替换。存活或不可核验的身份保持权威；只有证明不存在的身份才允许替换。释放操作只删除当前运行时所取得且未变化的记录。

## 端点与 Dashboard 认证

运行时在 `127.0.0.1` 上绑定由操作系统分配的端口。其仅当前用户可读的端点记录包含协议版本、运行时身份、端口、进程身份和私有访问 token。受保护的同目录临时文件与原子重命名会发布和移除记录，且不会覆盖更新的所有者。

原生控制使用私有 bearer token 接受精确回环 authority。Dashboard 附加项签发一个 60 秒、单次使用的不透明 handoff，其值只通过一个 URL 编码表单正文传输。交换不发送 CORS 权限，并通过不带 expiry attribute 的会话 `HttpOnly; SameSite=Strict; Path=/` cookie 返回干净重定向。Dashboard API 与事件请求要求该 cookie 和精确运行时 origin。

端点 token、handoff 与会话凭据不进入公开导出、命令行、URL、诊断、transcript（文本记录）、浏览器脚本存储或 Renderer IPC。公开值也不包含凭据值、原始文件系统错误或所选 Harness home。已认证响应解析会在投影前拒绝畸形、超限、品牌无效、携带 token 或携带 selected-home 的值。

## 数据根目录与迁移

`HARNESS_HOME` 是唯一可写的 Harness 数据根目录。其平台默认值在 Windows 上为 `%LOCALAPPDATA%\Harness Desktop`，在 macOS 上为 `~/Library/Application Support/Harness Desktop`，在 Linux 上为 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。凭据值保留在其提供方中；运行时拥有的状态存储引用。

检测到的 `DSH_HOME` 是导入来源，绝不是第二个可写根目录。原生与已认证 Dashboard 请求共享一个由运行时拥有的事务和保留项。接受操作只把受支持的非秘密根目录复制一次到原本为空的目标；接受前的拒绝会持久化；重试只接受已记录的可重试结果；并发决定回放已提交结果。源目录保持完整，冲突或失败结果只公开脱敏修正数据。

## 公开运行时 API

只有 `createRuntimeConnector()` 会发现私有端点，并把 token 保留在已认证闭包中。`connect({ start: false })` 执行无副作用的状态附加并报告类型化缺失。`connect({ start: true })` 串行化竞争进程启动、等待一个已认证健康所有者，并把所有成功调用方附加到它。

`RuntimeClient` 提供脱敏状态、旧数据迁移、稳定的 `web` 后台租约、按所有者划分作用域的活动工作控制、终端附加项、Dashboard 附加项与独立关闭。`TerminalConnection` 使用已组装的会话、agent（智能体）、命令、模型、权限与审批所有者；其提交、控制、取消、事件与关闭操作保持在该附加项的作用域内。`DashboardAttachment` 创建仅正文浏览器导航并独立释放。

`RuntimeUnavailableError` 报告缺失。`RuntimeBusyError` 公开同一会话写入方的品牌化 `sessionId` 及其诊断 id；已认证协议中的 `session-busy` 结果携带结构化 `['observe', 'new-session', 'wait']` 恢复选项，错误类本身不公开这些选项。`RuntimeProtocolError` 报告不兼容或被拒绝的本地协议值。`normalizeRecoveryDiagnostic()` 返回稳定且不含密钥的恢复类别、对象、修正操作和关联 id，不反射未知本地错误文本。

## 生命周期与租约

存在客户端附加项、agent 工作、迁移或控制操作保留项，以及具名 `web` 后台租约时，运行时保持存活。关闭附加项绝不取消活动工作。取消只移除该请求尚未取得的 inbox 消息，或向精确的已取得操作发出信号，随后只等待其关联 `turn/end` 与租约清理。

只有每个保留项均不存在后才开始空闲关闭。它关闭私有控制并结算所拥有的操作、flush 耐久会话、移除端点、释放锁，最后 dispose（资源释放）Cordis 根。所有阶段结算后才报告彼此独立的失败。后台租约保留健康进程，但不监督或在崩溃、退出登录或升级后重启它。

## 源码与构建验收

[包证据约定](../../../packages/host/local-runtime/README.md#source-and-built-entry-points)区分三个层级。构建版完整产品证据从 `lib/bin.js` 启动规范组合，并演练公开连接器与控制行为。声明的 `src/bin.ts` 证据观察源码 Loader／模块选择、所需的生成 Typert／浏览器产物、端点发布和关闭清理。源码公开连接器与控制证据则使用显式的 Loader 启动后端 fixture（测试前置数据），同时禁止工作区 `lib/` 导入；它不确立直接源码 bin 等价。

这些证据只确立运行时基础。它不确立已安装的 `harness` 终端接口、Web 命令行为、Electron 展示、平台打包或三个客户端的收敛。

## 已知跨包 follow-up

用户 skill（技能）slash 准入会在插入请求前检查完整目录与按作用域注册的 pre-step 消费方。skill 定义仍可能在该 API 决定与消费方在 `agent/pre-step` 的加载之间发生变化；关闭该区间需要 skill 与 API 所有者之间的共享准入 token 或等价事务。因此基础不宣称该区间具有普遍 fail-closed 保证。
