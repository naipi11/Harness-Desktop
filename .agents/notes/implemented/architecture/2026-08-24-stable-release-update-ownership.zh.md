# Agent Note: 稳定版发布更新所有权

Status: implemented

[English](2026-08-24-stable-release-update-ownership.md) | 中文

## Problem

签名 manifest 策略、持久化更新偏好、文件系统事务与发布工作流具有不同权限。合并这些职责可能让不可信发布数据进入持久化状态、让 Runtime 修改安装，或让验证任务执行签名或发布。发布证据还需要明确的完成点，以防部分写入的 manifest 集合被消费。

## Decision

`@harness-desktop/dsh-update-policy` 是唯一的签名 manifest 解析器与选择器。它会校验字段完全一致的记录、规范化 Ed25519 签名、应用、channel、消费方、目标、版本、HTTPS 源、摘要语法及安全归档成员，再返回不含 URL、密钥、签名或原始 manifest 的脱敏产物。它不会执行候选 I/O、安装变更、信任配置或结果持久化。

Runtime 通过现有设置提供方持有所选 Desktop channel 与最后一个持久化脱敏结果。存储的 channel 为 `stable`、`beta` 和 `nightly`；存储的结果种类为 `up-to-date`、`staged`、`applied`、`rolled-back` 和 `failed`。固定代码为 `unconfigured-trust-root`、`up-to-date`、`staged`、`applied`、`rolled-back`、`manifest-rejected`、`artifact-rejected`、`health-check-failed` 和 `install-failed`。持久化记录只包含版本、channel、种类、代码和可选的最后已知良好版本。

Desktop Main 通过 `DesktopUpdateService` 与平台 `StageAdapter` 持有临时 Desktop 候选变更。经过配置的事务会把成功暂存、应用及健康检查失败后的成功恢复分别映射为 Runtime 的 `staged`/`staged`、`applied`/`applied` 与 `rolled-back`/`health-check-failed`；manifest、产物和安装失败会映射为脱敏的 `failed` 结果。恢复失败会返回 Desktop 本地代码 `candidate-restore-failed`，并记录 `failed`/`install-failed`。随产品提供的 Main 使用 `EMPTY_UPDATE_TRUST` 与惰性适配器，因此会在加载 manifest、候选 I/O、启动进程或文件系统变更之前返回 `up-to-date`/`unconfigured-trust-root`。

CLI 持有自身的包管理器提示与独立同级事务，不使用 Runtime 状态。npm 布局只输出 `npm update -g @harness-desktop/cli`，不会执行该命令。信任配置为空的独立布局会在候选 I/O 之前返回 `up-to-date`/`unconfigured-trust-root`。经过单独配置的事务会校验共享策略、字节、成员及可执行路径，然后完成暂存、切换、捆绑 Node 与 CLI 入口检查，并在健康检查失败时恢复保留的 bundle。

## 发布证据与审批

`writeUpdateManifests()` 会先在内存中准备每个目标 manifest，再通过一次独占目录创建预留最终输出根目录，把集合写入私有内部暂存目录，并把该暂存目录重命名为 `ready`。只有 `ready/<manifest>` 路径才是完整且可消费的。脚本不会改动竞争方持有的根目录，失败清理也绝不会递归删除已预留的根目录。

无凭据的 Desktop 产物工作流使用 `--publish never` 打包。原生 CI 分别持有 Windows NSIS 与 CLI ZIP 证据、macOS universal DMG 与 CLI tar 证据（包括 `lipo` 检查），以及 Linux AppImage、Deb 与 CLI tar 证据。单个主机的本地或缓存产物不能证明其他原生行，也不能证明新建的独立归档。

生产更新信任仍是单独的运维先决条件：调用方配置任一 updater 前，公钥、不可变 HTTPS 源及发布位置均需独立审计。Windows 签名、macOS 公证、生产更新 manifest 签名、npm 发布、更新产物上传及创建 GitHub Release 均为单独审批操作。手动 candidate 工作流只验证是否恰好选择了一个未来操作；它不含凭据、release 权限、环境或外部操作步骤。

## Alternatives considered

- **让 Runtime 安装更新** — 不采用，因为 Runtime 持有持久化共享状态，而原生安装变更属于 Desktop Main 或独立 CLI 事务。
- **发布默认生产密钥与源** — 不采用，因为部署信任与发布位置需单独审计，并且必须在获得授权前保持缺失。
- **把已预留的 manifest 根目录视为就绪** — 不采用，因为写入方可能在预留后失败；内部 `ready` 重命名才是完整集合的发布点。
- **通过工作流布尔值组合签名与发布** — 不采用，因为休眠的外部命令与凭据会让证据收集获得更改 release 状态的权限。

## Consequences

仓库验证可以证明签名前准备就绪，但不会配置可实际运行的自动更新，也不会授予外部发布权限。运维方必须提供已审计的生产信任，并分别取得每项外部审批。原生证据仍由各平台持有，消费方必须拒绝 `ready/` 之外的 manifest 路径。
