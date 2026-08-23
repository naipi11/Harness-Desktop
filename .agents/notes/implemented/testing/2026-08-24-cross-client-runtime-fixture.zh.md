# Agent Note: 跨客户端运行时 fixture

Status: implemented

[English](2026-08-24-cross-client-runtime-fixture.md) | 中文

## 问题

CLI、Web 和 Desktop 验收需要一个共享的本地运行时以及耐久的工作区／会话证据，但特定于应用的 runner 无法安全共享浏览器、Electron、文件系统和进程 import。现有本地运行时测试可以检查私有端点记录和 replay fixture；如果跨客户端验收使用这些机制，验证的会是实现捷径，而不是产品 connector、Dashboard handoff、终端和 API 载体。

就绪和清理也需要一个可执行约束的所有者。端口、PID、锁或端点文件探测可能会在认证控制可用之前报告可用；如果在所有所属句柄和进程结束之前删除临时 home，则可能掩盖泄漏的工作。Cordis 不变式无法表达这种宿主进程关系，因为测试 fixture 不拥有 Cordis 事件流或可变服务数据。

## 决策

`@harness-desktop/dsh-cross-client-runtime` 是一个仅 Host 的测试支持包。其默认 fixture 创建一个临时根目录，使用普通的当前 Node 和经过清理的系统环境运行已声明的构建版 `harness-runtime` 二进制命令，启动公开 LLM mock 服务器，并通过测试 API key 与 `${baseURL}/v1` 配置运行时。最小 `standard` preset 让组装后的产品路径保持规范，同时不使用 replay 或私有源码后端。

就绪只重试公开的非启动 connector，并在已附加客户端的脱敏状态报告 `running` 后接受该运行时。共享状态通过使用 cookie 认证的 `AbstractApiClient` 子类创建和读取。fixture 从 `attachDashboard()` 和 `createBrowserHandoff()` 获取该 cookie，只接受干净、显式携带端口的回环 HTTP origin 以及指向 `/` 的 `303` 重定向，只在表单正文中提交 handoff，私下保留认证信息，并将每个 API 请求固定到返回的准确 origin。Dashboard 句柄只公开一个 capability 闭包，用于比较候选输出是否包含准确的 handoff 和 cookie 值。测试绝不读取端点记录、锁、SQLite、凭据存储、端口或进程标识符。

根 API 使用 `@harness-desktop/dsh-host-apiproxy/api` 的 `WorkspaceId` 和 `@harness-desktop/dsh-session/types` 的 `SessionId`，并公开工作区／会话／历史／提示词操作以及公开终端附加项。同一会话的争用必须返回携带尝试会话 id 的 `RuntimeBusyError`。CLI、Web 和 Desktop 进程或浏览器启动器仍是注入的仅 Node 适配器，因此 Playwright、Electron 和浏览器 fixture import 会留在应用所属的测试模块中。包含准确 fixture 根目录、测试 API key、保留的 handoff／cookie 值或 access-token／auth／cookie／handoff 标记的 CLI 结果会以同一个稳定脱敏操作错误失败。Fixture 绝不会接收端点 token，因此准确的端点 token 非披露仍由 local-runtime 测试负责，而不会在此新增测试 hook。

启动把同级目录创建视为一个事务：只有在每个尝试结束后才开始回滚。每个就绪状态异步公开操作都会在首次 await 之前同步进入准入计数器。运行时停止或清理会先改变状态，等待该计数器归零，再对每个应用句柄、终端、Dashboard、API 客户端和基础客户端执行关闭尝试。任何未确认关闭的所有者都会在运行时标准输入、mock 关闭或根目录删除之前中止清理；成功关闭的所有者会保留记录，失败的 one-flight 关闭以及静默前失败的停止／清理 flight 会被清除以供重试。状态改变后才创建的句柄会先注册并关闭，再返回拒绝，不会以存活状态返回。只有所有者全部关闭后，运行时关闭才会结束标准输入并恰好结束一次。随后 mock 关闭与根目录删除分别结算：mock 失败会保留根目录，根目录失败后的重试会跳过已关闭的 mock，已经结算的阶段绝不重复。已观测到的异常运行时退出只记录一个 stopped 事件，并在所有资源结束后保留其终态拒绝的停止／清理 flight。必须存在的 Cordis `./invariant` 配套项保持为有说明的空 installer。

