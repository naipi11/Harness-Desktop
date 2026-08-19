# Agent Note: Harness Desktop 产品拓扑

Status: proposed

[English](2026-08-15-harness-desktop-product-topology.md) | 中文

## 问题

DeepSeek Harness 已提供插件化 agent 运行时、浏览器应用、CLI 启动器、持久化和 SDK 进程协议，但尚未形成一个在 Windows、macOS 与 Linux 上原生分发、具有独立品牌的桌面、浏览器和终端产品。如果让每个客户端各自拥有运行时，就会复制插件组合、设置、权限、会话语义和模型可见行为。在 Electron Renderer 或主进程中运行 agent 也会把高权限工作与窗口生命周期耦合。

产品需要桌面、Web 和终端客户端共享一个本地数据根目录，同时不允许并发写入者破坏同一会话。产品还需要能够脱离上游名称的对外品牌与发布系统，但不能为此对已安装数据执行不安全的一步式迁移。

## 提案

Harness Desktop 为每个 `HARNESS_HOME` 使用按需启动、属于当前用户的本地 Runtime。Runtime 拥有 Harness 插件组合、持久化、凭据引用、本地 API、会话写入顺序、端点记录和空闲生命周期。它只绑定随机的 `127.0.0.1` 端口。原生 CLI 启动器和 Electron 主进程使用端点 token；提议的 launcher 拥有只允许当前用户访问的不透明 file bootstrap，其高熵、一次性 handoff 标识符只作为发往该 `127.0.0.1` Runtime 的 hidden `POST` body field 出现，在 60 秒内过期，并交换为干净 redirect 加 `HttpOnly; SameSite=Strict; Path=/` cookie。URL、launch arguments、日志和 Renderer 不接收密钥，launcher 在 exchange result 或 expiry 后删除 bootstrap file。带进程启动身份的原子锁保护陈旧状态恢复。

Electron 提供桌面壳并复用现有 React/Vite Dashboard。它的主进程启动或连接 Runtime，而沙箱化 Renderer 只获得用于原生操作与恢复诊断的带版本 preload API。Renderer 绝不获得 Node.js、凭据、数据根目录、token 或子进程访问。

`harness` 终端客户端、`harness web` Dashboard 启动器和 `harness desktop` 应用启动器都启动或连接同一个 Runtime。它们提供交互式、非交互式、JSONL、浏览器和桌面流程，但不直接写入状态。会话写入服务允许并发读取者和一个写入者，支持协作接管，并且只在证明记录的进程身份已经死亡后恢复失效所有者。

`harness web --daemon` 和 `harness web --background` 创建同一种显式 Runtime 租约。`harness web --status` 不启动 Runtime，只报告已有 Runtime 的脱敏状态；`harness web --stop` 只释放该租约，不取消工作或断开其他客户端。

对外产品使用 Harness Desktop、仓库 `Harness-Desktop`、命令 `harness`、应用标识符 `io.github.naipi11.harness-desktop` 和 npm 包 `@harness-desktop/cli`。第一个稳定版本保留 `dsh` 别名，并提供只复制的旧 `DSH_HOME` 导入。初始迁移期间，内部上游 scope 包名继续作为私有实现细节，公开产物则打包自身的运行时依赖。

Desktop 发布使用 Electron Builder、已签名原生产物、GitHub Releases、自动更新与回滚元数据。完整的 Runtime 行为、公开命令、安全规则和验证要求定义在 [Harness 统一本地 Runtime 设计](../../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md) 中；更广泛的产品和发布约束仍见 [Harness Desktop 产品架构设计](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md)。

## 曾考虑的替代方案

**Tauri 搭配 Node.js sidecar。** 这会减小一部分壳层体积，但也会引入 Rust 应用、sidecar 生命周期、两套依赖工具链，以及更多原生签名和打包交互。现有运行时已经依赖 Node.js、`node-pty` 和原生 loader，因此 Tauri 无法移除 Node 分发，反而会增加第一版风险。

**由 Desktop 拥有 Host 子进程并让 CLI 独立运行。** 这会简化第一版桌面壳，但会让浏览器和终端客户端发现并修改不同的运行时实例。它无法让三个客户端拥有同一个写入者、同一个受 token 保护的 API 或同一个会话视图，因此改用按需启动的本地 Runtime。

**在 Electron 主进程内运行 Harness。** 这可以避免 Runtime 连接，但会让 agent 崩溃、原生模块失败、插件资源释放和终端清理影响窗口与更新器的所有者。独立的 Runtime 让高权限工作拥有明确的生命周期，而桌面客户端可以独立恢复或退出。

**分别构建 Desktop 运行时和 CLI 运行时。** 客户端专用引擎可以独立优化各自界面，但会产生不同的会话、权限、工具和模型行为。共享一套运行时是产品不变式。

## 验收标准

- 本地 Runtime 拥有一个 `HARNESS_HOME`，只绑定 loopback，将端点 token 限制给原生启动器，为浏览器 Dashboard 提供只允许当前用户访问的不透明 file bootstrap，其中高熵、一次性、最长 60 秒的 hidden-body handoff 交换为干净 cookie redirect，并且只在验证进程身份后清理陈旧所有者。
- `apps/desktop` 通过强类型 preload API 在沙箱化 Renderer 中运行真实 Dashboard 并连接 Runtime。
- `harness` 在当前目录交互运行，`run --json` 则提供 stdout 纯净的机器输出和稳定退出码。
- Desktop、Web 和 CLI 读取相同设置和会话，拒绝第二个写入者，并在不发生脑裂的前提下完成协作式会话接管。
- 源码模式支持安装版命令图，包括 `harness web --background`、`harness web --status`、`harness web --stop` 和 `harness desktop`。
- Windows、macOS 与 Linux 发布任务安装并运行真实 Desktop 和 CLI 产物。
- 兼容名称共享同一实现，不能创建第二套数据布局。

## 风险

- Electron 产物比系统 WebView 壳更大，并要求严格执行 Renderer 隔离。
- 双名称兼容期可能让旧品牌持续存在，因此所有用户可见字符串必须来自集中式产品元数据。
- Runtime 端点和会话所有权恢复必须使用进程启动身份和事务顺序，避免 PID 复用与脑裂恢复。
- 各平台的原生凭据存储与签名身份不同；缺少安全集成时必须失败，不能回退到明文。
- 捆绑式独立 CLI 压缩包会增大发布体积，但能避免未经测试的系统 Node.js 与原生模块组合。
