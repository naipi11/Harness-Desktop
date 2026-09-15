# Agent Note: 在原生 CLI 构件中保留组合包 patch 资源

Status: implemented

[English](2026-09-15-cli-sea-bundle-patch-assets.md) | 中文

## 问题

原生 CLI 构建会暂存生产依赖闭包，并要求 `@yao-pkg/pkg` 嵌入声明的资源。`dsh-app-boot` 会解析每个 profile bundle 的 `dsh.bundle.patch` 路径，并在启动时读取该 YAML 文件。暂存资源列表包含代码、清单、JSON、原生扩展、wasm 和 CLI 配置树，却遗漏了随附的 `cordis.patch.yml`，导致 SEA smoke test 在 profile 启动前失败。

## 决策

CLI 资源列表明确加入 `node_modules/**/cordis.patch.yml`。这是 profile bundle 所有的运行时 YAML 约定：三个随附 bundle 都发布该固定文件名，并在 `dsh.bundle.patch` 中声明它。其他依赖的 YAML 文件仍然排除，而现有的 `config/**/*` 规则继续承载 CLI 随附配置树。

## 考虑过的替代方案

**包含所有依赖 YAML 文件。** `node_modules/**/*.yml` 和 `node_modules/**/*.yaml` 可以掩盖缺失资源，但也会嵌入运行时从不读取的依赖文档、fixture 和其他文件。

**修改 app-boot 以行内处理或复制 patch 内容。** 这会改变 bundle loader 的声明文件语义，也无法为外部安装的 bundle 保留运行时资源。生产资源闭包由构建器负责，因此修复应位于构件构建点。

## 后果

原生 Linux 和 Windows CLI 构件现在包含 `loadOverlayPatches` 所需的 patch 层，包括 `@stackstackstack/dsh-base/cordis.patch.yml`。聚焦回归测试同时覆盖该资源规则并拒绝宽泛的依赖 YAML glob。构件矩阵仍为 Linux x64、Linux arm64 和 Windows x64。

## 验证

发布前必须通过聚焦资源测试、YAML／静态检查、仓库 typecheck、lint 和可用的原生 Windows 构件 smoke path。本变更不包含 commit、tag、push 或发布操作。
