# Agent Note: 不携带机密值的旧数据导入边界

Status: implemented

[English](2026-08-19-legacy-import-boundary.md) | 中文

## 问题

旧 `$DSH_HOME` 可能持有会话、设置、项目元数据，以及一份装满机密的 `.credentials.yaml` 文档。单 home Runtime 必须采用受支持的非机密数据，同时绝不写入、删除或合并旧根目录，也绝不让旧机密悄悄成为 Runtime 的凭据来源。

迁移边界还需要用户决策。Runtime 存储状态并执行已接受的导入，但客户端绝不能替用户选择；冲突和失败必须能够通过可操作的类型化结果恢复。

## 决策

`@harness-desktop/dsh-host-local-runtime/legacy-import` 拥有该边界。`importLegacyDshHome()` 只把已知的非机密根目录（`sessions`、`settings.yaml`、`projects`）复制到空的 `HARNESS_HOME` 目标：先复制到暂存同级目录，再通过一次原子 rename 把每个根目录移入目标。源与目标都绝不删除。目标非空时返回 `{ kind: 'target-not-empty' }`；复制失败时删除暂存目录，返回 `{ kind: 'failed', retained, diagnosticId }`，并保留两个根目录以便从 `retained` 继续重试。

Runtime 在 `$HARNESS_HOME/legacy-migration.json` 中存储 `pending`/`declined`/`imported`/`failed`/`target-not-empty` 状态，并使用仅所有者模式。存储状态绝不包含旧来源路径或任何机密。`detectLegacyImport()` 在首次启动时暴露类型化的待决决策；`recordLegacyImportDecision()` 持久化拒绝、执行已接受的导入，并把类型化结果映射为可重试状态。`.credentials.yaml` 和 `.env` 绝不是复制候选。

Runtime 基础组合挂载 `@harness-desktop/dsh-credentials-platform`，不再挂载 `@harness-desktop/dsh-credentials-local`，因此旧 `.credentials.yaml` 绝不会被读入 Runtime。平台提供方只持久化不透明引用（`$HARNESS_HOME/.credential-references.json`），并在每次请求时从平台/环境适配器解析值；默认适配器是启动器冻结的只读进程环境。文件型包保持完整，公共行为不变，供有意选择它的嵌入方使用。

## 备选方案

**把 `.credentials.yaml` 复制进目标并继续读取。** 凭据文档正是该边界必须排除的机密材料；复制它会把机密移入 Runtime 拥有的文件，并可能被后续读取或记录。继续挂载本地提供方会使旧文档成为活动的 Runtime 凭据来源。

**把旧数据逐根目录直接写入目标。** 部分复制会让目标与完整复制无法区分，也没有恢复点。暂存加原子逐根移动使读者永远不会看到部分根目录，并为重试提供显式 `retained` 列表。

**在导入器内询问用户。** Runtime 存储决策并执行导入，但终端提示属于 CLI，Dashboard 和 Desktop 拥有各自的迁移 UI。把决策留在外部，可以为每个客户端保留同一边界。

## 影响

- 一次导入要么返回保留两个根目录的类型化失败，要么以 `copied` 列表完成；用户可以修复冲突并通过 Runtime 重试。
- 旧机密无法到达目标 home、Runtime 凭据 seam、日志、诊断或状态文件：`.credentials.yaml` 和 `.env` 不是候选，平台提供方也绝不把值写入其元数据文档。
- 基础组合的凭据行现在是平台提供方；`dsh-credentials-local` 仍随仓库发布并通过测试，但默认不再挂载。
- 导入状态由 Runtime 拥有：客户端读取类型化状态，从不解析迁移文本，也不自行执行复制。
