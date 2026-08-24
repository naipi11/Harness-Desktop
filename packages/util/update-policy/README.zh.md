# dsh-update-policy

[English](README.md) | 中文

`@harness-desktop/dsh-update-policy` 用于校验已解码的签名更新清单，并选择一个已脱敏的产物。它只接受字段完全一致的普通对象记录、有效 Ed25519 签名、严格的语义版本、已配置的 HTTPS 源、受支持的消费方和目标、小写 SHA-256 摘要以及安全的归档成员路径。拒绝结果只返回稳定代码，不会返回 URL、签名、密钥标识符或归档载荷。

该包只提供解析和策略，不下载制品、不安装软件、不重启应用，也不提供信任配置。消费者负责提供应用标识、已安装版本、所选通道、目标、允许的源和公钥。`EMPTY_UPDATE_TRUST` 是随产品发布的默认拒绝配置。

## 公共 API

包入口导出 `UpdateChannel`、`SignedUpdateManifest`、`UpdateManifestPolicy`、`RedactedUpdateArtifact`、`verifySignedUpdateManifest`、`canonicalizeSignedUpdateManifest` 和 `EMPTY_UPDATE_TRUST`。

`verifySignedUpdateManifest()` 会在检查分离签名前规范化产物及成员排序。`desktop` 接受通用架构 macOS DMG、Windows NSIS，以及具体架构 Linux AppImage 或 Deb。`cli` 接受 ZIP 或 tar.gz 独立归档。消费方筛选发生在目标歧义处理之前，因此一个安装不会接受另一消费方的产物。

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
