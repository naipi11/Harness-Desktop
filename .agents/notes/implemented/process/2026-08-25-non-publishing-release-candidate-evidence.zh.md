# Agent Note: 非发布 release candidate 证据

Status: implemented

[English](2026-08-25-non-publishing-release-candidate-evidence.md) | 中文

## 问题

[Desktop 产物矩阵](../feature/2026-08-16-desktop-release-config.md)在不发布的情况下完成打包，[共享签名更新策略](../architecture/2026-08-24-shared-signed-update-policy.md)则验证单个消费方目标，但不会在多个兼容格式之间进行选择。release readiness 仍需具备确定性签名元数据、针对确切本地产物字节的证明、原生格式所有权，以及 updater 回滚检查。若为 PR（Pull Request）任务提供 release 凭据或休眠的发布命令，证据收集过程就会获得更改外部 release 状态的能力。

## 决策

`scripts/release/build-update-manifest.ts` 接受调用方指定的本地产物和 Ed25519 私钥文件。脚本在本地派生 SHA-256 摘要与归档成员，为每组 channel、消费方、平台、架构和格式生成一个 manifest（元数据清单），且每个 manifest 只包含一个可选产物。所有 manifest 均使用 `io.github.naipi11.harness-desktop`；Linux AppImage 与 Deb 使用独立 endpoint，不向共享策略加入格式偏好。builder 仅在所有输入都已读入内存后签名，并通过 `verifySignedUpdateManifest()` 验证结果。脚本以独占方式把完整集合写入随机命名的同级目录，拒绝已存在的输出目录，再通过一次目录重命名完成发布；暂存写入失败后不会留下最终集合或暂存集合。

`scripts/release/verify-update-manifests.ts` 读取调用方提供的 Ed25519 公钥文件，先调用共享 parser 和签名 verifier，再执行 release 布局规则：已签名 manifest 必须只包含一个与预期 channel、消费方、平台、架构和格式匹配的产物。脚本只读取一次指定产物，并在归档解析或原生执行前拒绝 SHA-256 不匹配。基于路径的 inspector 接收包含相同快照的私有文件，ZIP 检查则直接使用内存中的字节。AppImage 检查只接收最小化环境。ZIP 与 tar 检查可跨平台运行；NSIS、DMG、AppImage 和 Deb 检查使用对应的原生 runner。这些脚本既不下载产物，也不会在仓库中保留 release 位置、密钥、签名或 manifest fixture（测试前置数据）。

`.github/workflows/desktop-artifacts.yml` 保持无凭据，并以 `--publish never` 运行 Builder。Windows 负责 NSIS 与 CLI ZIP 证据，macOS 负责 universal DMG 与 CLI tar 证据并执行 `lipo` 检查，Linux 负责 AppImage、Deb 与 CLI tar 证据。每个 runner 都会调用经过测试的 `verify-node-runtime-archive.ts` 命令，根据仓库固定值验证文件名和 SHA-256，standalone builder 随后才能解压或使用该文件；打包后再运行 Desktop 与 CLI updater 或回滚检查。工作流审计要求按既定顺序执行该确切命令，因此仅 echo 标记不能作为证据。Windows 主机不能替代 macOS 或 Linux 任务的证明。

`.github/workflows/release-candidates.yml` 只能手动 dispatch。其 `sign-windows`、`notarize-macos`、`sign-update-manifests`、`publish-npm` 与 `create-github-release` 输入均默认为 false。唯一的任务会在不保留凭据的情况下 checkout 源码，再运行经过测试的 `select-release-candidate-operation.mjs` 命令；该命令拒绝选择数量不等于 1 的请求，并报告选中的未来操作，但不会执行它。该工作流不包含权限、release environment、凭据、签名、公证、发布、上传或 GitHub Release 步骤，审计还会要求使用确切的 validator 命令与输入映射。

## 考虑过的替代方案

**把所有兼容格式放入同一个消费方 manifest。** 不采用。共享策略刻意不设格式偏好，因此两个兼容产物会产生歧义。按目标格式拆分 manifest，使配置的 endpoint 可以显式选择格式。

**信任与 Node 归档一同下载的 checksum。** 不采用。来自同一运行时来源的文件共享同一信任路径。工作流从仓库读取固定 SHA-256，并在解压或使用前完成比较。

**提交 fixture 密钥，或通过 false 输入让 candidate 任务保持休眠。** 不采用。提交的签名材料会形成可复用的 secret 状态，而休眠的外部命令仍会扩大工作流权限。测试会生成临时密钥与产物；candidate 工作流只验证隔离规则。

## 后果

release 证据可复现且不发布：确切本地产物、目标标识、签名、摘要、成员、回滚版本和原生冒烟测试必须一致，candidate 才能继续推进。未来的 release 实现必须在一次单独评审的授权变更中加入外部操作；当前工作流无法签名、公证、发布、上传更新或创建 GitHub Release。原生验证仍依赖各操作系统 runner，不能把单个主机的结果当作跨平台证明。
