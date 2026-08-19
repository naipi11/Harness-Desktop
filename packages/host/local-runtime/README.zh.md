# @harness-desktop/dsh-host-local-runtime

[English](README.md) | 中文

该包解析唯一可写的 Harness Desktop 数据根目录。`HARNESS_HOME` 在展开波浪号后作为绝对路径覆盖值。未设置时，Windows 使用 `%LOCALAPPDATA%\Harness Desktop`，macOS 使用 `~/Library/Application Support/Harness Desktop`，Linux 使用 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。

`resolveHarnessHome()` 返回根目录，并且只将 `DSH_HOME` 报告为旧数据导入来源，绝不以它选择可写目标。`createLocalRuntimePlugin()` 只解析一次，并为耐久写入方提供该根目录下的子路径。

## 模型体验

无。该包解析宿主文件系统路径，不参与模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **该解析器不执行旧数据迁移** — 它为专用导入工作流报告检测到的 `DSH_HOME` 来源；复制和冲突处理由该工作流负责。
