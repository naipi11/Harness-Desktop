# 稳定版发布就绪实施计划

[English](2026-08-24-stable-release-readiness.md) | 中文

> **供 agentic worker 使用：** 必须使用子技能 `superpowers:subagent-driven-development`，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）记录。

**目标：** 交付一个经过测试验证、可单独签名和发布的 Harness Desktop 分支：Desktop 与独立 CLI 从已验证本地 fixture 更新，在候选失败后回滚，并在每个受支持原生平台上具有不发布的 CI 发布证据。

**架构：** 将签名 manifest 解析器和目标策略提取到一个由 Runtime、Desktop Main、独立 CLI 和发布脚本消费的零网络 utility 包。Desktop Main 拥有下载暂存、就绪确认和回滚；Runtime 仍是所选频道和脱敏结果的唯一所有者。CLI 在变更前检测包管理器所有权，而独立归档通过捆绑 Node runtime 原子更新其同级 payload。生产信任不在源码树中：所有类似发布的测试使用本地 fixture 密钥和产物，签名工作流只在本分支完成后接受独立的审批门控凭据。

**技术栈：** TypeScript、Node.js `node:crypto`/`node:fs`、Electron Main、pnpm、Electron Builder、Vitest、Playwright、GitHub Actions 原生 runner，以及既有 Harness Runtime 设置/控制 API。

**规格：** [Harness Desktop 产品架构设计](../specs/2026-08-15-harness-desktop-design.md)

## 全局约束

- 不签名、不公证、不上传、不发布、不创建 GitHub Release、不在隔离测试根目录外安装用户软件，也不推送分支。这些操作保留独立的明确用户批准。
- 生产信任在源码中没有允许的更新 origin 或公钥。每个产品消费者都会在网络、归档、进程或安装变更前返回 `unconfigured-update-source`；库级空信任结果仍为 `unconfigured-trust-root`。
- 测试密钥在内存中生成或只保存于隔离测试根目录。任何命令行、日志、测试报告、快照、Git 文件、诊断或面向用户的结果都不包含私钥、bearer token、manifest URL、原始 manifest、暂存路径或未脱敏错误。
- Runtime 拥有所选频道和脱敏结果持久化。Desktop 与 CLI 只能拥有瞬态暂存产物字节和其精确安装事务；它们不创建第二个设置存储。
- Desktop 发布 Windows x64 NSIS、适用于 Intel/Apple Silicon 的 macOS universal DMG 与 ZIP，以及 Linux x64 AppImage/Deb。macOS ZIP 是自更新传输物，DMG 仍是面向用户的分发产物。CLI 独立版接受匹配的 ZIP 和 tar 归档。Windows ARM64、Linux ARM64、RPM、Flatpak 和特定发行版安装器仍在首个稳定矩阵之外。
- 候选版本在匹配启动健康检查成功前绝不提交：Desktop 需要认证 Dashboard 启动后的既有精确 `desktop-dashboard-ready` 确认；独立 CLI 需要捆绑 runtime 成功执行 `harness --help`。
- 失败候选恢复保留版本，只记录脱敏 Runtime 结果，并使 `HARNESS_HOME` 保持不变。除显式保留的兼容 stable 回滚外，禁止降级。
- 每个包和文案改动遵循根/包/文档指令，在需要时添加中文对侧，并排除 `vendor/`、`.superpowers/`、`dist/` 和已归档 Agent Note。

---

### 任务 1：提取一个共享签名更新策略包

**文件：**

- 新建：`packages/util/update-policy/package.json`
- 新建：`packages/util/update-policy/tsconfig.json`
- 新建：`packages/util/update-policy/src/index.ts`
- 新建：`packages/util/update-policy/src/invariant.ts`
- 新建：`packages/util/update-policy/tests/update-policy.spec.ts`
- 新建：`packages/util/update-policy/README.md`
- 新建：`packages/util/update-policy/README.zh.md`
- 新建：`packages/util/update-policy/README.i18n.yaml`
- 修改：`apps/desktop/src/main/update/manifest.ts`
- 修改：`apps/desktop/tests/update-manifest.spec.ts`
- 修改：`packages/host/local-runtime/src/update-preferences.ts`
- 修改：`packages/host/local-runtime/src/runtime-client.ts`
- 修改：`packages/host/local-runtime/src/index.ts`
- 修改：`packages/util/README.md`
- 修改：`packages/util/README.zh.md`
- 修改：`packages/util/README.i18n.yaml`
- 修改：`tsconfig.host.json`
- 修改：`pnpm-lock.yaml`

