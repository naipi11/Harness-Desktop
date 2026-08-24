# Agent Note: 共享签名更新策略所有权

Status: implemented

[English](2026-08-24-shared-signed-update-policy.md) | 中文

## Problem

Desktop Main 曾独自负责签名更新 manifest（元数据清单）解析，而 Runtime 偏好和独立客户端需要相同的发布通道及校验规则。分散的解析器可能接受不同的目标、源或归档路径；任何消费方若返回不可信 manifest，也可能暴露实现敏感值。

## Decision

`@harness-desktop/dsh-update-policy` 负责字段完全一致的记录解析、规范化序列化、Ed25519 校验、语义版本比较、按消费方筛选的目标选择、源检查、摘要检查、归档成员检查及脱敏结果。每个产物和请求都声明 `desktop` 或 `cli`；在处理歧义前筛选消费方，防止 Desktop 安装包与 CLI ZIP 或 tar.gz 归档相互选择。重复目标只会在被请求的消费方内产生影响。`EMPTY_UPDATE_TRUST` 不含源或公钥，因此会拒绝所有候选。该包不下载、不解压、不安装、不重启，也不配置可信根。

Runtime 设置、客户端控制请求及其公共 `DesktopUpdateChannel` 兼容名称使用共享的 `UpdateChannel` 类型，同时保留 `stable`、`beta` 和 `nightly` 协议值。Desktop Main 只保留兼容导出。测试从新的标识符在运行时生成每个签名候选和源，因此 Git 不包含原始签名 manifest 或发布位置 fixture（测试前置数据）。

## Alternatives considered

- **在每个消费方中保留解析器** — 这会使本地发布行为方便，但重复的签名和归档规则可能发生偏离。
- **在策略包中放置信任配置** — 这会把配置与校验集中，但会让纯校验器成为部署相关授权的来源。

## Consequences

- 消费方提供各自经过审计的应用标识、已安装版本、所选通道、目标、源和公钥。
- 后续下载器或安装器只消费已接受制品的脱敏结果，并保留各自的 I/O 和回滚职责。
- 校验器包测试使用真实临时 Ed25519 密钥对和生成的候选，以固定拒绝行为而不提交源数据。
