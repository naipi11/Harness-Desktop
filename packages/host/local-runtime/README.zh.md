# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包提供单一本地 Harness Desktop Runtime 的宿主基础。它解析唯一可写的数据根目录，在挂载有状态服务前取得排他 owner 锁，并持久化 Runtime 的私有环回 endpoint。

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

owner 锁同时记录 PID 与操作系统进程启动身份。短期跨进程 recovery guard 串行化 acquisition、身份探测与过期替换，确保竞争方不能同时恢复同一记录。竞争方保留存活或无法核验的 owner；只有证明记录身份已经消失后，才恢复过期记录。释放操作只删除当前 Runtime 所取得且未变化的锁。

endpoint 记录包含协议版本、Runtime 身份、端口、进程身份和私有访问 token。内部写入方先保护同目录临时文件，再以原子重命名发布；内部读取方在读文件前验证 POSIX owner-only `0600` 权限或 Windows 当前用户专属 DACL。retirement 将当前 endpoint 原子重命名为私有 tombstone，并在该文件上复核 Runtime 身份；若 claim 到 replacement，则在不覆盖更新 endpoint 的前提下恢复它。包根入口只导出不含 token 的状态与 owner 类型，不导出 endpoint 解析器、写入方、文件名或含 token 的记录。

`createRuntimeConnector()` 是唯一由应用调用、负责发现私有 endpoint 并保留其 token 的入口。`connect({ start: false })` 会在不创建所选 home、lock、endpoint 或进程的前提下报告类型化 absence；`connect({ start: true })` 通过 owner lock 串行化相互竞争的进程启动，等待经过认证的健康 replacement，再把每个成功调用方附加到同一个 Runtime。每个 wire 成功值与错误都会在投影前经过精确字段和 branded value 校验；形态错误的值会以 `RuntimeProtocolError` 被拒绝，公开 status、migration、lease、busy、active-work 与 diagnostic 值不包含 endpoint 字段、token、credential 值、原始文件系统错误或 Harness home 绝对路径。

Runtime 本地路由只在精确的 `127.0.0.1` authority 上，以私有 endpoint bearer token 接受原生控制。原生调用方会签发一个 60 秒、单次使用的不透明 handoff；`POST /_harness/handoff` 只从一个 URL 编码表单正文消费该值，不发送 CORS permission，并在设置不带 expiry 的 `HttpOnly; SameSite=Strict; Path=/` session cookie 后执行干净重定向。内存认证器要求 Dashboard API 与 event carrier 同时具有该精确 Runtime Origin 和 cookie；启动器拥有的 cleanup controller 在 dispatch、exchange settlement 或 expiry 后只清理一次其 bootstrap document 与 owner directory。token、handoff 和 session 值不会进入公开导出、诊断、URL 或浏览器脚本存储。

Runtime owner 会在启动已发货的 base 与 Web 组合前取得锁，其中包括 API、静态 Dashboard、session、settings、workspace、storage 和 credential-reference provider。它要求该组合公开一个健康的 `127.0.0.1` WebServer 和操作系统分配的端口，在发布私有 endpoint 前挂载私有已认证控制，并向每个 writer 共享同一个注入的 `HarnessHomeProvider`。它计数实际客户端附加、agent work 与显式 background lease，并且只在三者均不存在时开始配置的空闲关闭。直接内部 dispose 也要求 retention 计数全部为零；仍有任何 retainer 时，它会拒绝且不开始关闭。关闭会等待每个持久化 flush 结算，再依次移除 endpoint、释放锁并 dispose Cordis 根；所有阶段结算后才报告彼此独立的失败。`startRuntime()` 及其 handle 仍是编排内部实现；应用使用 `RuntimeConnector` 与 `RuntimeClient`。

每个 `RuntimeClient`、`TerminalConnection` 与 `DashboardAttachment` 都拥有一个服务端映射的 attachment；经过认证的 parent 无法释放、提交到、取消或控制另一个 parent 的 child id。`close()` 只有在幂等服务端 release 成功后才提交 closed 状态，因此瞬时传输失败可以重试同一次 release，成功后则不会重复发出。关闭 attachment 不会取消活动工作；`cancel()` 与 owner-scoped safe stop 会取消精确 Agent 操作，并在释放其 work lease 前等待整个 Agent 进入 idle。

`openTerminal()` 通过已组装的 API owner 创建或恢复，`submit()` 则进入真实 Agent turn。Runtime 将请求的 `rpcId` 与精确 inbox claim、turn 编号、Agent 实例和 `turn/end` 关联，再等待 `agent.whenIdle()` 后才准入 replacement；陈旧 turn 或 cancel completion 无法清除后来的 lease。Terminal event 来自实时 session 和 approval 机制：流式 assistant 文本、tool activity、model／permission 变化及 approval question。只有拥有活动 Agent 操作的 terminal 才能提交 approval response。Model selection、permission preset 和已注册 Host command 通过既有 owner 执行；不支持的 control 会拒绝，而不是返回合成成功。

每个 home 的 Web background lease 使用稳定 id `web`；跨客户端重复获取和释放会被串行化且都是幂等的，释放 lease 不会取消工作或断开 attachment。

旧数据导入决定与结果存放在 `HARNESS_HOME` 下，并由原生控制请求和已认证 Dashboard 控制请求通过一个 Runtime-owned transaction queue 共享。接受决定只会把受支持的非秘密根目录复制一次到原本为空的目标；并发 accept 会回放已提交的成功，后来的 decline 无法覆盖它。接受前的 decline 会持久化，retry 只从精确的可重试 collision／failure 状态运行，所有源目录始终保留。持久记录会在公开投影前拒绝未知、缺失、多余、带路径或 branded value 无效的字段；碰撞与失败结果只公开脱敏诊断和修正操作。

声明的 `lib/bin.js` 与直接运行的开发入口 `src/bin.ts` 都会启动完整的已发货组合。运行源码入口前必须先执行 `pnpm run build:lib`，因为 Typert contribution 与浏览器 bundle 是构建生成的产物；只使用源码的干净集成 fixture 必须显式声明仅后端 overlay，不得改变产品组合。

## 模型体验

### Runtime owner 与 endpoint 记录

#### 模型所见内容

无。`acquireRuntimeLock()` 与 endpoint-record 基础原语不添加提示词、消息、工具 schema 或工具结果。

#### Token 影响

无。Runtime 访问 token 保留在私有控制面文件中，绝不进入模型请求。

#### KV Cache 影响

无。这些 Runtime ownership 与 endpoint-record 原语既不组装也不发送提供方请求。

### Terminal Agent 操作

#### 模型所见内容

Terminal task 通过既有 session API 准入，成为与 Dashboard 相同的持久 user message 和 Agent turn。Runtime 不会向模型可见内容添加 wrapper prompt 或传输元数据。改变 model 或 permission 状态的 control 使用既有 owner；已注册 slash command 保留其自身的日志行为。

#### Token 影响

提交的 task 与产生的会话消耗正常的模型输入／输出 token。Runtime control、attachment ownership、status、lease、migration、busy result 和 diagnostic 不添加模型 token。

#### KV Cache 影响

Task 追加在 session 的可复用前缀之后。Runtime control 元数据不会改变请求前缀；普通模型可见 task 或 command effect 与既有 Agent／session 路径具有相同缓存行为。

## 已知限制与暂缓事项

- **后台保留不是进程监督** — 命名 Web lease 会让健康 Runtime 保持运行，但不会在崩溃、退出登录或升级后重启该进程。