**接口：**

- 产出来自 `@harness-desktop/dsh-update-policy` 的 `UpdateChannel`、`SignedUpdateManifest`、`UpdateManifestPolicy`、`RedactedUpdateArtifact`、`verifySignedUpdateManifest(input, policy)`、`canonicalizeSignedUpdateManifest(payload)` 和 `EMPTY_UPDATE_TRUST`。
- 保持 Runtime 公开 `DesktopUpdateChannel` 和结果类型为共享频道类型的重新导出；保留既有 Runtime 控制操作字符串和响应字段。
- 让 Desktop Main 的 `manifest.ts` 仅作为兼容重新导出，或在所有 Desktop import 直接命名 `@harness-desktop/dsh-update-policy` 后删除它；不保留第二个解析器。

- [ ] **步骤 1：编写失败的共享包和消费方测试**

将既有 Ed25519、规范顺序、origin、摘要、归档成员、原生安装器、accessor 和脱敏案例移到 `packages/util/update-policy/tests/update-policy.spec.ts`。添加一个接受共享频道类型的 Runtime 偏好测试，以及一个 import bare package entry 的 Desktop 测试。断言畸形 manifest 走唯一实现，而不是复制的 Desktop 解析器。

```text
import { verifySignedUpdateManifest } from '@harness-desktop/dsh-update-policy'

expect(verifySignedUpdateManifest(signedFixture, policy)).toEqual({
  kind: 'accepted',
  artifact: expect.objectContaining({ channel: 'stable', sha256: 'a'.repeat(64) }),
})
```

- [ ] **步骤 2：运行测试并确认共享 entry 尚不存在**

运行：

```powershell
pnpm exec vitest run packages/util/update-policy/tests/update-policy.spec.ts apps/desktop/tests/update-manifest.spec.ts packages/host/local-runtime/tests/update-preferences.spec.ts
pnpm exec tsc -b packages/util/update-policy/tsconfig.json
```

预期：FAIL，因为 utility 包及其公开 entry 尚不存在。

- [ ] **步骤 3：实现包并迁移所有当前消费方**

移动解析器但不改变其接受/拒绝值。将包声明为 `@harness-desktop/dsh-update-policy`，具有 Cordis peer/dev 依赖、空 invariant 说明、配对 README 和 host aggregate 引用。以共享类型替换 Runtime 本地频道字面量，并保持既有精确 `stable`、`beta` 和 `nightly` 行为。以包 entry 替换 Desktop 本地 import。更新 util 组映射，并且只重新生成受新包影响的生成引用。

- [ ] **步骤 4：在源码和构建面验证共享策略**

运行：

```powershell
pnpm exec vitest run packages/util/update-policy/tests/update-policy.spec.ts packages/host/local-runtime/tests/update-preferences.spec.ts apps/desktop/tests/update-manifest.spec.ts
pnpm run build
pnpm run verify-package-invariants
pnpm run verify:desktop-runtime-closure
pnpm exec tsx scripts/run-oxlint.ts packages/util/update-policy/src/index.ts packages/util/update-policy/tests/update-policy.spec.ts
```

预期：唯一实现拥有所有签名 manifest 决定，Runtime 控制保持兼容，构建 Desktop/CLI 依赖图保持闭合。

- [ ] **步骤 5：提交共享策略提取**

运行：

```powershell
git add packages/util/update-policy apps/desktop/src/main/update/manifest.ts apps/desktop/tests/update-manifest.spec.ts packages/host/local-runtime/src/update-preferences.ts packages/host/local-runtime/src/runtime-client.ts packages/host/local-runtime/src/index.ts packages/util/README.md packages/util/README.zh.md packages/util/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git diff --cached --check
git commit -m "refactor(update): share signed manifest policy"
```

### 任务 2：暂存、健康检查和回滚 Desktop 更新

**文件：**

- 新建：`apps/desktop/src/main/update/staged-install.ts`
- 新建：`apps/desktop/src/main/update/service.ts`
- 新建：`apps/desktop/tests/update-service.spec.ts`
- 新建：`apps/desktop/tests/support/update-fixture.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/desktop-dashboard.e2e.ts`
- 修改：`apps/desktop/package.json`