## 验证

宿主测试注入文件系统、进程、健康状态、API 和应用适配器，验证根目录所有权、等待全部目录结束的启动回滚、非启动状态重试、状态观测、延迟状态／CLI／应用／终端操作的同步准入、迟到句柄关闭、清理顺序、永久所有者阻止清理、暂时性应用／终端关闭重试、成功的并发清理、异常停止幂等性、mock 先于根目录的顺序、mock／根目录独立重试、准确私有值和带标签标记的 CLI 拒绝、清理开始后的准入拒绝、稳定的独立失败聚合、强制终止兜底、启动失败清理、缺少停止事件时拒绝，以及禁止的浏览器／Electron／客户端 fixture 依赖。纳入覆盖率的 Dashboard 载体测试会拒绝不安全的 scheme／host／port／path／query／fragment／凭据、跨 origin cookie 请求、无效重定向响应，以及缺失或畸形的 cookie，同时验证仅正文 handoff 交换、准确 handoff／cookie 比较、值清除和不含密钥的诊断。构建产物通道导入该包构建后的公开入口，拒绝继承恶意 Node loader，然后通过规范运行时与公开 mock 服务器验证公开健康状态、工作区／会话／历史持久化、包含自动标题请求的成功场景、停滞的终端工作、准确的同一会话忙碌拒绝、取消和清理。V8 逐文件门禁只排除 `cross-client-defaults.ts`，其中已声明二进制命令、经过清理的进程环境、公开 mock 与公开 connector 的粘合代码会在插桩单元测试程序之外执行；生命周期、状态与 Dashboard 安全模块仍受 100% 逐文件门禁约束。

## 曾考虑的替代方案

**扩展浏览器侧客户端测试运行时**：不予采纳。其编译器面和 jsdom 依赖无法负责原生进程、文件系统根目录或 Electron 启动器，否则会混合 Host 与 Client 程序。

**检查运行时存储和端点文件**：不予采纳。它们属于私有恢复机制，并且可能在经过认证的载体不可用时让测试误判为就绪。直接格式测试仍由各自所属包负责。

**使用 replay 适配器或仅源码后端**：不予采纳。跨客户端发布验收必须执行交付的提供方路径和构建版运行时路径。公开 mock 服务器可以提供确定性的成功与停滞行为，而不会绕过 HTTP/SSE（Server-Sent Events）。

**对成功、标题生成和停滞使用一个混合 mock 脚本**：不予采纳。自动标题请求是独立的模型请求，其时序不应决定停滞步骤。构建验收使用独立的可重复成功 fixture 和可重复停滞 fixture。

**把宿主清理建模为 Cordis 运行时不变式**：不予采纳。没有权威的 Cordis 关系可以表示测试所属子进程。合成事件只能间接测试 fixture 记账；显式生命周期账本会直接观测所有者。

## 后果

三个应用 runner 都可以共享同一个构建版、已认证且不检查存储格式的 fixture，同时继续负责各自的呈现工具。就绪与清理声明来自公开状态和所属进程结果；稳定错误会保留彼此独立的失败阶段，但不公开 home 路径、提供方 key、handoff、cookie、端点 token 或私有原因。

该 fixture 有意仅供测试使用，并依赖预先存在的构建产物。应用测试必须注入启动器适配器；存储格式、凭据、端点、锁与应用渲染断言仍在该包之外。成功场景和停滞／忙碌场景使用不同的运行时生命周期，这会增加一次启动，但能避免与标题生成之间的请求顺序耦合。
