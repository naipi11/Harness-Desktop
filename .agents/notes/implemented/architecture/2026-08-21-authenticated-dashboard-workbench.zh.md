# Agent Note: 已认证 Dashboard 工作台所有权

Status: implemented

[English](2026-08-21-authenticated-dashboard-workbench.md) | 中文

## 问题

Dashboard 需要在现有浏览器应用之上提供一个工程工作台，但不能创建 Desktop 专用数据路径。Focus 模式必须保留所选 Session 和连接，产出文件必须来自已注册的 deliverables 投影，停止操作只能取消同一已认证浏览器会话准入的工作。

本地 Runtime 动态挂载 client connection 的 Host 侧，因为该侧需要 Runtime 的 cookie 校验器。因此，它在配置中的 Loader 行保持禁用，但浏览器侧仍必须进入 `window.__DSH_BOOT__`。只在控制路由中使用 cookie hash 并不能建立工作所有权，因为普通 `session.prompt` 准入不会因此进入 Runtime 计数。

## 决策

app-shell 在构建 Dashboard 前 inject `workspaces`。`EngineeringWorkbench` 包裹普通 root slot，并拥有 focus 状态及 Files、Diff、Terminal、Artifacts 和 Tasks 五个面板。它读取浏览器图已经提供的 Workspace 与 Session 服务。deliverables 插件提供 root reader，在每个结束 Assistant 的 seq 处通过 `producedForClosing` 折叠已完成 Turn 的 `deliverables` 数据；工作台不会通过重新分类工具调用来推断产物。

client-module 声明支持 `includeWhenDisabled`，供 Host 侧由其他生命周期所有者管理的浏览器侧使用。Client connection 使用该声明：它在本地 Runtime 中的 Loader 行保持禁用，Runtime 挂载已认证 Host 路由，而浏览器 bundle 仍加入启动图。普通 Web 组合则直接启用 Host 行。

已认证 connection 会包装完成 schema 校验的 unary dispatch。对于 `session.prompt`，Runtime 从 HttpOnly cookie 派生单向 owner，在 ApiProxy 准入前保留 Session writer，并记录请求 `rpcId`。现有 inbox 事件会关联已发布的用户消息和已领取的 Turn。被拒绝的请求、只执行命令的结果、handler 失败，以及未发布关联消息的已接受请求都会释放该保留；关联过程只在有界事件间隔内等待。在关联前停止工作或关闭 Runtime 会中止 invocation，并保留关联 tombstone，直到 carrier 结算，或发生竞态的迟到消息从 inbox 中被移除。对应的精确 `turn/end` 会释放已接受工作。`observe-active-work` 与 `stop-own-ui-work` 使用同一个 cookie 派生 owner，因此其他 Dashboard cookie 无法观察或停止这些工作。

工作台会在 Terminal 和 Task prompt 操作后刷新活动工作。只要工作仍处于活动状态，它就会按固定间隔轮询已认证操作，最多尝试 30 次；工作结算或 focus 变化不会重新连接浏览器客户端。无秘密的 ready marker 仍由成功完成认证的 `AppWebEntry` settle 拥有，详见 [Desktop Runtime Dashboard 所有权](2026-08-21-desktop-runtime-dashboard-ownership.md)。

## 考虑过的替代方案

**从 Electron preload 或 local storage 读取文件、产物、todo 或终端状态。** 这会创建第二个权威来源，并把数据暴露到已认证客户端图之外。工作台使用与浏览器应用相同的投影和操作。

**只在控制请求到达时把 cookie hash 当作所有权。** 这允许 UI 声明状态，但不会把 owner 与 prompt 准入关联。包装完成校验的 `session.prompt` 调用可以在消息进入 Agent inbox 前建立所有权。

**永久轮询或只在挂载时查询一次。** 只在挂载时查询会在 prompt 后立即陈旧；无限轮询会在结算信号丢失后继续产生后台流量。操作触发刷新加有界活动间隔可以覆盖可观察操作，同时不建立永久订阅。

**在本地 Runtime 中启用 connection 的 Host Loader 行。** 它会在 Runtime cookie 校验器之前挂载未认证 `/api` 路由，并与动态所有者的路由冲突。`includeWhenDisabled` 只保留浏览器侧，同时确保已认证 Host 所有者唯一。

## 后果

浏览器 connection 与本地 Runtime 共享完成校验的 unary interceptor 约定，Dashboard prompt 准入在提交前会增加一次短暂的关联等待。使用两个 cookie 的真实源码 Runtime 进程证明了按 owner 隔离的 prompt 观察与停止。客户端测试证明了操作刷新、focus 保留和投影选择。

进程内 Web e2e scaffold 可以在已发货的构建版 `AppWebEntry` 与 Loader 图周围挂载真实 `LocalDashboardAuth` handoff、cookie 校验器、已认证 Connection 路由和 Dashboard 控制。其浏览器覆盖会植入一个真实 Session，并证明五个投影与操作、ready marker 时序、不重连的 focus、未认证恢复，以及由 AppWebEntry 拥有的插件失败报告。
