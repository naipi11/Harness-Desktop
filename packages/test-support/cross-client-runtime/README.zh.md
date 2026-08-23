# `@harness-desktop/dsh-cross-client-runtime`

[English](README.md) | 中文

用于验收测试的仅宿主 fixture（测试前置数据），让 CLI（命令行界面）、Web 和 Desktop 附加到同一个规范本地运行时。该包属于测试基础设施，不是产品客户端 API。

## Fixture API

`createCrossClientFixture()` 创建一个临时根目录，其中包含全新的 `HARNESS_HOME`、平台 home 和工作区。默认路径通过当前 Node 可执行文件启动已声明的构建版 `harness-runtime` 二进制命令，启动公开的 `@harness-desktop/dsh-llm-mock-server`，并且只重试 `createRuntimeConnector(...).connect({ start: false })` 及 `status().state === 'running'` 来判断就绪。它不读取端点记录、锁、SQLite、凭据存储、端口或进程标识符。

`CrossClientFixture` 公开工作区和会话创建、工作区／会话／历史读取、提示词提交、公开终端附加项、同一会话的 `RuntimeBusyError` 验证、注入的 CLI／Web／Desktop 启动器、显式运行时停止、清理和无 token 的生命周期观测。工作区观测使用 `@harness-desktop/dsh-host-apiproxy/api` 的 `WorkspaceId`，会话观测使用 `@harness-desktop/dsh-session/types` 的 `SessionId`；该包不引入新的标识符品牌。

经过认证的状态客户端来自公开的 Dashboard 附加项和一次仅正文浏览器 handoff。该载体只接受干净、显式携带端口的回环 HTTP origin、指向 `/` 的 `303` 重定向，以及名称和值均非空的 cookie 对。宿主 `AbstractApiClient` 子类私下保留该 cookie，并拒绝准确 origin 之外的请求。一个 capability 闭包会检查输出是否包含准确的 handoff 和 cookie 值，但不会公开这些值。Fixture 会拒绝准确的 API key 和 home 路径，以及 access-token／auth／cookie／handoff 标记。它绝不会接收运行时端点 token；准确的端点 token 非披露仍由 local-runtime 所有者测试执行。

## 生命周期

Fixture 启动会等待每个同级目录创建尝试结束后再回滚，因此延迟的 mkdir 无法在清理后重新创建所属根目录。每个就绪状态异步操作都会在首次 await 之前同步获得准入。运行时停止或清理会先改变状态，等待已准入集合结束，然后在关闭运行时标准输入并按需使用有界强制终止兜底之前，关闭完整的应用／终端／Dashboard／API／基础客户端快照。状态改变后才到达的句柄会先注册并关闭，再返回拒绝，不会以存活状态返回。任何未确认关闭的所有者都会在运行时标准输入、mock 关闭或根目录删除之前中止清理；失败的停止／清理 flight 会被清除，因此后续调用只重试尚未解决的所有者。`dispose()` 只有在确认每个所有者和运行时退出后才关闭 mock 服务器并删除显式临时根目录。成功的并发调用共享同一个结果，失败会返回不含私有原因的稳定清理阶段错误。

`assertCrossClientLifecycle()` 要求按顺序恰好出现一次 `started`、`health-confirmed` 和 `stopped` 事件。`./invariant` Cordis 配套项有意留空，因为该包不拥有 Cordis 事件或可变数据关系；宿主 fixture 测试负责执行生命周期账本约束。

## 应用适配器

CLI、Web 和 Desktop 测试注入仅 Node 适配器。适配器接口不包含 Playwright、Electron、浏览器或浏览器侧 `client-runtime` import，因此每个应用测试都会在自身模块中保留所属 runner 的启动和呈现断言。

## 模型体验

无，因为 fixture 只驱动普通的公开提示词和终端操作，所有模型可见输入均由规范运行时的组合插件负责。

#### KV Cache 影响

无直接影响；每个隔离运行时和 mock 场景都有独立的请求历史，fixture 不会添加、保留或重写模型请求前缀。

## 已知限制与暂缓事项

- **仅供测试的载体**：fixture 支持用于验收测试的公开运行时 connector、终端、Dashboard handoff 和 API 载体；它不是应用集成 API。
- **应用启动器需要注入**：CLI、Web 和 Desktop 模块必须先提供各自 runner 的适配器，才能调用 `runCli()`、`openWeb()` 或 `openDesktop()`。
- **不检查存储或凭据**：持久化、锁、端点与凭据断言仍由各自所属包负责；该 fixture 只观测公开健康状态和经过认证的 API 状态。
