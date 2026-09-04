# Agent Note：桌面端非发布产物矩阵

Status: implemented

[English](2026-08-16-desktop-release-config.md) | 中文

## Problem

Electron Builder 只会自动发现 `electron-builder.yml`（或 `yaml`、`json`、`json5`、`toml`、`js`、`cjs`、`ts`），因此不显式传 `--config` 时，仓库内的 `electron-builder.config.mjs` 永远不会被加载。打包会静默回退到默认值：`files` 为空、输出到 `dist`，且没有发布保护。此外，fork 里旧的 release workflow 仍具备发布能力，可能从 pull-request 产物推送上游 scope 的包或创建 GitHub Release。

## Decision

`apps/desktop/electron-builder.config.mjs` 用 JSON import attribute 引入 product metadata，固定 appId、productName、executableName、`directories.output: release`、`files: ['out/**', 'package.json', 'resources/icons/**']`、`asar: true`、`publish: null`，以及 Windows NSIS、macOS universal DMG、Linux AppImage/DEB 目标矩阵。其 Windows、macOS 和 Linux `icon` 字段只选择 `apps/desktop/resources/icons` 下生成的 ICO、ICNS 和 512 px PNG。`desktopIconPath()` 为 BrowserWindow 解析相同的生成平台资源，Desktop renderer 则将 Web 所有的生成 favicon 复制到构建输出，而不引入第二个 favicon 源。Desktop 的 `package` 与 `package:dir` 脚本都先验证生成的图标，再带 `--config electron-builder.config.mjs --publish never`；新增的 `.github/workflows/desktop-artifacts.yml` 在 windows-2025、macos-15、ubuntu-24.04 上执行同一非发布命令，权限仅 `contents: read`，无 environment，也不接收签名或 npm 密钥。旧的 `.github/workflows/release.yml` 改为仅打包审计：删除 publish input、publish job 与 `NODE_AUTH_TOKEN`，保留无需凭据的 pack/install 校验 job。`scripts/desktop-release-config.ts` 静态断言显式 config 参数、生成的图标路径和图标载荷；`apps/desktop/tests/icon-assets.spec.ts` 覆盖 `prepackage` 和 `prepackage:dir`；`ciArtifactGates()` 执行 `verify:desktop-release-config`。

## Alternatives considered

**将配置改名 `electron-builder.ts` 以自动发现。** 不采用。plan 明确指定 `electron-builder.config.mjs`；显式 `--config` 自解释，静态 gate 也能证明打包脚本确实加载它。

**在 CI 中依赖自动发现的默认值。** 不采用。缺少显式参数时 `files: []` 与 `directories.output: dist` 会静默产生不可打包的矩阵；硬 gate 比打包回归更便宜。

## Consequences

打包总是加载仓库内矩阵，在 Builder 运行前验证生成的图标，并且永不发布；pull-request 产物不签名，只上传到 Actions artifacts。release verifier 会为缺失或被替换的平台图标报告字段和仓库相对的生成路径。旧 dsh workflow 仍可打包并校验安装，但无法发布。Windows 本地 `package:dir` 验证使用了一次性 `--config.electronDist` 覆盖，指向本机已缓存的 Electron zip；该机器本地绕行不属于提交的配置。
