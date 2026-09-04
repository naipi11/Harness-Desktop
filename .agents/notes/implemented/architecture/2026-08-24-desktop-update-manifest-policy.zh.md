# Agent Note: Desktop 更新 manifest 策略

Status: implemented

[English](2026-08-24-desktop-update-manifest-policy.md) | 中文

## 问题

Desktop 更新元数据是不可信输入。畸形、被替换、跨频道、跨平台或携带路径的 manifest 可能让 Main process 选择不属于已安装 Harness Desktop 应用的产物。

## 决策

`apps/desktop/src/main/update/manifest.ts` 负责精确 manifest 解析、规范签名字节、Ed25519 公钥验证、版本比较、目标选择、HTTPS origin 准入、摘要语法和归档成员路径准入。它只返回一个脱敏选中产物或一个固定拒绝代码；绝不返回 URL、密钥 id、签名、manifest 正文或原始 crypto 错误。

已发货的 `PRODUCTION_DESKTOP_UPDATE_TRUST` 不含 origin 和公钥，因此每个生产检查都会以 `unconfigured-trust-root` 拒绝，直到单独审查的发布配置同时提供两者。单元测试在内存中生成临时 Ed25519 密钥；这些密钥不是发布信任材料。

Apple-Silicon 或 Intel macOS process 可以选择一个 `darwin` `universal` DMG。任何请求若有多个兼容产物都会被拒绝，而不是按偶然的 manifest 顺序选择。

验证器不获取数据、不对下载字节做摘要、不检查实际归档、不暂存安装器、不修改运行中的应用、不请求重启，也不回滚。之后的 Main-process 暂存所有者必须在使用该选中声明前重新检查下载摘要和实际归档成员。

## 考虑过的替代方案

**在配置公钥前快速放行。** 被拒绝，因为缺少信任根会让任何可达元数据源成为更新授权方。

**使用 Electron-updater 默认 feed。** 被拒绝，因为产品需要显式的应用、频道、目标、origin、归档和脱敏规则，而不是传输方式特有的隐式策略。

**在 renderer 或 Dashboard 中验证。** 被拒绝，因为浏览器代码不得持有信任密钥或接收原始 manifest 数据，也不拥有原生产物生命周期。

## 后果

未来更新器在网络或安装器变更之前拥有一个确定且可测试的准入点。发布工程必须通过审查的配置改动明确添加不可变的 allowlisted origin 和公钥；构建和本地测试都不会提供它们。

manifest 签名会在签名之前排序产物和成员路径，因此有效签名不依赖产生方列表顺序。重复的兼容目标和不安全成员会被拒绝，而不依赖解压器行为。

manifest 测试覆盖临时密钥验证、签名篡改、产品/频道/版本/目标不匹配、URL 和摘要拒绝、归档路径拒绝以及 universal macOS 选择。
