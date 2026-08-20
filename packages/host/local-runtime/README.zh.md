# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包提供单一本地 Harness Desktop Runtime 的宿主基础。它解析唯一可写的数据根目录，在挂载有状态服务前取得排他 owner 锁，并持久化 Runtime 的私有环回 endpoint。

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

owner 锁同时记录 PID 与操作系统进程启动身份。短期跨进程 recovery guard 串行化 acquisition、身份探测与过期替换，确保竞争方不能同时恢复同一记录。竞争方保留存活或无法核验的 owner；只有证明记录身份已经消失后，才恢复过期记录。释放操作只删除当前 Runtime 所取得且未变化的锁。

endpoint 记录包含协议版本、Runtime 身份、端口、进程身份和私有访问 token。内部写入方先保护同目录临时文件，再以原子重命名发布；内部读取方在读文件前验证 POSIX owner-only `0600` 权限或 Windows 当前用户专属 DACL。retirement 将当前 endpoint 原子重命名为私有 tombstone，并在该文件上复核 Runtime 身份；若 claim 到 replacement，则在不覆盖更新 endpoint 的前提下恢复它。包根入口只导出不含 token 的状态与 owner 类型，不导出 endpoint 解析器、写入方、文件名或含 token 的记录。

Runtime 本地路由只在精确的 `127.0.0.1` authority 上，以私有 endpoint bearer token 接受原生控制。原生调用方会签发一个 60 秒、单次使用的不透明 handoff；`POST /_harness/handoff` 只从一个 URL 编码表单正文消费该值，不发送 CORS permission，并在设置不带 expiry 的 `HttpOnly; SameSite=Strict; Path=/` session cookie 后执行干净重定向。内存认证器要求 Dashboard API 与 event carrier 同时具有该精确 Runtime Origin 和 cookie；启动器拥有的 cleanup controller 在 dispatch、exchange settlement 或 expiry 后只清理一次其 bootstrap document 与 owner directory。token、handoff 和 session 值不会进入公开导出、诊断、URL 或浏览器脚本存储。

## 模型体验

### Runtime owner 与 endpoint 记录

#### 模型所见内容

无。`acquireRuntimeLock()` 与 endpoint-record 基础原语不添加提示词、消息、工具 schema 或工具结果。

#### Token 影响

无。Runtime 访问 token 保留在私有控制面文件中，绝不进入模型请求。

#### KV Cache 影响

无。该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **Runtime 组合不属于这些基础原语** — 后续宿主组装负责具体 control service、客户端附加、lease 与空闲关闭。
