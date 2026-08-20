# Agent Note: Harness Desktop 产品拓扑

Status: implemented

[English](2026-08-15-harness-desktop-product-topology.md) | 中文

## 问题

DeepSeek Harness 提供插件化 agent（智能体）运行时、浏览器应用、CLI（命令行界面）启动器、持久化和 SDK 进程协议。让每个产品客户端拥有自己的运行时会复制插件组合、设置、权限、会话语义和模型可见行为。把高权限 agent 工作放在 Electron 进程中还会把这些工作耦合到窗口与更新器生命周期。

Desktop、Web 和终端展示计划需要一个本地数据所有者，同时不能允许并发写入方分裂会话。所有权层还需要独立的进程恢复与私有浏览器认证路径，且不能把原生端点凭据暴露给浏览器代码。

## 决策

[`@harness-desktop/dsh-host-local-runtime`](../../../../packages/host/local-runtime/README.md) 为每个 `HARNESS_HOME` 实现一个按需本地运行时。该运行时拥有规范 Cordis 组合、持久化提供方、凭据引用、已认证本地 API、会话写入准入、端点记录和空闲生命周期。它是唯一向所选数据根目录下 Harness 自有状态写入的进程。

运行时在 `127.0.0.1` 上绑定由操作系统分配的端口。其所有者锁同时记录 PID 与进程启动身份；陈旧恢复只有在证明精确记录身份不存在后才替换记录。其私有端点记录仅当前操作系统用户可读，并携带原生控制使用的 token。

公开 `RuntimeConnector` 把端点发现与 token 保留在已认证请求闭包中。Dashboard 附加项把原生权限转换为 60 秒单次使用的 form-body handoff，随后转换为仅使用 cookie 且严格同源的浏览器会话。端点 token、handoff、会话凭据、所选 Harness home、凭据值和原始文件系统错误不进入公开值或浏览器脚本存储。

公开 `RuntimeClient`、`TerminalConnection` 与 `DashboardAttachment` API 在同一进程上提供独立附加项。逐会话写入准入、按所有者划分作用域的取消、活动工作计数、迁移事务和稳定的 `web` 后台租约都会在其精确操作期间保留运行时。有序关闭会在端点移除、锁释放与 Cordis dispose（资源释放）前结算控制工作和持久化 flush。

CLI Web 模式通过该公开 API 连接，使用仅正文 handoff 打开 Dashboard，并使用稳定的 `web` lease，而不是逐命令 Web 子进程。Runtime API 不向启动器暴露交换完成信号，因此启动器会在调度期间及 handoff 过期前保留仅当前用户可访问的 bootstrap。CLI 自然退出时，只把文档路径和现有过期时间移交给通过纯 Node 启动的分离辅助进程；该进程不继承 loader 参数、环境、handoff 或端点 token，并在该过期时间删除文档。

基础通过声明的构建版二进制与直接源码入口启动相同的完整基础与 Web 组合。终端、Web 与 Desktop 展示工作作为独立产品层消费该公开 API；仅有基础验收不会把这些展示客户端或跨客户端产品验收描述为已发货。

完整的当前运行时约定位于[包 README](../../../../packages/host/local-runtime/README.md)。更广泛的产品与发布约束仍位于 [Harness Desktop 产品架构设计](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md)，[统一本地运行时设计](../../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md)则把该决策映射到当前基础。

## 考虑过的替代方案

**Tauri 搭配 Node.js sidecar。** 这会减少一部分壳层体积，但增加 Rust 应用、sidecar 生命周期、两套依赖工具链，以及更多原生签名与打包交互。运行时仍依赖 Node.js、`node-pty` 和原生 loader，因此 Tauri 不会移除 Node 分发。

**由 Desktop 拥有 Host 子进程并让 CLI 使用独立运行时。** 这会为 Desktop 壳提供私有子进程，却让浏览器与终端客户端发现并修改不同的运行时实例。它无法为所有客户端提供一个写入方、一个受 token 保护的 API 或一个会话视图。

**在 Electron 主进程内运行 Harness。** 这会移除一次进程连接，却让 agent 崩溃、原生模块失败、插件 dispose 和终端清理影响窗口与更新器所有者。独立运行时为高权限工作提供独立生命周期。

**分别构建 Desktop 运行时和 CLI 运行时。** 客户端专用引擎可以分别优化各自接口，却会产生分叉的会话、权限、工具和模型行为。一个共享运行时将这些语义保留在一个所有者中。

## 后果

- 一个 `HARNESS_HOME`、一个进程身份锁与一个注入的 home 提供方定义持久化所有权单元。客户端无法绕过运行时而不违反产品拓扑。
- 回环端点与仅正文 handoff 增加了私有文件、origin、cookie、清理和响应验证义务，但浏览器代码绝不接收原生权限。
- 附加项与租约让客户端退出独立于活动工作，而空闲关闭需要显式计数与有序完全停稳。
- [包拥有的证据层级](../../../../packages/host/local-runtime/README.md#source-and-built-entry-points)分别固定构建版完整产品组合及公开连接器与控制、声明的源码 bin 在所需生成产物下的 Loader／模块／端点生命周期，以及通过显式后端 fixture（测试前置数据）进行的源码连接器与控制。Web UI、Desktop、打包和跨客户端展示验收仍属于下游工作。
- 用户 skill（技能）准入在 API 目录准入与 pre-step 定义加载之间仍有跨包区间。基础记录该 follow-up，而不宣称具有普遍 fail-closed 保证。
