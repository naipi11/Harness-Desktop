# Agent Note: 改名后迁移旧 profile bundle

Status: implemented

[English](2026-08-18-legacy-profile-bundle-migration.md) | 中文

## 问题

Harness Desktop 改名把所有已发布包从 `@deepseek-ai/*` 改为 `@harness-desktop/*`。改名前的 `dsh` 创建的 profile 仍引用 `@deepseek-ai/dsh-*` bundle，改名后的 CLI 无法解析，会报 `cannot resolve profile bundle ... run 'dsh plugin --profile <name> install'`，而不是自动升级 profile。

## 决策

`dsh-app-boot` 把旧元组视为安装自持元组，加载时归一化为当前出厂模板：改名前的 `web` 模板（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）和两种改名前的 `headless` 变体（含或不含 `@deepseek-ai/dsh-web-app`）都会改写为当前 `@harness-desktop/*` 模板。`INSTALLATION_OWNED_PROFILE_TUPLES` 现在把每个 profile 名映射到安装可能自持的一组精确元组；改名后安装自身的 headless 三元组仍保留在集合中，其他 bundle 列表保持用户自持语义，不做改动。

## 备选方案

**一次性设置命令。** 不予采用：每个现有安装都需要手动步骤，而且失败模式会在用户运行该命令前持续出现。

**改写任何包含 `@deepseek-ai/dsh-base` 的列表。** 不予采用：用户自定义列表必须保持用户自持；只有安装曾经出厂过的精确元组才会被归一化。

## 影响

现有 profile 在首次加载时原地迁移，无需手动步骤，并保留 manifest 中的其他所有字段。由于归一化要求元组完全匹配，故意保留旧名 bundle 列表的用户仍会得到明确的解析失败，而不是被静默改写。

## 测试

app-boot 的 profile 测试覆盖旧 `web` 元组、两种旧 `headless` 变体、改名后的 headless 三元组，以及保持不变的用户自定义列表。
