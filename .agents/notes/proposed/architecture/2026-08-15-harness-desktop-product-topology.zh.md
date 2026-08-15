# Agent Note: Harness Desktop 产品拓扑

Status: proposed

[English](2026-08-15-harness-desktop-product-topology.md) | 中文

## 问题

DeepSeek Harness 已提供插件化 agent 运行时、浏览器应用、CLI 启动器、持久化和 SDK 进程协议，但尚未形成一个在 Windows、macOS 与 Linux 上原生分发、具有独立品牌的桌面与终端产品。如果为两种客户端添加相互独立的运行时，就会复制插件组合、设置、权限、会话语义和模型可见行为。在 Electron Renderer 或主进程中运行 agent 也会把高权限工作与窗口生命周期耦合。

产品需要一个共享持久本地数据的桌面应用和交互式 CLI，同时不允许并发写入者破坏同一会话。产品还需要能够脱离上游名称的对外品牌与发布系统，但不能为此对已安装数据执行不安全的一步式迁移。

## 提案

Harness Desktop 使用 Electron 作为桌面壳，并复用现有 React/Vite 客户端包。Electron 主进程监管完整的 Harness Host 子进程，并通过现有 stdio JSON-RPC 协议通信。Renderer 代码只能获得带版本的 preload API，绝不获得 Node.js 或凭据访问权限。

`harness` CLI 在自身 Node.js 进程中组合相同的 Harness 运行时，并提供交互式、非交互式和 JSONL 模式。Desktop 与 CLI 共享设置、凭据引用和会话存储。基于 SQLite 的会话租约服务允许并发读取者和一个写入者，支持协作接管，并且只在证明记录的进程身份已经死亡后恢复失效所有者。

对外产品使用 Harness Desktop、仓库 `Harness-Desktop`、命令 `harness`、应用标识符 `io.github.naipi11.harness-desktop` 和 npm 包 `@harness-desktop/cli`。第一个稳定版本保留 `dsh` 别名和现有数据布局。初始迁移期间，内部上游 scope 包名继续作为私有实现细节，公开产物则打包自身的运行时依赖。

Desktop 发布使用 Electron Builder、已签名原生产物、GitHub Releases、自动更新与回滚元数据。完整产品行为、平台矩阵、安全规则、实施工作流和验证要求定义在 [Harness Desktop 产品架构设计](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md) 中。

## 曾考虑的替代方案

**Tauri 搭配 Node.js sidecar。** 这会减小一部分壳层体积，但也会引入 Rust 应用、sidecar 生命周期、两套依赖工具链，以及更多原生签名和打包交互。现有运行时已经依赖 Node.js、`node-pty` 和原生 loader，因此 Tauri 无法移除 Node 分发，反而会增加第一版风险。

**永久本地服务搭配轻量桌面壳。** 共享 daemon 可以直接支持多客户端实时连接，但它要求在本地产品闭环出现之前解决服务安装、端口或 socket 发现、认证、版本协商、空闲策略和升级协调。子进程协议保留了未来引入 broker 的路径，同时不把系统服务变成第一版前提。

**在 Electron 主进程内运行 Harness。** 这可以避免子进程，但会让 agent 崩溃、原生模块失败、插件资源释放和终端清理影响窗口与更新器的所有者。受监管的 Host 子进程为高权限运行时提供明确的协议与故障边界，同时复用现有 SDK 传输。

**分别构建 Desktop 运行时和 CLI 运行时。** 客户端专用引擎可以独立优化各自界面，但会产生不同的会话、权限、工具和模型行为。共享一套运行时是产品不变式。

## 验收标准

- `apps/desktop` 通过强类型 preload API 和受监管的 Harness Host 子进程运行沙箱化 Renderer。
- `harness` 在当前目录交互运行，`run --json` 则提供 stdout 纯净的机器输出和稳定退出码。
- Desktop 与 CLI 读取相同设置和会话，拒绝第二个写入者，并在不发生脑裂的前提下完成协作式会话接管。
- 源码模式支持安装版命令图，包括 `harness web --background`。
- Windows、macOS 与 Linux 发布任务安装并运行真实 Desktop 和 CLI 产物。
- 稳定版 Desktop 产物经过签名，更新 manifest 得到校验，并在发布前演练回滚。
- 兼容名称共享同一实现，不能创建第二套数据布局。

## 风险

- Electron 产物比系统 WebView 壳更大，并要求严格执行 Renderer 隔离。
- 双名称兼容期可能让旧品牌持续存在，因此所有用户可见字符串必须来自集中式产品元数据。
- 跨进程会话租约必须使用进程启动身份和事务顺序，避免 PID 复用与脑裂恢复。
- 各平台的原生凭据存储与签名身份不同；缺少安全集成时必须失败，不能回退到明文。
- 捆绑式独立 CLI 压缩包会增大发布体积，但能避免未经测试的系统 Node.js 与原生模块组合。
