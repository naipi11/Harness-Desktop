# Runtime 更新偏好实施计划

[English](2026-08-24-runtime-update-preferences.md) | 中文

> **供 agentic worker 使用：** 必须使用子技能 `superpowers:executing-plans`，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）记录。

**目标：** 让共享本地 Runtime 成为 Desktop 更新频道与脱敏更新结果记录的唯一所有者，同时不创建更新器、信任根、下载器或安装器。

**架构：** `packages/host/local-runtime` 通过现有设置提供方注册一个 `desktop-update` 设置区段。已认证的原生与 Dashboard 控制路由只公开所选频道；原生调用方还可写入固定格式且不含密钥的结果。Runtime 在本次交付中不获取、验证、暂存、应用或回滚任何产物。

**技术栈：** TypeScript、Cordis、`@harness-desktop/dsh-settings`、Schemastery、Vitest 与既有的私有 Runtime 控制协议。

**规格：** [Harness Desktop 产品架构设计](../specs/2026-08-15-harness-desktop-design.md)

## 全局约束

- `HARNESS_HOME` 仍是唯一可写 Harness 根目录；Electron user data、renderer 与 CLI 本地文件绝不拥有更新偏好或结果。
- 唯一允许的频道为 `stable`、`beta` 与 `nightly`；默认值为 `stable`。
- 已存结果只包含语义版本、频道、固定结果、固定代码与可选的最后已知良好语义版本。它绝不接受或存储 URL、token、签名、manifest 正文、路径、错误文本、归档名称或进程细节。
- Runtime 在精简测试组合没有设置提供方时仍能运行；更新控制请求在此时快速失败。已发货的基础组合具有该提供方。
- 本阶段不提供发布信任根。之后的 Desktop 或独立 CLI 更新器在生产信任配置缺失时必须拒绝更新。
- 测试前置数据只使用内存设置与本地假值。它们不签名、下载、安装、发布、上传、公证，或调用包管理器。
- 同一改动维护英文/中文对侧文件与 Agent Note。不得触碰 `vendor/` 或已归档 Agent Note。

---

### 任务 1：添加 Runtime 所有的偏好记录

**文件：**

- 新建：`packages/host/local-runtime/src/update-preferences.ts`
- 新建：`packages/host/local-runtime/tests/update-preferences.spec.ts`
- 修改：`packages/host/local-runtime/package.json`
- 修改：`pnpm-lock.yaml`

**接口：**

- 产出 `DesktopUpdateChannel = 'stable' | 'beta' | 'nightly'`。
- 产出 `DesktopUpdateOutcome`，其 `kind` 为 `up-to-date`、`staged`、`applied`、`rolled-back` 或 `failed`，其 `code` 为封闭、脱敏的枚举。
- 产出 `DesktopUpdatePreferences.getChannel()`、`setChannel(channel)` 与 `record(outcome)`，它们都由 `settings.register(settingsNamespace('desktop-update'), ...)` 支持。

- [x] **步骤 1：编写失败的偏好测试**

在测试中创建本地 `MemorySettings` 子类，在真实 Cordis `Context` 中启动它，然后构造 `DesktopUpdatePreferences`。断言初始频道是 `stable`；执行 `setChannel('beta')` 后，提供方文档恰好包含 `{ channel: 'beta' }`；执行 `record(...)` 后，它保留该频道并只增加允许的结果字段。以延迟持久化同时开始频道写入与结果写入，等待两者完成，并断言没有丢失任何已提交字段。

```text
expect(preferences.getChannel()).toBe('stable')
await preferences.setChannel('beta')
await preferences.record({ version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged' })
expect(settings.doc['desktop-update']).toEqual({
  channel: 'beta',
  lastOutcome: { version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged' },
})
```

- [x] **步骤 2：运行新测试，并确认它因缺少模块而失败**

运行：`pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts`

预期：FAIL，因为 `../src/update-preferences.ts` 尚不存在。

- [x] **步骤 3：实现最小设置所有者**

添加具有精确频道与结果联合类型的 `desktop-update` schema。从提供的 `SettingsProvider` 构造一个 `SettingsScope`；`getChannel()` 读取其已解析频道，两个写操作调用 `scope.update(...)`，从而让提供方现有的串行写入队列与文件持久化保持权威。把不可信协议输入的验证保留在控制路由解析器；不要增加第二个文件写入方或可选的兼容格式。

