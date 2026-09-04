# `@harness-desktop/dsh-cross-client-runtime`

[English](README.md) | 中文

用于验收测试的仅宿主 fixture（测试前置数据），让 CLI（命令行界面）、Web 和 Desktop 附加到同一个规范本地运行时。该包属于测试基础设施，不是产品客户端 API。

## Fixture API

`createCrossClientFixture()` 创建一个临时根目录，其中包含全新的 `HARNESS_HOME`、平台 home 和工作区。即使父进程定义了 `DSH_HOME`，默认路径也不会把它传给运行时；该路径通过当前 Node 可执行文件启动已声明的构建版 `harness-runtime` 二进制命令，启动公开的 `@harness-desktop/dsh-llm-mock-server`，并且只重试 `createRuntimeConnector(...).connect({ start: false })` 及 `status().state === 'running'` 来判断就绪。它不读取端点记录、锁、SQLite、凭据存储、端口或进程标识符。

`CrossClientFixture` 公开工作区和会话创建、工作区／会话／历史读取、提示词提交、公开终端附加项、同一会话的 `RuntimeBusyError` 验证、注入的 CLI／Web／Desktop 启动器、显式运行时停止、清理和无 token 的生命周期观测。工作区观测使用 `@harness-desktop/dsh-host-apiproxy/api` 的 `WorkspaceId`，会话观测使用 `@harness-desktop/dsh-session/types` 的 `SessionId`；该包不引入新的标识符品牌。

经过认证的状态客户端来自公开的 Dashboard 附加项和一次仅正文浏览器 handoff。该载体只接受干净、显式携带端口的回环 HTTP origin、指向 `/` 的 `303` 重定向，以及名称和值均非空的 cookie 对。宿主 `AbstractApiClient` 子类私下保留该 cookie，并拒绝准确 origin 之外的请求。一个 capability 闭包会检查输出是否包含准确的 handoff 和 cookie 值，但不会公开这些值。Fixture 会拒绝准确的 API key 和 home 路径，以及 access-token／auth／cookie／handoff 标记。它绝不会接收运行时端点 token；准确的端点 token 非披露仍由 local-runtime 所有者测试执行。

## 生命周期

Fixture 启动会等待每个同级目录创建尝试结束后再回滚，因此延迟的 mkdir 无法在清理后重新创建所属根目录。每个就绪状态异步操作都会在首次 await 之前同步获得准入。运行时停止或清理会先改变状态，等待已准入集合结束，然后在关闭运行时标准输入并按需使用有界强制终止兜底之前，关闭完整的应用／终端／Dashboard／API／基础客户端快照。状态改变后才到达的句柄会先注册并关闭，再返回拒绝，不会以存活状态返回。任何未确认关闭的所有者都会在运行时标准输入、mock 关闭或根目录删除之前中止清理；失败的停止／清理 flight 会被清除，因此后续调用只重试尚未解决的所有者。Mock 关闭和根目录删除各自保留独立结果：mock 失败会保留根目录，根目录失败时重试不会再次关闭 mock，已经删除的根目录也绝不会再次删除。异常退出只记录一个 stopped 事件；mock 和根目录结束后会保留其终态拒绝的停止／清理 flight，因此重复清理会返回同一个错误而不重复执行。成功的并发调用共享同一个结果，失败会返回不含私有原因的稳定清理阶段错误。

`assertCrossClientLifecycle()` 要求按顺序恰好出现一次 `started`、`health-confirmed` 和 `stopped` 事件。`./invariant` Cordis 配套项有意留空，因为该包不拥有 Cordis 事件或可变数据关系；宿主 fixture 测试负责执行生命周期账本约束。

## 应用适配器