**接口：**

- 产出 `DesktopUpdateService.checkAndStage(): Promise<DesktopUpdateResult>` 和 `applyStagedUpdate(): Promise<DesktopUpdateResult>`。
- 产出 `DesktopUpdateResult` 种类 `up-to-date`、`staged`、`applied`、`rolled-back` 和 `failed`，每项只携带稳定脱敏代码和可选版本/频道。
- 产出 `StageAdapter.download`、`inspect`、`stage`、`launchCandidate`、`restoreRetained` 和 `cleanup` seam。生产适配器没有已配置源；测试适配器只使用临时目录和子进程。

- [ ] **步骤 1：编写失败的事务测试**

创建本地签名 manifest、fixture downloader、归档检查器和隔离安装根。要求空信任策略不调用任何 loader/downloader；要求有效候选下载到新暂存根，检查字节 SHA-256 和实际归档成员，保留当前安装并返回 `staged`。要求 `applyStagedUpdate()` 只在既有精确 Desktop 确认后接受候选；缺失、畸形或失败确认会恢复保留根，记录 `rolled-back`，并保留 `HARNESS_HOME` sentinel。

```text
expect(await service.checkAndStage()).toEqual({ kind: 'staged', code: 'candidate-staged', version: '1.1.0', channel: 'stable' })
expect(await service.applyStagedUpdate()).toEqual({ kind: 'rolled-back', code: 'desktop-health-check-failed', version: '1.1.0', channel: 'stable' })
expect(await readFile(harnessSentinel, 'utf8')).toBe('keep')
```

- [ ] **步骤 2：运行事务测试并确认服务尚不存在**

运行：`pnpm exec vitest run apps/desktop/tests/update-service.spec.ts`

预期：FAIL，因为暂存安装器和服务模块均不存在。

- [ ] **步骤 3：实现事务性 Desktop 暂存和 Main 集成**

使用由适配器拥有的唯一临时暂存目录，在任何切换前验证下载字节和实际成员，原子保留当前安装，并且只尝试一次候选启动。为认证 Dashboard 健康确认复用 `DesktopReadiness`；不添加 IPC。任何失败时，在记录 Runtime `failed` 或 `rolled-back` 结果前恢复保留安装。Main 使用 `EMPTY_UPDATE_TRUST` 创建服务；因此在独立签名发布配置提供信任前，它不获取或变更任何内容。

