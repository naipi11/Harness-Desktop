# Agent Note: Desktop packaged Runtime dependency closure

Status: implemented

[English](2026-08-23-desktop-packaged-runtime-dependency-closure.md) | 中文

## 问题

Electron Builder 会复制从 Desktop 包生产依赖图可达的外部 Main 导入。源码和普通构建测试从仓库上层 `node_modules` 获得工作区 peer 依赖，但这些 peer 不会进入 `app.asar`，除非打包应用显式声明它们。因此，Runtime 托管的 Dashboard 需要在 Desktop 包边界拥有明确的生产依赖闭包。

## 决策

`apps/desktop/package.json` 声明由组装后的 App-Boot、local Runtime、base 和 Web 生产图导入的工作区模块，包括由 peer 提供的 Runtime 辅助模块。`pnpm-lock.yaml` 记录相同的闭包。Electron Builder 继续只用 `--publish never` 打包 `out/**`、Desktop manifest 和产品图标；它不会复制第二个 Runtime、持久化 provider、credential store 或 Dashboard 资源所有者。

Desktop 包设置 `npmRebuild: false`，因为已安装的 target-native payload 就是该工作区选择的原生依赖，而 Electron Builder 的重建会修改共享 pnpm store。解包 Windows 产物携带 target-native payload，并通过真实 Electron Dashboard journey 验证，而不是仅凭 Electron 进程存在就接受。

## 考虑过的替代方案

**把 Runtime 打包进 Main。** 这会掩盖包边界缺失，同时复制动态 Cordis 包加载，并偏离共享 Runtime 所有权模型。

**复制仓库的完整 `node_modules` 树。** 这会携带开发依赖和工作区残留，削弱包 manifest 作为生产依赖权威的作用，并扩大发布面。

**继续隐式依赖 peer。** 这只在仓库检出环境中成立，因为上层模块树提供了 peer；已安装的 `app.asar` 没有该上层目录，因此会在 Runtime 启动前失败。

## 后果

Desktop manifest 和 lockfile 共同构成 Runtime 打包契约：新挂载的生产插件如果通过 peer 提供导入，就必须在 Desktop 应用边界声明对应 peer。干净源码、构建和解包检查共同覆盖该契约；解包 smoke 会到达已认证 Dashboard，验证固定的就绪 acknowledgement、精确 WebSocket CSP、原生 bridge、handoff exchange 以及有序关闭。