CLI、Web 和 Desktop 测试注入仅 Node 适配器。适配器接口不包含 Playwright、Electron、浏览器或浏览器侧 `client-runtime` import，因此每个应用测试都会在自身模块中保留所属 runner 的启动和呈现断言。CLI 适配器只会从 fixture 工作区通过普通的当前 Node 运行相匹配的构建版 `apps/cli/lib/bin.js` 或 `lib/dsh-bin.js`，使用不扩展父进程值的系统环境，并原样保留捕获的输出。

Web 适配器会动态 import 物理构建版 local-Runtime 公开入口，并在缺少 `apps/web/dist` 时拒绝运行。它以禁止启动另一运行时的模式连接、验证 `running`、拥有一个 Dashboard 附加项，并在 fixture 平台 home 内写入一个随机命名、独占创建且采用 POSIX 仅所有者 mode 的表单文件。Chromium 打开该文件的干净 URL，只在表单正文中提交一次 handoff，跟随准确且干净的 `/` 重定向，并等待认证就绪标记与真实 Engineering workbench 同时出现。适配器分别拥有页面、浏览器上下文、Dashboard 附加项、运行时客户端和 bootstrap 文件的可重试关闭；打开与清理同时失败时只保留稳定的阶段错误。其探针公开 Playwright 页面供语义 role／text 交互，并公开一份不含 token 的审计，覆盖请求 URL 与 header、referrer、最终 DOM 与 URL、Chromium history、浏览器 storage、console／page 错误和 HttpOnly cookie 策略；它绝不返回 handoff 或 cookie 值。

累积式 Web 验收先通过构建版 `harness run --json` 创建状态：已知 Workspace 保持不变，只按 cwd 创建的 CLI Session 出现在 Ungrouped 下。真实 Dashboard 会通过可访问 UI 关闭首次使用提示、展开并选择该 Session，渲染已有提示词／回复，通过输入框提交第二条提示词，再由 fixture 的公开历史 API 确认两个轮次。该语义 DOM 覆盖没有更改任何产品可见字符串，因此无需更新 snapshot。

Desktop 适配器会在缺少构建版 `apps/desktop/out/main/index.js` 时拒绝运行，并只以 fixture 根目录和系统可执行路径启动该真实 Electron 入口；它不传递提供方 key、Runtime token、端点路径或 `DSH_HOME`。Desktop 自己通过产品 connector 附加到已经健康的 Runtime。适配器只拥有 Playwright 返回的 Electron 子进程，先请求应用优雅关闭，再在有界时间内只对该子进程发送 `SIGKILL`，并在子进程意外退出后仍释放 Playwright 应用。累积式 Desktop 通道会等待认证就绪的 workbench、在 Ungrouped 下选择 CLI Session、通过原生 renderer 追加内容、证明公开历史在强制终止后仍存在，再次启动 Desktop 并渲染同一历史。Linux consumer CI 在 `xvfb-run` 下运行该构建版通道；它不引入产品可见字符串或 snapshot。

## 模型体验

无，因为 fixture 只驱动普通的公开提示词和终端操作，所有模型可见输入均由规范运行时的组合插件负责。

#### KV Cache 影响

无直接影响；每个隔离运行时和 mock 场景都有独立的请求历史，fixture 不会添加、保留或重写模型请求前缀。

## 已知限制与暂缓事项

- **仅供测试的载体**：fixture 支持用于验收测试的公开运行时 connector、终端、Dashboard handoff 和 API 载体；它不是应用集成 API。
- **应用启动器需要注入**：CLI、Web 和 Desktop 模块必须先提供各自 runner 的适配器，才能调用 `runCli()`、`openWeb()` 或 `openDesktop()`。
- **CLI 会话保留在 Ungrouped**：终端 CLI 只按 cwd 创建会话，不会仅因路径相同就把会话附加到工作区；该行为遵循[工作区成员关系决策](../../../.agents/notes/implemented/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md)。
- **不检查存储或凭据**：持久化、锁、端点与凭据断言仍由各自所属包负责；该 fixture 只观测公开健康状态和经过认证的 API 状态。