- [ ] **步骤 4：运行 Main、打包和回滚证据**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/update-service.spec.ts apps/desktop/tests/update-manifest.spec.ts
pnpm --filter @harness-desktop/dsh-desktop run test
pnpm run build
pnpm --filter @harness-desktop/dsh-desktop run package:dir
pnpm --filter @harness-desktop/dsh-desktop run test:e2e:unpacked
```

预期：源码和 unpacked Desktop 路径默认没有已配置更新源；仅测试候选能暂存、健康检查、应用和回滚，而不会删除 Runtime 数据。

- [ ] **步骤 5：提交 Desktop 更新事务支持**

运行：

```powershell
git add apps/desktop/src/main/update apps/desktop/src/main/index.ts apps/desktop/tests/update-service.spec.ts apps/desktop/tests/support/update-fixture.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/package.json
git diff --cached --check
git commit -m "feat(desktop): stage verified updates with rollback"
```

### 任务 3：添加包管理器感知和独立 CLI 更新

**文件：**

- 新建：`apps/cli/src/update.ts`
- 修改：`apps/cli/src/args.ts`
- 修改：`apps/cli/src/main.ts`
- 新建：`apps/cli/tests/update.spec.ts`
- 新建：`apps/cli/tests/update.e2e.ts`
- 修改：`apps/cli/tests/terminal-client.spec.ts`
- 修改：`apps/cli/package.json`

**接口：**

- 增加 `UpdateInvocation` 和公开语法 `harness update` / `dsh update`，不包含隐式 task 或 Web lease。
- 产出 `runUpdateInvocation(options): Promise<UpdateInvocationResult>`，结果为 `managed-by-npm`、`up-to-date`、`staged`、`applied`、`rolled-back` 和 `failed`。
- npm 安装副本精确打印 `npm update -g @harness-desktop/cli`，且不执行包管理器、归档或文件系统变更。独立副本消费共享签名策略，原子交换同级暂存归档，通过捆绑 Node 运行 `harness --help`，并在失败时恢复保留归档。

- [ ] **步骤 1：编写失败的命令和归档测试**

添加 `update` 的解析器测试和额外参数拒绝。创建记录文件系统和进程调用的 npm-prefix fixture；要求 stdout 包含托管命令且不发生变更。创建带本地签名 manifest/归档的解压独立 fixture；要求 SHA-256/成员验证、同级保留副本、捆绑 Node 健康检查、原子切换和候选启动失败回滚。fixture 提供字节后，不允许 `npm`、registry 或网络进程调用。

- [ ] **步骤 2：运行测试并确认命令尚不存在**

运行：

```powershell
pnpm exec vitest run apps/cli/tests/update.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts
```

预期：FAIL，因为解析器和 dispatcher 中没有 `update`。

- [ ] **步骤 3：实现安装形式检测和独立事务**

从已解析安装包布局检测包管理器所有权，而不从可变环境提示检测。将该形式直接路由到稳定命令结果。对于独立归档，只解析同级捆绑路径，复用 `@harness-desktop/dsh-update-policy`，在没有 `PATH` Node 的情况下暂存和验证，原子重命名 payload，为健康检查启动捆绑 runtime，并在任何失败时恢复保留 payload。把所有原始 manifest 和路径数据保持为内部信息。

- [ ] **步骤 4：验证 CLI 源码、pack 和独立路径**

运行：

```powershell
pnpm exec vitest run apps/cli/tests/update.spec.ts apps/cli/tests/terminal-client.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts apps/cli/tests/standalone-archive.e2e.ts
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
```

预期：npm 副本绝不变更；独立候选只通过捆绑 Node 的健康检查；失败启动恢复之前的归档并使 `HARNESS_HOME` 保持不变。

- [ ] **步骤 5：提交 CLI 更新行为**

运行：

```powershell
git add apps/cli/src/update.ts apps/cli/src/args.ts apps/cli/src/main.ts apps/cli/tests/update.spec.ts apps/cli/tests/update.e2e.ts apps/cli/tests/terminal-client.spec.ts apps/cli/package.json
git diff --cached --check
git commit -m "feat(cli): update standalone archives safely"
```

### 任务 4：生成并验证不发布的 release manifest 和原生 smoke 门禁

**文件：**

- 新建：`scripts/release/build-update-manifest.ts`
- 新建：`scripts/release/build-update-manifest.spec.ts`
- 新建：`scripts/release/verify-update-manifests.ts`
- 新建：`scripts/release/verify-update-manifests.spec.ts`
- 修改：`package.json`
- 修改：`scripts/run-gates.ts`
- 新建：`.github/workflows/desktop-artifacts.yml`
- 新建：`.github/workflows/release-candidates.yml`
- 修改：`scripts/desktop-release-config.spec.ts`

**接口：**

- 从已构建产物路径和调用方提供的签名材料生成确定性频道 manifest；缺失签名输入时以非零退出且不产出。
- 产出 `release:verify-update-manifests`、`desktop:test-updater` 和 `release:test-cli-update` 命令，它们使用本地 fixture 密钥/产物且绝不发布。
- 产出 PR 原生矩阵，以 `--publish never` 打包，验证产物，运行 packed/standalone/update/rollback 测试，并只上传产物和脱敏日志。
- 产出手动调度的 release-candidate workflow，其 `sign-windows`、`notarize-macos`、`sign-update-manifests`、`publish-npm` 和 `create-github-release` 输入各自默认 false，并拒绝缺失或合并批准。

- [ ] **步骤 1：编写失败的 release 脚本和 workflow 断言**

在临时目录创建 Ed25519 fixture 密钥。要求确定性 canonical stable/beta/nightly manifest，拒绝重复目标产物、错误签名、不兼容回滚、不安全归档成员和缺失签名输入。扩展 workflow 断言，要求全部不发布原生检查，并拒绝 PR 上的凭据变量、发布命令、未批准签名和更新上传。

- [ ] **步骤 2：运行 release 测试并观察缺少的命令/workflow**

运行：

```powershell
pnpm exec vitest run scripts/release/build-update-manifest.spec.ts scripts/release/verify-update-manifests.spec.ts scripts/desktop-release-config.spec.ts
```

预期：FAIL，因为 manifest producer/verifier 脚本和专用原生 workflow 尚不存在。

- [ ] **步骤 3：实现确定性产物、manifest 和 CI 所有权**

只从命名的本地产物和提供的密钥字节构建 manifest；拒绝外部下载。Windows 拥有 NSIS/ZIP smoke，macOS 拥有带 `lipo` 的 universal-DMG 加 ZIP/tar smoke，Linux 拥有 AppImage/Deb/tar smoke。NSIS、ZIP 和 AppImage 这类不透明 Desktop 安装器由摘要与安装器启动检查，归档成员检查由发布验证器负责。打包后要求 updater 回滚检查。让签名/公证/发布作业手动调度并分别审批门控；没有 PR 或普通 smoke job 具有发布凭据。

- [ ] **步骤 4：验证脚本和当前平台原生发布证据**

运行：

```powershell
pnpm exec vitest run scripts/release/build-update-manifest.spec.ts scripts/release/verify-update-manifests.spec.ts scripts/desktop-release-config.spec.ts
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:verify-update-manifests
```

预期：本地 fixture manifest 和当前平台产物验证通过，无签名、上传、发布或跨平台模拟声明；其他原生证据由新 CI 矩阵拥有。

- [ ] **步骤 5：提交 release 门禁和 workflow 就绪状态**

运行：

```powershell
git add scripts/release package.json scripts/run-gates.ts .github/workflows/desktop-artifacts.yml .github/workflows/release-candidates.yml scripts/desktop-release-config.spec.ts
git diff --cached --check
git commit -m "test(release): gate verified update rollback"
```

### 任务 5：完成文档、审阅和签名就绪交接

**文件：**

- 修改：`README.md`
- 修改：`README.zh.md`
- 修改：`README.i18n.yaml`
- 修改：`apps/cli/README.md`
- 修改：`apps/cli/README.zh.md`
- 修改：`apps/cli/README.i18n.yaml`
- 修改：`apps/desktop/package.json`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.zh.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.i18n.yaml`

