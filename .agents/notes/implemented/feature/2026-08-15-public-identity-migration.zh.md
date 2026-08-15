# Agent Note：Harness Desktop 公共身份

Status: implemented

[English](2026-08-15-public-identity-migration.md) | 中文

## Problem

项目成为独立产品后，仓库及其对外表面仍标识为 DeepSeek Harness。模型可见身份、安装文案、Web 标题与 manifest、网站 lockup 和 badge 输出各自携带旧名称与旧仓库 URL，且分散在多个持有方来源中，容易漂移，需要一个共享校验器。

## Decision

仓库为 `naipi11/Harness-Desktop` fork，产品名为 Harness Desktop，主命令为 `harness`。过渡期包仍以 `@deepseek-ai/dsh` 发布；`dsh` 保留为兼容命令名，并使用相同的数据与 profile 布局。`scripts/product-identity.ts` 收集精确的持有方/值配对（根 README、CLI manifest、Web HTML 与 manifest、网站配置、agent preset），`verify:product-identity` 在漂移时失败。安装、参考、Web、网站、badge、attribution 和快照来源均渲染 Harness Desktop 与重命名后的仓库 URL；`$DSH_HOME`、`dsh.profile`、内部 `@deepseek-ai/dsh-*` 包标识符和存储名称保持不变。

## Alternatives considered

**新 npm scope 并完整重命名包。** 不采用。本工作流不发布 `@harness-desktop/cli`；保留 `@deepseek-ai/dsh` 作为过渡期包，在产品名变更的同时保留现有安装与数据布局。

**最终 logo 资产。** 不采用。网站将 DeepSeek wordmark lockup 替换为文字版 Harness Desktop lockup；虚构 logo 属于本迁移之外的设计决策。

## Consequences

公共与模型可见表面使用 Harness Desktop、`harness` 和 `naipi11/Harness-Desktop`；校验器固定这些值，后续变更需要有意更新持有方来源。兼容文案记录 `npx --package @deepseek-ai/dsh harness web` 与保留的 `dsh` 别名。badge、web-daemon、Web UI 和翻译提示的无密钥快照仅在对外产品名或主命令渲染处刷新。