# Agent Note：CLI 以 @harness-desktop/cli 发布

Status: implemented

[English](2026-08-17-harness-desktop-cli-npm-package.md) | 中文

## Problem

可安装的 CLI 仍以 `@deepseek-ai/dsh` 发布，因此用户需要运行 `npx --package @deepseek-ai/dsh harness web` 或 `dsh web`。在产品成为独立项目后，主命令 `harness` 没有一级 npm 包，[公共身份迁移记录](2026-08-15-public-identity-migration.md)中的过渡身份也无法适应产品拆分。

## Decision

CLI 包名为 `@harness-desktop/cli`，公开发布并可通过 `npm install -g @harness-desktop/cli` 全局安装；`harness` 与 `dsh` 两个 bin 名称继续可用，profile 与数据布局不变。`apps/cli/package.json` 持有名称与 bin；发布工具（`scripts/release/families.ts`、`scripts/check-workspace-constraints.ts`、`scripts/publish-npm-baseline.ts`、`scripts/verify-dsh-package-licenses.ts`）允许 CLI 入口包使用 `@harness-desktop/` scope，而内部 `@deepseek-ai/dsh-*` 库标识符保持不变。根 README 与 CLI README 从新包安装，并将 `harness` 文档化为主命令。此决定取代公共身份迁移记录中当时拒绝新 npm scope 的备选方案。

## Alternatives considered

**继续以 `@deepseek-ai/dsh` 作为过渡包发布。** 不采用。这与产品拆分相矛盾，并迫使用户保留上游名称和 `npx` 间接调用；数据与 profile 布局兼容性改由保留的 `dsh` bin 别名保证。

**将所有 `@deepseek-ai/dsh-*` 库包重命名为 `@harness-desktop/*`。** 不采用。CLI 入口包是唯一面向用户的安装产物；重命名整个工作区会给每个 import、锁文件和 vendored 引用带来改动，却没有用户可见收益。

## Consequences

新用户安装 `@harness-desktop/cli` 并运行 `harness`（或 `dsh`）；现有 `$DSH_HOME` profile 与 `dsh` 调用继续可用。npm 发布族必须将 CLI 与其依赖的 `@deepseek-ai/dsh-*` 包一起发布，因此发布是整族发布而非单个包。发布 `@harness-desktop/cli` 需要 `@harness-desktop` npm scope 存在，且 registry token 对该 scope 有权限。