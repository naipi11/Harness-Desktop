# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包提供单一本地 Harness Desktop Runtime 的宿主基础。它解析唯一可写的数据根目录，在挂载有状态服务前取得排他 owner 锁，并持久化 Runtime 的私有环回 endpoint。

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

owner 锁同时记录 PID 与操作系统进程启动身份。短期跨进程 recovery guard 串行化 acquisition、身份探测与过期替换，确保竞争方不能同时恢复同一记录。竞争方保留存活或无法核验的 owner；只有证明记录身份已经消失后，才恢复过期记录。释放操作只删除当前 Runtime 所取得且未变化的锁。

endpoint 记录包含协议版本、Runtime 身份、端口、进程身份和私有访问 token。内部写入方先保护同目录临时文件，再以原子重命名发布；内部读取方在读文件前验证 POSIX owner-only `0600` 权限或 Windows 当前用户专属 DACL。retirement 将当前 endpoint 原子重命名为私有 tombstone，并在该文件上复核 Runtime 身份；若 claim 到 replacement，则在不覆盖更新 endpoint 的前提下恢复它。包根入口只导出不含 token 的状态与 owner 类型，不导出 endpoint 解析器、写入方、文件名或含 token 的记录。

`createRuntimeConnector()` 是唯一由应用调用、负责发现私有 endpoint 并保留其 token 的入口。`connect({ start: false })` 会在不创建所选 home、lock、endpoint 或进程的前提下报告类型化 absence；`connect({ start: true })` 通过 owner lock 串行化相互竞争的进程启动，并把每个成功调用方附加到同一个 Runtime。公开成功值与 `normalizeRecoveryDiagnostic()` 不包含 endpoint 字段、token、credential 值、原始文件系统错误或 Harness home 绝对路径。

Runtime 本地路由只在精确的 `127.0.0.1` authority 上，以私有 endpoint bearer token 接受原生控制。原生调用方会签发一个 60 秒、单次使用的不透明 handoff；`POST /_harness/handoff` 只从一个 URL 编码表单正文消费该值，不发送 CORS permission，并在设置不带 expiry 的 `HttpOnly; SameSite=Strict; Path=/` session cookie 后执行干净重定向。内存认证器要求 Dashboard API 与 event carrier 同时具有该精确 Runtime Origin 和 cookie；启动器拥有的 cleanup controller 在 dispatch、exchange settlement 或 expiry 后只清理一次其 bootstrap document 与 owner directory。token、handoff 和 session 值不会进入公开导出、诊断、URL 或浏览器脚本存储。

Runtime owner 会在启动已发货的 base 与 Web 组合前取得锁，其中包括 API、静态 Dashboard、session、settings、workspace、storage 和 credential-reference provider。它要求该组合公开一个健康的 `127.0.0.1` WebServer 和操作系统分配的端口，在发布私有 endpoint 前挂载私有已认证控制，并向每个 writer 共享同一个注入的 `HarnessHomeProvider`。它计数实际客户端附加、agent work 与显式 background lease，并且只在三者均不存在时开始配置的空闲关闭。直接内部 dispose 也要求 retention 计数全部为零；仍有任何 retainer 时，它会拒绝且不开始关闭。关闭会等待每个持久化 flush 结算，再依次移除 endpoint、释放锁并 dispose Cordis 根；所有阶段结算后才报告彼此独立的失败。`startRuntime()` 及其 handle 仍是编排内部实现；应用使用 `RuntimeConnector` 与 `RuntimeClient`。

每个 `RuntimeClient`、`TerminalConnection` 与 `DashboardAttachment` 都独立拥有一个 attachment，并且通过 `close()` 只释放该 attachment。Runtime 对每个 session 最多准入一个写入型操作；其他客户端竞争时，它返回类型化的 `observe`、`new-session` 与 `wait` 恢复选项，同时保持读取并发；session 的持久 `turn/end` 会释放该准入。活动工作观察与安全停止只作用于发出请求的 UI owner。每个 home 的 Web background lease 使用稳定 id `web`；跨客户端重复获取和释放会被串行化且都是幂等的，释放 lease 不会取消工作或断开 attachment。

旧数据导入决定与结果存放在 `HARNESS_HOME` 下，并由原生控制请求和已认证 Dashboard 控制请求共享。接受决定只会把受支持的非秘密根目录复制一次到原本为空的目标；拒绝决定会持久化；重试只复用已记录的可重试结果；所有源目录始终保留。碰撞与失败结果只公开脱敏诊断和修正操作。

声明的 `lib/bin.js` 与直接运行的开发入口 `src/bin.ts` 都会启动完整的已发货组合。运行源码入口前必须先执行 `pnpm run build:lib`，因为 Typert contribution 与浏览器 bundle 是构建生成的产物；只使用源码的干净集成 fixture 必须显式声明仅后端 overlay，不得改变产品组合。

## 模型体验

### Runtime owner 与 endpoint 记录

#### 模型所见内容

无。`acquireRuntimeLock()` 与 endpoint-record 基础原语不添加提示词、消息、工具 schema 或工具结果。

#### Token 影响

无。Runtime 访问 token 保留在私有控制面文件中，绝不进入模型请求。

#### KV Cache 影响

无。该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **后台保留不是进程监督** — 命名 Web lease 会让健康 Runtime 保持运行，但不会在崩溃、退出登录或升级后重启该进程。
