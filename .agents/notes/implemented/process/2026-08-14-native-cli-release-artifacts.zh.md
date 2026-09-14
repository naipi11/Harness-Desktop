# Agent Note: Native CLI release artifacts

Status: implemented

English | [中文](2026-08-14-native-cli-release-artifacts.md)

## Problem

dsh 命令行运行时需要在本地子进程提供方支持的平台上提供可下载的原生产物。仅有 Linux 压缩包无法为 macOS 或 Windows 提供可用分发，而安装包格式会引入当前尚未实现的产品与签名约定。

## Decision

`scripts/build-cli-exe.ts` 每次调用构建一个原生 `@yao-pkg/pkg@6.21.0 --sea` 目标。支持的目标是 `node24-linux-x64`、`node24-linux-arm64`、`node24-macos-x64`、`node24-macos-arm64` 和 `node24-win-x64`。Linux 与 macOS 生成 tar 包，Windows 生成 zip 包。每个压缩包都有 SHA-256 校验文件，并在写入压缩包前运行可执行文件的 help、version 和默认配置冒烟检查。

构建器从原生安装中暂存目标平台的 `node-pty` 插件。macOS 还需要匹配架构的 `spawn-helper`；缺少该资产时构建器会失败。原生矩阵 runner 在 `.github/workflows/build-cli-artifacts.yml` 中构建每个目标。现有 dsh 发布工作流只会在 `dsh-v*` 标签发布时调用该矩阵，并将已检查的压缩包和校验文件上传到对应 GitHub Release。npm 打包和发布流程保持独立，继续发布其精确打包字节。

这些产物仅是 CLI，不暗示支持 DMG、MSI、AppImage、Electron 或 Python wheel。

## Alternatives considered

**在单个 runner 上交叉编译所有目标。** 不采用，因为 `node-pty` 原生资产必须来自匹配的原生安装，pkg 目标二进制也按平台区分。

**增加安装包。** 不采用，因为当前没有 DMG、MSI 或 AppImage 的打包、签名、更新和安装约定。

**由构建矩阵直接上传产物。** 不采用，因为 Release 资产需要一个发布范围的 job 再次检查所有校验和，并上传完全相同的已验证文件。

## Consequences

原生 runner 使暂存的 `node-pty` 载荷的平台和架构明确，并将不支持的预构建资产暴露为构建失败。压缩包仍是简单且可验证的命令行下载，但用户必须自行解压，工作流不提供安装器体验或签名。

Release 资产 job 需要具有 contents write 权限的 GitHub Actions token，而构建 job 保持只读。Release 资产上传失败时可以重试，不必重新构建或重新发布 npm 包。
