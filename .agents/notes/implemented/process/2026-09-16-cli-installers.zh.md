# Agent Note: Native CLI installers

Status: implemented

English | [English](2026-09-16-cli-installers.md)

## Problem

独立 CLI 压缩包需要手动解压，在 Windows 和 Debian 上没有软件包元数据或卸载路径。

## Decision

发布流程使用 Inno Setup 6.7.0，从已验证的 Windows x64 CLI 可执行文件构建 `dsh-<version>-win-x64-setup.exe`；使用 `dpkg-deb`，从匹配的已验证 Linux CLI 可执行文件构建 `dsh_<version>_amd64.deb` 或 `dsh_<version>_arm64.deb`。Windows 安装程序将当前用户应用安装到 `%LOCALAPPDATA%\DeepSeek Harness` 并提供卸载程序。每个 Debian 软件包都将 dsh 安装到 `/usr/bin/dsh`，包含匹配的 Debian control 元数据，并可通过 `apt` 删除。每个软件包都有 SHA-256 校验文件。

打包只在现有 CLI 产物构建和验证之后运行。发布范围的 job 检查所有压缩包和软件包校验和，并要求两种安装包都存在后才创建或更新 GitHub Release，避免部分发布。构建 job 只有只读仓库权限，最终资产 job 才拥有 contents 写权限。

## Alternatives considered

**Chocolatey 或 winget 清单。** 未采用，因为它们会增加外部仓库所有权和软件包发布约定，超出 Release 资产范围。

**由单个 runner 交叉打包。** 未采用，因为输入 CLI 可执行文件和原生 `node-pty` 载荷由匹配的原生 runner 生成。

**独立发布软件包。** 未采用，因为发布必须提供完整且经过验证的资产集，而不是部分安装程序。

## Consequences

Windows x64 和 Debian x64/arm64 用户获得安装与卸载流程，其他支持的目标继续使用压缩包。安装包构建依赖固定的官方工具并保留可复现的源定义；生成的二进制文件留在 CI 产物中，不提交到仓库。
