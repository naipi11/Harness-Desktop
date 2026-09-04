# Desktop 更新 manifest 策略实施计划

[English](2026-08-24-desktop-update-manifest-policy.md) | 中文

> **供 agentic worker 使用：** 必须使用子技能 `superpowers:executing-plans`，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）记录。

**目标：** 添加一个 Desktop Main-process 验证器，只接受本地提供、已签名且与目标匹配的更新 manifest；生产更新信任未配置时快速失败。

**架构：** `apps/desktop/src/main/update/manifest.ts` 负责精确 JSON 解析、规范签名载荷、Ed25519 验证、语义版本比较、目标选择、HTTPS origin allowlist、SHA-256 语法和归档成员路径检查。它返回封闭、脱敏的结果；不获取、解压、暂存、安装、重启或回滚。已编译的生产信任策略有意不含 origin 或公钥，而测试注入临时 Ed25519 密钥对。

**技术栈：** TypeScript、Node.js `node:crypto`、Electron Main-process 代码、Vitest 与 `@harness-desktop/dsh-app-boot` 产品元数据。

**规格：** [Harness Desktop 产品架构设计](../specs/2026-08-15-harness-desktop-design.md)

## 全局约束

- 验证器只运行在 Desktop Main-process 代码中；renderer 不接收信任密钥、manifest 正文、产物 URL、暂存路径或原始验证错误。
- 生产信任快速失败：空 origin 或公钥配置会在接受产物前返回 `unconfigured-trust-root`。
- 测试可生成临时 Ed25519 密钥对并签署内存载荷。它绝不读取生产密钥、下载产物、联络发布服务、上传数据、安装软件、重启 Electron 或修改 `HARNESS_HOME`。
- 只接受 `stable`、`beta` 和 `nightly`；冻结的产品 `appId`；严格更新的语义版本；以及当前 `win32`/`darwin`/`linux` 和 `x64`/`arm64` 目标。`darwin` 的 `universal` DMG 与任一 macOS 运行架构兼容；一个请求若有多个兼容产物则会被拒绝。
- 每个选中产物必须有 allowlisted 精确 origin 上的 HTTPS URL、小写 64 位十六进制 SHA-256、一种受支持产物格式，以及由安全正斜杠相对路径构成的非空归档成员。绝对路径、盘符路径、反斜杠、冒号、控制字符、空组件、`.` 和 `..` 都会被拒绝。
- 未知 manifest、签名、产物或策略字段都会拒绝 manifest。验证不会为了之后诊断而保留未识别输入。
- 输出只包含稳定结果代码；接受时只包含选中产物的脱敏版本/频道/目标/摘要/成员列表。它绝不回显 URL、签名、密钥 id、manifest 正文或错误文本。
- 维护英文/中文计划和 Agent Note 对侧文件。不得触碰 `vendor/`、`.superpowers/`、`dist/`、签名身份、发布凭据或发布工作流。

---

### 任务 1：用失败测试定义脱敏 manifest 解析

**文件：**

- 新建：`apps/desktop/tests/update-manifest.spec.ts`

**接口：**

- 定义 `verifyDesktopUpdateManifest(input, policy): DesktopUpdateManifestVerification`。
- 定义 `canonicalizeDesktopUpdateManifest(manifest): Buffer`，用于签署精确且不含签名的载荷。

- [x] **步骤 1：编写失败的接受和拒绝测试**

创建测试辅助函数，生成 Ed25519 密钥对，为 `productMetadata.appId` 构造 manifest，签署 `canonicalizeDesktopUpdateManifest(...)`，并把公钥和 `https://updates.example.test` 作为仅测试策略提供。断言接受的较新产物返回其版本、频道、平台、架构、SHA-256、格式和安全成员列表，但不包含 URL、签名或密钥 id。

```text
const result = verifyDesktopUpdateManifest(signedManifest('stable', '1.1.0'), policy({ channel: 'stable' }))
expect(result).toEqual({
  kind: 'accepted',
  artifact: {
    version: '1.1.0', channel: 'stable', platform: process.platform,
    arch: process.arch, format: expectedFormat, sha256: 'a'.repeat(64),
    members: ['Harness Desktop.app/Contents/MacOS/harness-desktop'],
  },
})
```

为以下字面拒绝案例添加测试：空生产信任策略、被改动的签名、未知密钥 id、非 HTTPS URL、错误 origin、错误 app id、错误频道、相同/降级版本、缺失/当前不支持的目标、重复目标产物、非十六进制摘要、遍历成员、盘符成员、反斜杠成员、未知字段，以及任一载荷字段变更后不再匹配的签名。分别添加一例证明有效的 `stable`、`beta` 和 `nightly` manifest 只被其自身所选频道接受。

- [x] **步骤 2：运行测试并确认验证器尚不存在**

运行：`pnpm exec vitest run apps/desktop/tests/update-manifest.spec.ts`

预期：FAIL，因为 `apps/desktop/src/main/update/manifest.ts` 及其验证器导出尚不存在。

### 任务 2：实现纯粹、快速失败的 Desktop manifest 验证器

**文件：**

