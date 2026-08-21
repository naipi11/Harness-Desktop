# Agent Note: Desktop Runtime Dashboard 所有权

Status: implemented

[English](2026-08-21-desktop-runtime-dashboard-ownership.md) | 中文

## 问题

Desktop 窗口需要共享本地 Runtime 的已认证视图，但不能接收原生端点 token、浏览器 handoff、session cookie、Runtime 数据根目录或 attachment 对象。窗口销毁、显式恢复、应用关闭和异步 Web 启动可能彼此竞态；同时，关闭 Desktop 不得停止共享 Runtime 工作，也不得释放其他客户端的 lease。

进程就绪信号可用于源码、构建和打包冒烟测试，但仅有窗口加载事件并不能证明干净的 Dashboard origin 已完成 cookie 认证的应用启动。

## 决策

Electron Main 拥有 Runtime 客户端、每个 Dashboard attachment 和浏览器 handoff transport。`RuntimeDashboardController` 共享并发启动，在显式重试或窗口关闭前保留失败的 attachment，将关闭的窗口视为终态，并关闭在窗口关闭竞态中发布的 attachment，而不对其执行导航。窗口关闭只释放该 attachment；应用关闭会先关闭所有 Desktop attachment，再关闭其 Runtime 客户端。这些操作绝不停止 Runtime 工作、取消轮次或释放具名 Web lease。

每次启动都会铸造新的 Foundation `DashboardNavigation`。仅 Main 使用的 transport 会验证精确的 `http://127.0.0.1:<port>` origin 和未过期的不透明 handoff，只把 handoff 写入当前用户专属本地文档的一个隐藏字段，并且只加载不含秘密的文件路径。顶层表单 POST 从不透明 file origin 携带 handoff。Runtime 仅消费一次 handoff，返回带有 HttpOnly、`SameSite=Strict` session cookie 且无 CORS 授权的干净 303，并且不会把请求正文反射到诊断中。

transport 在 dispatch 失败、exchange 成功或失败、以及 handoff 到期后，通过同一个幂等清理操作删除文档及其目录。复用同一 transport 对相同 handoff 进行第二次 dispatch 会被拒绝。

干净的 Dashboard 会先执行 cookie 认证的控制 preflight，再执行 `AppWebEntry.run()`。只有每个插件均激活且应用 UI 完成 settle 后，Web 启动才 resolve `true`；已经渲染启动失败报告时则 resolve `false`。只有 `true` 结果才会在 Web root 设置 `data-harness-dashboard-ready="true"`。Main 会在每次导航中验证精确的干净 URL 并等待该 marker；只有常量 `{"kind":"desktop-dashboard-ready","version":1}` JSONL 输出在每个 Desktop 进程中最多发出一次。在 marker probe 等待期间抢先结算的 abort 或导航失败不能发出 acknowledgement。

[已认证 Dashboard 工作台](2026-08-21-authenticated-dashboard-workbench.md)会在此 ready 点之后拥有浏览器投影和按 cookie 划分作用域的 prompt 工作；它不会把 connection 或 attachment 生命周期移入 Renderer。

Main 会拒绝 Renderer 创建的每个子窗口，并且只允许顶层导航到本地恢复文档或当前 attachment 的精确 loopback origin。它会把 Dashboard 响应 CSP 绑定到所属的 `webContents`：`connect-src` 只包含 `'self'` 和该 origin 的精确 WebSocket 端口。主 frame 加载失败、Renderer 丢失或已认证 Dashboard 控制请求被拒绝时，该窗口只会进入一个合并的恢复 flight。重试会先刷新客户端报告的 origin，再铸造另一个 handoff；如果 Runtime 所有者不可达或发生变化，Main 会先取消其接纳资格并关闭它，再重新连接替代所有者。每个窗口的退役 fence 会在关闭等待或被拒绝时阻止替代所有者；后续重试会先重新关闭同一所有者。关闭失败的所有者会继续留在进程关闭跟踪中，使重试失败，并阻止接纳替代所有者；被拒绝的 attachment 与客户端释放只会清除各自失败的 flight，使进程关闭能够真正重试。不属于任何窗口或归属不明确的响应会保留原始 header，并且不能改变其他窗口的恢复状态。

每个 attachment、transport、导航、marker 和加载失败都会先经过 `normalizeRecoveryDiagnostic`，Main 才会将其保留给恢复 UI。结果不包含 URL、端口、进程标识、Runtime home、token、handoff、cookie 或 attachment 值。

## 考虑过的替代方案

**把 handoff 放入 URL、fragment、header 或 preload API。** 这些载体会进入浏览器 history、导航捕获、referrer、日志、Renderer 可见状态或更宽泛的 IPC。当前用户专属的表单正文只在消费 handoff 的一次 exchange 中携带它。

**让 Renderer 或 preload 执行 attachment 和重试。** 这会跨越 renderer 边界暴露有权限的 Runtime 对象，并允许窗口销毁后发生隐式重试。Main 保留生命周期所有权，Renderer 只请求显式恢复操作。

**把 `did-finish-load` 或第一次进程 acknowledgement 当作永久就绪。** Dashboard marker 在异步认证启动后才出现，并且每次替换导航都需要独立验证 URL 和 marker。一次性的输出记录不会削弱逐导航验证。

## 后果

Desktop 启动依赖私有临时文件和一次额外的浏览器 exchange，并且 Main 必须保留清理、到期、导航、响应所有权、恢复和窗口关闭状态，直至这些操作结算。真实 Chromium 与 Electron 覆盖固定了不透明 origin POST、303 与 cookie 顺序、干净 URL、无 CORS 授权、精确 WebSocket CSP、拒绝外部导航，以及 URL、referrer、storage、header、console 或 DOM 均不泄露秘密。Electron journey 还固定了 Runtime 初始启动失败、用户重试失败并替换诊断、后续重试成功、分段流式工具输出，以及通过 Dashboard 解决真实等待中审批。单元覆盖固定了并发启动、显式重试、窗口关闭竞态、逐导航 marker 检查、等待中 probe 的 abort，以及先关闭 attachment 再关闭客户端的顺序。

Web root marker 是无秘密的同步属性，不是 renderer 控制 API。stdout acknowledgement 同样只供进程观察，且不携带 Runtime 控制数据。