```text
const scope = settings.register(DESKTOP_UPDATE_SETTINGS_NAMESPACE, DESKTOP_UPDATE_SETTINGS_SCHEMA)
return {
  getChannel: () => scope.get().channel,
  setChannel: channel => scope.update({ channel }),
  record: outcome => scope.update({ lastOutcome: outcome }),
}
```

为 `@harness-desktop/dsh-settings` 与 `@harness-desktop/schemastery` 添加直接运行时依赖，然后通过 pnpm 重新生成 lockfile，不要手工编辑它。

- [x] **步骤 4：运行偏好测试与包类型检查**

运行：`pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts`

运行：`pnpm exec tsc -b packages/host/local-runtime/tsconfig.json`

预期：两个命令都通过；测试使用真实设置提供方队列，且绝不创建更新专用持久化路径。

- [x] **步骤 5：提交独立的偏好所有者**

运行：

```powershell
git add packages/host/local-runtime/src/update-preferences.ts packages/host/local-runtime/tests/update-preferences.spec.ts packages/host/local-runtime/package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(runtime): own Desktop update preferences"
```

### 任务 2：通过已认证控制路由传递脱敏 Runtime API

**文件：**

- 修改：`packages/host/local-runtime/src/runtime-client.ts`
- 修改：`packages/host/local-runtime/src/control-routes.ts`
- 修改：`packages/host/local-runtime/src/control-service.ts`
- 修改：`packages/host/local-runtime/src/runtime.ts`
- 修改：`packages/host/local-runtime/src/index.ts`
- 修改：`packages/host/local-runtime/tests/control-service.spec.ts`
- 修改：`packages/host/local-runtime/tests/runtime-client.spec.ts`

**接口：**

- 增加 `RuntimeClient.getDesktopUpdateChannel(): Promise<DesktopUpdateChannel>` 与 `RuntimeClient.setDesktopUpdateChannel(channel): Promise<DesktopUpdateChannel>`。
- 仅为原生调用方增加 `RuntimeClient.recordDesktopUpdateOutcome(outcome): Promise<void>`。
- 增加已认证 Dashboard 操作 `get-desktop-update-channel` 与 `set-desktop-update-channel`；Dashboard 控制不能读取或写入已记录结果。
- 增加具有精确请求键的原生操作：`get-desktop-update-channel`、带 `channel` 的 `set-desktop-update-channel`，以及带 `outcome` 的 `record-desktop-update-outcome`。

- [x] **步骤 1：编写失败的协议与所有权测试**

用真实内存设置提供方扩展私有控制 Runtime fixture。通过 `RuntimeClient` 断言原生附加项读取 `stable`、改为 `nightly` 并收到已提交值。直接向控制路由发送畸形 JSON，覆盖意外频道、额外键、任意结果代码或 URL 形式结果字段；要求收到既有的稳定 invalid-control 响应。使用已认证 Dashboard 请求变更频道，然后证明企图记录结果会被拒绝，而不会变成 Dashboard 能力。

```text
await expect(client.setDesktopUpdateChannel('nightly')).resolves.toBe('nightly')
await expect(client.recordDesktopUpdateOutcome({
  version: '1.2.3', channel: 'nightly', kind: 'failed', code: 'manifest-rejected',
})).resolves.toBeUndefined()
expect(await dashboardControl('get-desktop-update-channel')).toBe('nightly')
```

- [x] **步骤 2：运行聚焦测试，并确认公开 API 尚未存在**

运行：`pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts`

预期：在类型检查或运行时 FAIL，因为客户端方法与控制操作尚不存在。

- [x] **步骤 3：实现精确解析器、保留项与客户端方法**

扩展请求联合类型和 `parseControlSuccess()`，增加频道字符串与固定结果对象的严格解析器。扩展 `isRuntimeControlRequest()` 与 `isDashboardControlRequest()`，使得只有命名键集能跨越 HTTP 边界。当 `ctx.get('settings')` 存在时，从 `startRuntime()` 传递一个 `DesktopUpdatePreferences` 实例。`set` 和 `record` 使用 `retainRuntime(...)`，这样空闲转换不会在设置写入期间 dispose Runtime；读取不创建保留项。如果精简组合没有设置，走既有脱敏 unavailable 失败路径，不创建后备存储。