- 新建：`apps/desktop/src/main/update/manifest.ts`
- 修改：`apps/desktop/tests/update-manifest.spec.ts`

**接口：**

- 产出 `DesktopUpdateArtifactFormat = 'nsis' | 'dmg' | 'appimage' | 'deb'`、`DesktopUpdateArchitecture = 'x64' | 'arm64' | 'universal'` 与 `DesktopUpdateManifestPolicy`，其中包括 `appId`、`currentVersion`、`channel`、`platform`、`arch`、`allowedOrigins` 和按密钥 id 索引的 PEM 公钥。
- 产出 `DesktopUpdateManifestVerification = { kind: 'accepted'; artifact: RedactedDesktopUpdateArtifact } | { kind: 'rejected'; code: DesktopUpdateManifestRejectionCode }`。
- 产出不含公钥和 origin 的 `PRODUCTION_DESKTOP_UPDATE_TRUST`。

- [x] **步骤 1：实现精确记录解析和规范签名字节**

只解析 plain object，精确要求每个已知键一次，并构造脱离输入的带类型记录，而不是保留输入。通过固定顶层键顺序 `schemaVersion`、`applicationId`、`channel`、`version` 和 `artifacts` 序列化对象，作为签名载荷；按 `platform`、`arch` 和 `format` 排序产物；按字典顺序排序每个成员列表；省略 `signature`。在签名验证前拒绝重复目标和重复成员。

```text
const payload = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  applicationId: manifest.applicationId,
  channel: manifest.channel,
  version: manifest.version,
  artifacts: orderedArtifacts,
}), 'utf8')
```

- [x] **步骤 2：实现快速失败的策略和签名检查**

在解析接受结果之前，将空 `allowedOrigins` 或公钥 map 拒绝为 `unconfigured-trust-root`。要求 `signature.algorithm === 'ed25519'`、已知 PEM 密钥 id、有界的 base64url 签名和 `crypto.verify(null, canonicalPayload, key, signature)`。捕获畸形 PEM 或 crypto 输入并返回 `signature-invalid`，绝不反射错误。任何结果都不公开密钥 id 或签名。

- [x] **步骤 3：实现目标和产物检查**

用不同稳定代码拒绝 app/频道/版本/目标不匹配。只选择一个匹配 `policy.platform` 和 `policy.arch` 的产物；`darwin` 的 `universal` DMG 同时匹配 `x64` 与 `arm64`。拒绝无匹配或多匹配。要求 `https:`、位于 `policy.allowedOrigins` 的 origin、小写 64 位十六进制摘要，并要求每个声明成员路径符合全局安全路径规则。成功时只返回选中脱敏产物。

- [x] **步骤 4：运行源码测试、Desktop 类型检查和聚焦 lint**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/update-manifest.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run typecheck
pnpm exec tsx scripts/run-oxlint.ts apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts
```

预期：每个有效测试密钥只验证其自身未修改的规范载荷；每个无效输入都返回脱敏拒绝，不带 URL、密钥 id、签名、路径或原始 crypto 错误。

- [x] **步骤 5：提交 manifest 策略实现**

运行：

```powershell
git add apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts
git diff --cached --check
git commit -m "feat(desktop): verify signed update manifests"
```

### 任务 3：记录信任边界并配对文档

**文件：**

- 新建：`.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.zh.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.i18n.yaml`
- 修改：`docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md`
- 修改：`docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.zh.md`
- 修改：`docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.i18n.yaml`

**接口：**

- 记录 Desktop Main 验证器只拥有信任和选择策略，而之后的暂存安装所有者负责下载、解压、健康确认、原子切换和回滚。

- [x] **步骤 1：编写配对的 Agent Note**

创建一个已实现的架构 Agent Note，包含 `Problem`、`Decision`、`Alternatives considered` 和 `Consequences`。说明空生产信任策略拒绝更新、仅测试密钥不是发布密钥，并且 renderer/browser 代码绝不接收信任材料或原始 manifest 数据。将被拒绝的 fail-open 和 Electron-updater-default 替代方案与所采用的显式验证器作比较。

- [x] **步骤 2：重新记录并验证两个指定双语对**

运行：

```powershell
pnpm run verify-translation-pairing --write .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md
pnpm run verify-translation-pairing .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md
pnpm run verify-agent-note-format
pnpm run verify-md-wrap
pnpm run verify-md-links
git diff --check
```

预期：信任决策具有两种语言对侧文件，且没有文案宣称生产更新器或密钥已配置。

- [x] **步骤 3：随 manifest 策略提交文档**

运行：

```powershell
git add .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.md .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.zh.md .agents/notes/implemented/architecture/2026-08-24-desktop-update-manifest-policy.i18n.yaml docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.zh.md docs/superpowers/plans/2026-08-24-desktop-update-manifest-policy.i18n.yaml
git diff --cached --check
git commit -m "docs(desktop): record update manifest trust policy"
```

## 计划自检

- 该计划在引入任何产物变更前覆盖签名、频道、身份、版本、目标、摘要、origin 和归档路径准入。
- 生产信任有意为空；测试只携带临时本地密钥。
- 每个之后的更新动作依赖该验证器，但不改变其封闭输出格式。
