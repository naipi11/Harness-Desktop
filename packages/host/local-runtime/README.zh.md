# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包提供单一本地 Harness Desktop Runtime 的宿主基础。它解析唯一可写的数据根目录，在挂载有状态服务前取得排他 owner 锁，并持久化 Runtime 的私有环回 endpoint。

`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。`resolveHarnessHome()` 只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。

owner 锁同时记录 PID 与操作系统进程启动身份。竞争方保留存活或无法核验的 owner；只有证明记录身份已经消失后，才恢复过期记录。释放操作只删除当前 Runtime 所取得且未变化的锁。

endpoint 记录包含协议版本、Runtime 身份、端口、进程身份和私有访问 token。内部写入方先保护同目录临时文件，再以原子重命名发布；内部读取方在读文件前验证 POSIX owner-only `0600` 权限或 Windows 当前用户专属 DACL。包根入口只导出不含 token 的状态与 owner 类型，不导出 endpoint 解析器、写入方、文件名或含 token 的记录。

## 模型体验

### Runtime owner 与 endpoint 记录

#### 模型所见内容

无。`acquireRuntimeLock()` 与 endpoint-record 基础原语不添加提示词、消息、工具 schema 或工具结果。

#### Token 影响

无。Runtime 访问 token 保留在私有控制面文件中，绝不进入模型请求。

#### KV Cache 影响

无。该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **Runtime 组合不属于这些基础原语** — 后续宿主组装负责服务挂载、认证路由、客户端附加、lease 与空闲关闭。
