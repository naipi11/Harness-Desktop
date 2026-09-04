# dsh-update-policy

[English](README.md) | 中文

`@harness-desktop/dsh-update-policy` 用于校验已解码的签名更新清单，并为源所有者选择一个精确产物。它只接受字段完全一致的普通对象记录、有效 Ed25519 签名、严格的语义版本、已配置的 HTTPS 源、受支持的消费方、平台、架构和格式、小写 SHA-256 摘要以及安全的归档成员路径。拒绝结果只返回稳定代码，不会返回原始 manifest、签名、密钥标识符或归档载荷。

该包解析和选择 manifest、校验公开发布策略，并进行受限 HTTPS 读取。它不安装软件、不重启应用、不持久化更新状态，也不提供生产信任。消费者负责提供应用标识、已安装版本、所选通道、目标、允许的源和公钥。`EMPTY_UPDATE_TRUST` 是库级默认拒绝的空配置。

## 公共 API

核心 manifest 导出包括 `UpdateChannel`、`SignedUpdateManifest`、`UpdateManifestPolicy`、`RedactedUpdateArtifact`、`VerifiedUpdateArtifact`、`verifySignedUpdateManifest`、`canonicalizeSignedUpdateManifest` 和 `EMPTY_UPDATE_TRUST`；发布策略与受限 HTTPS 导出见下文。`VerifiedUpdateArtifact` 只把 manifest 已认证的 HTTPS URL 提供给紧随其后的下载方；它不是持久化 Runtime 结果或安装器请求。

`parseReleaseUpdateConfiguration()` 会校验 schema 版本 3 的只含公开信息嵌入式策略。其五字段候选键标识 channel、消费方、平台、架构和格式；其六字段回滚键再加入精确的已安装语义版本。`nativeWorkerReadyTimeoutMs` 限制 Main 交接前原生工作器的准备时间；`healthCheckTimeoutMs` 限制等待旧进程退出，以及安装后候选 Dashboard 的健康检查时间。`fetchAllowedUpdateJson()` / `fetchAllowedUpdateBytes()` 会强制允许的 HTTPS 源与字节上限。`verifySignedUpdateManifest()` 会在检查分离签名前规范化产物及成员排序。`desktop` 接受通用架构 macOS ZIP 或 DMG、Windows NSIS，以及具体架构 Linux AppImage 或 Deb。`cli` 接受 ZIP 或 tar.gz 归档。消费方与精确格式筛选发生在目标歧义处理之前，因此一个安装不会接受另一消费方的产物。

## 模型体验

### 更新清单策略

#### 模型可见内容

模型请求不包含该包解析的清单、信任值或校验结果。

#### Token 影响

直接 Token 影响为 `0`：该包不注册提示词、工具 schema 或模型结果。

#### KV Cache 影响

模型请求不会变化，因此该包不会使可复用的模型前缀失效。

## 已知限制和延后工作

- **生产信任配置** — `EMPTY_UPDATE_TRUST` 有意不包含发布源或公钥，因此消费者必须提供经过审计的生产信任配置，才可能接受任何候选版本。
