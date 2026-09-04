# @harness-desktop/dsh-client-web

[English](README.md) | 中文

Web 外壳内核：`new AppWebEntry(el, seams?).run()` 通过两阶段启动（web2）挂载整个客户端。第一阶段（模块侧）：构建客户端模块系统（`@harness-desktop/dsh-client-modules`），以主机推送的配置项图（`window.__DSH_BOOT__`）为基础，并行预取 `immediately` 层级；执行组合包只会注册 factory。第二阶段（插件侧）：挂载仓库内置的 Cordis Loader，并通过其 `internal` 约定注入模块系统；为每一行图数据创建一个 loader 配置项，另创建外壳自身的 app-shell 组装配置项（tree.import 会物化各模块）；以 settle 作为 AppRoot 的门禁（loader 完全停稳 + 每个配置项 fiber 都为 ACTIVE → 一次切换显示完整 UI）。`run()` 仅在该 settle 完成后 resolve `true`；插件启动失败时会渲染由外壳拥有的失败报告并 resolve `false`，缺失或格式错误的 manifest 则会 reject。组合完全由主机图决定：花名册和 immediately 层级都位于负责组合的应用中；外壳不作任何组合决策。

外壳自给自足（web2 硬性规则）：内核不对任何插件包执行值导入；启动状态 store 与信号在这里手写（`loader-status.ts`），因此即使插件失败，加载页面仍能工作，而此时这一点尤其重要。app-shell 组装（`@harness-desktop/dsh-client-app-shell`，由外壳拥有、背后没有 npm 包的伪配置项）是唯一通过 `registerStatic` 注册的模块；它与任何插件一样，通过 inject 等待 slots、sessions、workspaces 和 layout。

`PLATFORM_MODULES`（src/platform.ts）是共享模块接口的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。

外壳拥有浏览器标题投影。选中带有持久标题的会话时，它会渲染 `<session title> — <existing HTML title>` 并响应后续标题修订；未选择会话或选中无标题会话时，会保留现有标题；外壳卸载时恢复标题。现有 HTML 标题仍是可配置的产品后缀。

完成 settle 的 Dashboard 会在普通 root slot 外挂载工程工作台。工作台包含 Files、Diff、Terminal、Artifacts 和 Tasks 五个稳定面板。Files 及其文件操作使用已认证的 Workspace 服务；Diff 和 Terminal 读取所选 Session 的 snapshot；Artifacts 在每个结束 Assistant 边界读取 deliverables 插件发布的已完成 Turn 投影；Tasks 读取 `todos` Session 投影。Focus 模式只移除外围 root-slot 界面，并保留所选 Session 和连接。

Runtime 活动工作控制与 Dashboard API 使用同一个 HttpOnly cookie 认证。已认证 unary carrier 会在 `session.prompt` 前保留所有权，通过 `rpcId` 关联已发布的用户消息，并立即释放被拒绝及只执行命令的准入。已接受的 Turn 在对应的精确 `turn/end` 前始终按所有者划分作用域；工作台会在 prompt 操作后刷新，并且最多轮询活动所有权 30 秒。工作台及其 ready marker 均不读取或暴露 cookie、handoff、端点 token、Runtime home 或 Electron bridge。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用一次性渲染**：UI 等待启动 settle；只要一个配置项失败，加载页面就会保留并逐项显示醒目的报告，不提供部分可用性（渐进式渲染将作为独立项目恢复）。
- **窄窗口外壳行为缺少组装后演练**：ui-layout 已实现让步链，但该包没有外壳级窄视口验收用例。
- **进程内 Web e2e scaffold 没有原生 Runtime 客户端**：它使用严格同源的 Dashboard-control shim 启动真实构建产物中的 `AppWebEntry`/Loader 图。`dashboard-ready.e2e.ts` 单独证明生产 handoff 与 HttpOnly cookie 顺序，真实 Runtime 进程套件则证明 cookie 所有者的 prompt 准入与停止操作。
