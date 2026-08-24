# Agent Note: Desktop 暂存更新事务

Status: implemented

[English](2026-08-24-desktop-staged-update-transaction.md) | 中文

## Problem

签名更新候选在其下载字节、解压成员及切换后的已认证 Dashboard 启动均证明匹配所选发布之前仍不安全。失败的候选不得替换可工作的 Desktop 安装，也不得删除由 Runtime 管理的 `HARNESS_HOME` 数据。

## Decision

`DesktopUpdateService` 通过 `@harness-desktop/dsh-update-policy` 校验 manifest，然后只把脱敏制品声明传给由 Main 管理的 `StageAdapter`。该适配器在私有暂存根目录中下载、检查、暂存、启动、恢复和清理。候选字节和实际成员必须在暂存前匹配签名声明；候选只有在已认证 Dashboard 启动后返回既有且精确的 `desktop-dashboard-ready` 确认时才会被接受。

`applyStagedUpdate()` 只启动候选一次。缺失、格式错误或失败的就绪确认会先恢复保留安装，再通过 Runtime 客户端记录 `rolled-back`。Desktop 本地结果使用 `candidate-staged`、`desktop-health-check-failed` 等固定脱敏代码；Runtime 持久化将其映射到已有结果代码联合。该事务不会写入第二个更新设置存储，也不会修改 `HARNESS_HOME`。

Desktop Main 使用 `EMPTY_UPDATE_TRUST` 和未配置的适配器构造服务。在另行提供经过审计的生产信任根和源之前，该路径会在加载 manifest、下载、检查归档、启动进程或文件系统变更之前返回。

## Alternatives considered

- **在签名校验后立即应用** — 拒绝，因为已签名归档的字节、成员或启动行为仍可能不同于被接受的候选。
- **把任何子进程成功都视为就绪** — 拒绝，因为只有已认证 Dashboard 确认才能证明面向用户的 Desktop 路径已启动。
- **在第二个存储中持久化 Desktop 本地事务细节** — 拒绝，因为通道选择和持久化脱敏结果已经属于 Runtime 设置所有者。

## Consequences

- 平台专用安装器实现 `StageAdapter` 时不通过 `DesktopUpdateResult` 暴露其路径、URL 或原始错误。
- 隔离事务测试在运行时生成 manifest、信任根、归档和临时安装根目录，并以子进程覆盖候选确认情形。
- 聚焦测试覆盖空信任根短路、字节和成员检查、一次成功确认、失败确认回滚、Runtime 结果映射及 `HARNESS_HOME` 保留。