**接口：**

- 记录精确更新命令、支持安装形式、回滚行为、生产信任要求、平台证据边界和独立批准动作。它绝不发布含有密钥、token 或 release URL 的说明。

- [ ] **步骤 1：编写基于源码的双语用户和维护者文档**

记录 npm 和 standalone 形式的 `harness update`、信任配置前的 Desktop 快速失败行为、恢复/回滚结果代码、受支持平台矩阵以及已就绪但未执行的外部操作。添加一个已实现 Agent Note，记录共享策略所有权、Runtime 结果持久化、Main/CLI 变更所有权和明确批准边界。

- [ ] **步骤 2：运行完整本地发布就绪验证**

运行：

```powershell
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run verify:desktop-runtime-closure
pnpm --filter @harness-desktop/dsh-desktop run test
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts apps/cli/tests/standalone-archive.e2e.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts
git diff --check
```

预期：每个任务拥有的检查通过。如果计划外仍有仓库级基线失败，记录其精确命令、文件和变更范围是否通过；不要用全局例外隐藏它。

- [ ] **步骤 3：获得最终全分支审阅并准备批准交接**

针对记录的 merge base 运行最终 subagent-driven 全分支审阅。通过审阅循环解决每个 Critical/Important 发现。报告仍由平台拥有的精确本地和 CI 检查、所需签名/公证/发布批准以及分支 commit 范围；不推送或发布。

- [ ] **步骤 4：提交最终签名就绪文档和证据**

运行：

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/desktop/package.json .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.md .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.zh.md .agents/notes/implemented/architecture/2026-08-24-stable-release-update-ownership.i18n.yaml
git diff --cached --check
git commit -m "docs(release): prepare stable signing handoff"
```

## 计划自检

- 任务按依赖排序：共享策略、Desktop 事务、CLI 事务、release manifest/CI，最后是文档和证据。
- Desktop 和 CLI 共用一个签名 manifest 实现；Runtime 只保留频道和脱敏结果；没有任务创建第二数据根或在源码中存储生产信任。
- 计划将代码就绪的发布工作和外部签名/公证/发布批准分开，因此通过的本地分支绝不意味着外部发布已发生。