```text
case 'set-desktop-update-channel':
  requireBaseClient(clients, clientId)
  return retainRuntime(async () => updatePreferences.setChannel(request.channel))
case 'record-desktop-update-outcome':
  requireBaseClient(clients, clientId)
  return retainRuntime(async () => updatePreferences.record(request.outcome))
```

只从 `src/index.ts` 导出公开类型与连接器方法；不要导出端点细节、设置提供方内部实现或任何持久化路径。

- [x] **步骤 4：运行源码与构建控制证据**

运行：`pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts`

运行：`pnpm run build`

运行：`pnpm exec vitest run packages/host/local-runtime/tests/runtime-process.compat.spec.ts`

预期：全部测试通过；畸形控制正文仍被拒绝，Dashboard 访问仅限频道，构建 Runtime 客户端兼容性保持完整。

- [x] **步骤 5：提交 Runtime 控制 API**

运行：

```powershell
git add packages/host/local-runtime/src/runtime-client.ts packages/host/local-runtime/src/control-routes.ts packages/host/local-runtime/src/control-service.ts packages/host/local-runtime/src/runtime.ts packages/host/local-runtime/src/index.ts packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts
git diff --cached --check
git commit -m "feat(runtime): expose redacted update control"
```

### 任务 3：记录耐久所有权及其安全决策

**文件：**

- 修改：`packages/host/local-runtime/README.md`
- 修改：`packages/host/local-runtime/README.zh.md`
- 修改：`packages/host/local-runtime/README.i18n.yaml`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.zh.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.i18n.yaml`

**接口：**

- 记录 Runtime 拥有频道与脱敏结果持久化、Dashboard 只看见频道，以及本次交付在之后生产信任配置出现前不能安装或获取更新。

- [x] **步骤 1：编写配对的包约定与 Agent Note**

向包 README 的迁移/提供方所有权小节添加一个简短段落。说明 namespace 名称、三个可接受频道、固定的脱敏结果字段、Dashboard/原生拆分，以及该包不执行更新操作的事实。创建一个已实现的架构 Agent Note，包含 `Problem`、`Decision`、`Alternatives considered` 与 `Consequences`；记录拒绝 Electron 本地状态和 fail-open 默认值的原因。

- [x] **步骤 2：重新记录三个双语对**

运行：

```powershell
pnpm run verify-translation-pairing --write packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.md
pnpm run verify-translation-pairing packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.md
```

预期：三个指定双语对都在结构上对齐，伴随记录包含当前 blob hash。

- [x] **步骤 3：运行聚焦文档与发布准备检查**

运行：

```powershell
pnpm run verify-agent-note-format
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run verify-package-readme-model-experience
pnpm run verify-package-readme-limitations
pnpm run verify-package-paths
git diff --check
```

预期：Task 7 文件路径真实存在，文档具有配对对侧，Runtime README 保持其已记录的约定。

- [x] **步骤 4：随实现提交文档**

运行：

```powershell
git add packages/host/local-runtime/README.md packages/host/local-runtime/README.zh.md packages/host/local-runtime/README.i18n.yaml .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.zh.md .agents/notes/implemented/architecture/2026-08-24-runtime-owned-update-preferences.i18n.yaml docs/superpowers/plans/2026-08-24-runtime-update-preferences.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.zh.md docs/superpowers/plans/2026-08-24-runtime-update-preferences.i18n.yaml
git diff --cached --check
git commit -m "docs(runtime): record update preference ownership"
```

## 计划自检

- 已批准的更新架构通过一个 Runtime 偏好所有者与已认证频道控制得到覆盖；产物信任、下载、暂存、安装与回滚刻意留待后续交付单元，因为尚未提供生产信任配置。
- 该计划命名了本次交付所有新建或修改的文件，并在消费方使用前定义每个公开类型和方法。
- 执行前审阅本计划是否含有禁止的实现占位语；没有任何任务把未指定行为委托给之后的步骤。
