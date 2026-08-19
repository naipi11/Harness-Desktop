# Harness 共享本地 Runtime 基础实施计划

[English](2026-08-18-harness-runtime-foundation.md) | 中文

> **供代理执行者使用：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 构建唯一拥有一个 `HARNESS_HOME` 的本地 Runtime，并向 CLI、浏览器 Dashboard 和 Desktop 客户端提供安全的共享状态。

**架构：** 既有 `host` 组中的新 `@harness-desktop/dsh-host-local-runtime` 包解析并导入数据根目录，拥有原子实例锁和端点记录，只组合一次现有 Harness 服务，并发布经过认证的回环 API。它是 CLI 和 Electron Main 使用的公共 Node API 的唯一生产者。原生启动器使用私有端点令牌控制 Runtime；启动器拥有的瞬态本地 bootstrap document 从不透明 file origin 只在表单正文中提交一次性 handoff、收到 HttpOnly 会话 cookie，并跟随干净 Dashboard `303` 导航。

**技术栈：** Node.js `^22.19.0 || >=24.0.0`、pnpm 11、TypeScript、Cordis、现有 WebServer/API proxy/Web frontend 包、Vitest、可与 Playwright 兼容的 HTTP fixture。

**规格：** [Harness 统一本地 Runtime 设计](../specs/2026-08-18-harness-unified-local-runtime-design.md) 和 [Harness Desktop 产品架构](../specs/2026-08-15-harness-desktop-design.md)。

## 全局约束

- 一个 `HARNESS_HOME` 恰好有一个 Runtime；只有 Runtime 能挂载或写入会话、项目元数据、设置、凭据引用、锁和端点记录。
- 在执行前解析 `HARNESS_HOME`：Windows `%LOCALAPPDATA%\Harness Desktop`；macOS `~/Library/Application Support/Harness Desktop`；Linux `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`；`HARNESS_HOME` 覆盖默认值。
- 旧 `DSH_HOME` 迁移只向空目标复制受支持的非秘密数据，绝不覆盖或删除任一根目录，并返回标识保留源和目标的类型化结果。
- Runtime 只绑定 `127.0.0.1` 且端口为 `0`；没有配置或回退可允许局域网监听。
- 端点令牌和凭据值绝不进入命令行、初始导航 URL、Renderer 消息、浏览器脚本存储、会话记录、日志、诊断或快照。高熵 handoff 只可出现在一次来自本地 file origin 的表单 `POST /_harness/handoff` 正文中，绝不进入 URL、header、referrer、history、浏览器存储、Renderer IPC、日志、诊断或会话记录；请求体采集在进入任何日志或诊断输出前必须脱敏。launcher 以仅所有者 POSIX mode 或当前用户 Windows ACL 创建 bootstrap 目录和文件、验证其保护并拒绝权限更宽的位置。它的精确一次 cleanup timer 绑定到 `expiresAt`；dispatch failure、exchange success 或 failure、expiry 以及从未 dispatch 的 document 都通过同一幂等 cleanup 精确一次删除所属文件和目录。交换有意不要求 Origin 相等，也不发送 CORS permission。交换后的随机或签名会话凭据是唯一浏览器例外：Runtime 只在 `Set-Cookie` 中发送它，浏览器只在 `Cookie` 请求头中发送它，并只在 HttpOnly cookie jar 中保留它；它使用 `HttpOnly; SameSite=Strict; Path=/`、不带 expiry attribute，绝不进入 Dashboard JavaScript、Renderer IPC、脚本存储、应用持久化、日志、诊断、快照或会话记录。
- 端点记录包含协议版本、随机端口、Runtime 身份和进程启动身份；只有在证明记录的进程身份已死亡后才移除陈旧记录。
- 含令牌的端点记录是 Runtime 基础层控制面状态。只有其私有发现实现读取或解析该记录；应用只消费 `RuntimeConnector`，并且只得到脱敏类型化错误和公开 origin 数据。
- 原生控制请求用私有端点令牌认证。仅正文的 handoff 交换通过未使用且未过期的不透明密钥接受 file origin；普通 Dashboard API 和事件请求使用精确回环 origin 加由该单次、60 秒内 handoff 签发的 `HttpOnly; SameSite=Strict; Path=/` 会话 cookie 认证。
- Runtime 只有在附加客户端数、活动 agent 操作数和后台租约数都为零时才退出；崩溃、退出登录或更新绝不会从陈旧租约重新启动它。
- 本计划不改变 CLI 或 Electron 客户端行为。后续计划消费 Runtime 公共 API，且不得复制其锁、持久化、凭据或组合逻辑。没有调用方可解析端点记录或获得其令牌；`RuntimeConnector` 是唯一受限 control-plane 读取者。
- 每个新包和 Agent Note 都有英文、简体中文和已记录的 `.i18n.yaml` 同级文件。

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| `packages/host/local-runtime/src/data-root.ts` | 解析唯一数据根目录并执行安全的单向旧数据导入。 |
| `packages/host/local-runtime/src/process-identity.ts` | 读取并比较平台进程启动身份，不把重用的 PID 误判为存活。 |
| `packages/host/local-runtime/src/instance-lock.ts` | 获取、验证、释放和恢复每个根目录的原子所有者锁。 |
| `packages/host/local-runtime/src/endpoint-record.ts` | 原子持久化私有端点记录并派生脱敏状态。 |
| `packages/host/local-runtime/src/runtime-client.ts` | 导出唯一的公共发现、附加、终端、handoff、租约、状态、恢复和关闭 API。 |
| `packages/host/local-runtime/src/auth.ts` | 实现原生令牌控制认证和浏览器 handoff/cookie 认证。 |
| `packages/host/local-runtime/src/runtime.ts` | 组合规范 Cordis 树、记录工作和租约，并拥有优雅的空闲关闭。 |
| `packages/host/local-runtime/src/control-routes.ts` | 挂载私有原生控制路由和已认证的浏览器 API/事件路由。 |
| `packages/host/local-runtime/src/bin.ts` | 从源码和构建产物运行一个 Runtime 进程；它没有公开用户命令。 |
| `packages/host/local-runtime/tests/` | 隔离的文件系统/进程/认证测试及干净树 Runtime 集成测试。 |
| `packages/util/home-paths/src/index.ts` | 只保留无依赖路径原语；它绝不导入 Runtime policy 或选择 Harness 数据根目录。 |

### 任务 1：创建 Runtime 包、公共类型和数据根解析器

**文件：**
- Create: `packages/host/local-runtime/package.json`，包名为 `@harness-desktop/dsh-host-local-runtime`
- Create: `packages/host/local-runtime/tsconfig.json`
- Create: `packages/host/local-runtime/tsdown.config.ts`
- Create: `packages/host/local-runtime/src/index.ts`
- Create: `packages/host/local-runtime/src/data-root.ts`
- Create: `packages/host/local-runtime/src/invariant.ts`
- Create: `packages/host/local-runtime/README.md`
- Create: `packages/host/local-runtime/README.zh.md`
- Create: `packages/host/local-runtime/README.i18n.yaml`
- Create: `packages/host/local-runtime/tests/data-root.spec.ts`
- Modify: `packages/host/README.md`
- Modify: `packages/host/README.zh.md`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `packages/util/home-paths/src/index.ts`
- Modify: `packages/util/home-paths/tests/home-paths.spec.ts`
- Modify: `apps/cli/src/profile-boot.ts`
- Modify: `apps/cli/src/web-daemon.ts`
- Modify: `packages/attachment/attachment-local/src/index.ts`
- Modify: `packages/boot/app-boot/src/index.ts`
- Modify: `packages/boot/app-boot/src/profile.ts`
- Modify: `packages/context/agent-instructions/src/config.ts`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Modify: `packages/examples/agent-spine-demo/src/index.ts`
- Modify: `packages/identity/anonymous-user-id/src/index.ts`
- Modify: `packages/preset/agent-presets/src/index.ts`
- Modify: `packages/settings/settings-file/src/index.ts`
- Modify: `packages/shell/shell-env/src/index.ts`
- Modify: `packages/skill/skill-filesystem/src/index.ts`
- Modify: `apps/web/tests/scaffold.ts`、`packages/boot/app-boot/tests/app-boot.spec.ts` 和受影响 consumer fixture

**接口：**
- Consumes: 文件系统路径、现有 `@harness-desktop/dsh-brand` helper，以及没有应用服务。
- Produces: `HarnessHome`、`resolveHarnessHome(input)`、`defaultHarnessHome(platform, env, homeDir)`、`HarnessHomeProvider` 和 `createLocalRuntimePlugin(config)`。

- [ ] **Step 1: 编写失败的数据根测试**

创建表驱动测试，传入注入的 `platform`、`env` 和 `homeDir` 值。要求解析器返回精确默认值或 `HARNESS_HOME` 覆盖值、将其规范化为绝对路径、拒绝只有空白的覆盖值，并且绝不选择 `DSH_HOME` 作为写入目标。加入一个在新包尚不存在时导入 `HarnessHome` 的测试。

- [ ] **Step 2: 运行聚焦测试并确认包缺失**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/data-root.spec.ts packages/util/home-paths/tests/home-paths.spec.ts
```

预期：FAIL，因为 `packages/host/local-runtime` 和 `HARNESS_HOME` API 不存在。

- [ ] **Step 3: 添加最小类型化解析器和包边界**

从 `@harness-desktop/dsh-brand` 导入 `Branded`，不得重新声明它。将全部 `HARNESS_HOME` 默认值解析保留在 `resolveHarnessHome` 中，而非调用者内部：

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type HarnessHome = Branded<'HarnessHome'>

export interface HarnessHomeInput {
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly localAppData?: string
}

export interface HarnessHomeResolution {
  readonly path: HarnessHome
  readonly source: 'environment' | 'platform-default'
  readonly legacyDshHome: string | undefined
}

export declare function resolveHarnessHome(input?: HarnessHomeInput): HarnessHomeResolution
```

将 `expandHomePath()` 和 `canonicalizeWatchPath()` 保留在 `packages/util/home-paths`；移除其中的 `defaultDshHome`、`resolveDshHome`、`dshHomePath` 和 `DSH_HOME` policy export，而不是令该工具包依赖 host 包。Runtime 导入这些无依赖原语，解析唯一 `HARNESS_HOME` policy，并向每个 writer 注入已解析的 `HarnessHomeProvider`/绝对路径。迁移文件列表中列出的每个当前 policy consumer：CLI profile/Web 路径、attachment-local、app-boot/profile 与 Loader expression、agent instructions、credentials-local、agent-spine demo、anonymous identity、presets、settings、shell environment、skill filesystem 及其 app/test fixture。测试必须断言除显式标记的旧数据导入 source reader 外，不存在 `resolveDshHome`、`dshHomePath` 或 `DSH_HOME` 默认 writer，并且每个挂载的可写路径都收到同一注入的 `HarnessHome`。在创建任务中一并建立完整 package skeleton、README 配对和 i18n record。将子包登记到两份 host README 映射，在 `tsconfig.base.json` 加入 `@harness-desktop/dsh-host-local-runtime` 与 `@harness-desktop/dsh-host-local-runtime/*` 的精确 source alias，并在 `tsconfig.host.json` 加入项目引用；这些登记属于包边界，不能延后为清理工作。

- [ ] **Step 4: 运行源码和产物检查**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/data-root.spec.ts packages/util/home-paths/tests/home-paths.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run typecheck
```

预期：所有测试通过；构建包导出解析器，现有兼容 helper 只有一个委托实现。

- [ ] **Step 5: 提交数据根基础**

运行：

```powershell
git add packages/host/local-runtime packages/host/README.md packages/host/README.zh.md tsconfig.base.json tsconfig.host.json packages/util/home-paths
git diff --cached --check
git commit -m "feat(runtime): add Harness data-root resolver"
```

### 任务 2：添加安全旧数据导入和平台凭据引用准入

**文件：**
- Create: `packages/host/local-runtime/src/legacy-import.ts`
- Create: `packages/host/local-runtime/tests/legacy-import.spec.ts`
- Create: `packages/credentials/credentials-platform/src/index.ts`
- 新建：`packages/credentials/credentials-platform/package.json`
- 新建：`packages/credentials/credentials-platform/tsconfig.json`
- 新建：`packages/credentials/credentials-platform/tsdown.config.ts`
- 新建：`packages/credentials/credentials-platform/src/invariant.ts`
- 新建：`packages/credentials/credentials-platform/README.md`
- 新建：`packages/credentials/credentials-platform/README.zh.md`
- 新建：`packages/credentials/credentials-platform/README.i18n.yaml`
- Create: `packages/credentials/credentials-platform/tests/platform-provider.spec.ts`
- Modify: `packages/credentials/README.md`
- Modify: `packages/credentials/README.zh.md`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Modify: `packages/bundle/base/cordis.patch.yml`
- Modify: `packages/host/local-runtime/package.json`

**接口：**
- Consumes: `HarnessHomeResolution`、现有凭据服务定义和注入的文件系统/凭据 adapter。
- Produces: `detectLegacyImport()`、`recordLegacyImportDecision(decision)`、`importLegacyDshHome(request)`、`LegacyImportResult` 和一个只允许 Runtime 使用的凭据提供方；它持久化引用但从平台/环境提供方获得秘密值。

- [ ] **Step 1: 编写失败的导入和秘密边界测试**

创建临时源和目标根目录。要求成功导入将受支持的会话/设置/项目元数据复制到空目标、保留源并报告复制路径。要求非空目标返回 `{ kind: 'target-not-empty' }`，复制失败返回 `{ kind: 'failed', retained: [...] }`，且两种结果都不删除根目录。在旧 `.credentials.yaml` 中放置哨兵秘密值，并要求导入后没有目标文件包含该哨兵。首启时，要求 Runtime 所有的检测暴露类型化待决定状态，记录不含秘密的接受/拒绝/结果，并在冲突或失败后暴露可执行的重试，同时保留两个根目录。覆盖完整 credentials-platform 包的 manifest、构建面、invariant、双语 README 和 i18n 记录，不能把它当作没有归属的源码目录。

- [ ] **Step 2: 运行聚焦测试并确认行为缺失**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/legacy-import.spec.ts packages/credentials/credentials-platform/tests/platform-provider.spec.ts
```

预期：FAIL，因为导入器和平台凭据提供方不存在。

- [ ] **Step 3: 实现显式导入和凭据引用结果类型**

使用以下结果分支，使调用方无需解析文本即可渲染安全的修正方法：

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type HarnessHome = Branded<'HarnessHome'>
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>

export type LegacyImportResult =
  | { readonly kind: 'imported'; readonly copied: readonly string[]; readonly source: string; readonly target: HarnessHome }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'target-not-empty'; readonly target: HarnessHome }
  | { readonly kind: 'failed'; readonly source: string; readonly target: HarnessHome; readonly retained: readonly string[]; readonly diagnosticId: RuntimeDiagnosticId }
```

只通过 staging directory 加原子移动复制已知的非秘密根。新提供方从平台/环境 adapter 解析凭据值，并只在 `HARNESS_HOME` 下存储不透明引用元数据；从 Runtime 组合中移除文件提供方路径，而不是静默读取旧值。随包创建 credentials-platform README 配对和 i18n record。将它加入两份 credentials README 映射，在 `tsconfig.base.json` 加入精确 `@harness-desktop/dsh-credentials-platform` 和 `@harness-desktop/dsh-credentials-platform/*` source alias，并在 `tsconfig.host.json` 加入其项目引用。

Runtime 存储待处理/接受/拒绝/结果状态并执行导入，但绝不替用户决定。交互式 CLI 拥有终端提示；`harness web` 和已安装 Desktop 在各自正常附加后展示同一个 Dashboard 迁移 UI。非交互 `run` 调用报告类型化 `migration-decision-required` 恢复诊断。客户端不得自行复制；用户修正所报告的冲突或失败后，只能通过 Runtime 重试已接受的导入。

- [ ] **Step 4: 运行提供方、导入和构建验证**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/legacy-import.spec.ts packages/credentials/credentials-platform/tests/platform-provider.spec.ts packages/credentials/credentials-local/tests/local.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run verify-cordis-config
pnpm run verify-translation-pairing --write packages/credentials/credentials-platform/README.md
pnpm run verify-translation-pairing packages/credentials/credentials-platform/README.md
pnpm run typecheck
```

预期：导入行为可恢复，没有秘密哨兵移入目标，规范 base 组合解析新提供方，且完整 credentials-platform 包通过其 invariant 和双语包文档检查。

- [ ] **Step 5: 提交迁移边界**

运行：

```powershell
git add packages/host/local-runtime packages/credentials/README.md packages/credentials/README.zh.md packages/credentials/credentials-platform packages/credentials/credentials-local packages/bundle/base tsconfig.base.json tsconfig.host.json
git diff --cached --check
git commit -m "feat(runtime): import legacy data without credential values"
```

### 任务 3：用锁、进程身份和端点记录证明单实例所有权

**文件：**
- Create: `packages/host/local-runtime/src/process-identity.ts`
- Create: `packages/host/local-runtime/src/instance-lock.ts`
- Create: `packages/host/local-runtime/src/endpoint-record.ts`
- Create: `packages/host/local-runtime/tests/fixtures/runtime-owner.ts`
- Create: `packages/host/local-runtime/tests/instance-lock.spec.ts`
- Create: `packages/host/local-runtime/tests/endpoint-record.spec.ts`
- Modify: `packages/host/local-runtime/src/index.ts`

**接口：**
- Consumes: `HarnessHome`、原子文件系统操作和用于跨平台测试的注入进程 probe。
- Produces: `ProcessIdentity`、`RuntimeLock`、`PrivateEndpointRecord`、`RedactedRuntimeStatus`，且没有携带令牌的状态 serializer。

- [ ] **Step 1: 编写失败的并发所有者和陈旧记录测试**

针对一个临时 `HARNESS_HOME` 启动 fixture owner 进程。要求第一次获取成功，且并发获取返回 `{ kind: 'owned-by-live-runtime' }`。写入一个 PID 与 probe 匹配但进程启动身份不同的记录；要求它被分类为陈旧，且只有证明不匹配后才被移除。断言端点文件原子替换，并且其脱敏视图省略 `accessToken`。在 POSIX 上断言仅所有者可读写的文件模式；在 Windows 上断言当前用户 ACL/策略结果而非 POSIX 模式位。两种平台均尝试直接从应用层访问端点文件，并断言公共 API 拒绝该操作且无法泄露令牌。

- [ ] **Step 2: 运行聚焦进程测试并观察缺失模块**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/instance-lock.spec.ts packages/host/local-runtime/tests/endpoint-record.spec.ts
```

预期：FAIL，因为没有锁、进程身份或端点记录模块。

- [ ] **Step 3: 使用带品牌的身份实现所有权记录**

使用精确持久化字段，并保持携带令牌的记录私有：

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export interface ProcessIdentity {
  readonly pid: number
  readonly startedAt: string
}

export interface PrivateEndpointRecord {
  readonly protocolVersion: 1
  readonly runtimeId: Branded<'RuntimeId'>
  readonly port: number
  readonly process: ProcessIdentity
  readonly accessToken: string
}

export interface RedactedRuntimeStatus {
  readonly state: 'running' | 'stopping'
  readonly runtimeId: Branded<'RuntimeId'>
  readonly port: number
  readonly backgroundLeaseCount: number
}
```

在挂载任何有状态服务之前，通过 exclusive creation 获取锁。遇到冲突时探测记录的进程身份；只有已证明死亡的所有者允许清理和替换。通过同目录临时文件加 rename 写入端点更新，在平台支持时设为仅当前用户权限，并只向诊断暴露 `RedactedRuntimeStatus`。

- [ ] **Step 4: 运行锁、产物和 Node 兼容检查**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/instance-lock.spec.ts packages/host/local-runtime/tests/endpoint-record.spec.ts
pnpm run build:lib:host
pnpm run check:node-compat
```

预期：不能驱逐存活所有者，不把 PID 重用当作存活所有权，构建代码只使用受支持的 Node API。

- [ ] **Step 5: 提交单一所有者原语**

运行：

```powershell
git add packages/host/local-runtime
git diff --cached --check
git commit -m "feat(runtime): guard one owner per Harness home"
```

### 任务 4：实现原生控制认证和浏览器 handoff 认证

**文件：**
- Create: `packages/host/local-runtime/src/auth.ts`
- Create: `packages/host/local-runtime/src/control-routes.ts`
- Create: `packages/host/local-runtime/tests/local-auth.e2e.ts`
- Create: `packages/host/local-runtime/tests/control-routes.spec.ts`
- Modify: `packages/client/connection/src/index.ts`
- Modify: `packages/host/local-runtime/src/index.ts`

**接口：**
- Consumes: `WebServer`、`client-connection` 路由注册和 `PrivateEndpointRecord`。
- Produces: 私有原生控制路由、浏览器 `POST /_harness/handoff`、会话 cookie 验证，以及一个挂载已认证 API/事件路由的 callback。

- [ ] **Step 1: 编写失败的安全和 handoff 集成测试**

在端口 `0` 上启动真实回环 `WebServer`。要求没有 `Authorization: Bearer <accessToken>` 的原生控制返回 401，正确认证可签发 handoff。以已验证的仅所有者 POSIX mode 或当前用户 Windows ACL 创建 bootstrap 目录和文件，并拒绝权限更宽的位置。证明来自不透明 file origin 的顶级表单可到达 `/_harness/handoff`，并在 60 秒内只交换同一 handoff 一次；要求 `Set-Cookie` 带 `HttpOnly`、`SameSite=Strict`、`Path=/` 且不带 expiry attribute，随后拒绝错误、重放或过期的 handoff。要求交换响应不发送 CORS permission。推进到从未 dispatch 的 `expiresAt` 并证明 launcher cleanup 精确运行一次；也证明 dispatch failure、exchange success 与 exchange failure 都调用同一精确一次 cleanup，删除所属 document 和目录。交换后，格式错误/非回环 Origin、跨 origin 的 cookie 请求以及未认证的 API/WebSocket 请求必须返回或升级为 forbidden。断言初始导航 URL、除已认证会话 `Cookie` 外的请求 headers、referrer、history、存储、日志、诊断、快照和浏览器可见错误均不包含 handoff 或端点令牌。只允许 handoff 出现在表单正文，并断言所有请求体采集均脱敏。

- [ ] **Step 2: 运行聚焦认证测试并确认其失败**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-routes.spec.ts packages/host/local-runtime/tests/local-auth.e2e.ts
```

预期：FAIL，因为 Runtime 没有认证层或 handoff 路由。

- [ ] **Step 3: 添加一次性仅正文 handoff 交换和精确 origin API middleware**

定义内存 handoff map，其值包含高熵不透明密钥、`expiresAt` 和可原子消费的未使用状态。在 `/_harness/control/*` 下挂载私有控制路由；签发只返回 `BrowserHandoff` 不透明值。在 SPA fallback 之前挂载 `POST /_harness/handoff`。launcher 创建新的仅所有者 bootstrap 目录和文件，在打开干净 file URL 前验证其 POSIX mode 或 Windows 当前用户 ACL，并拒绝权限更宽的位置。绑定一个到 `expiresAt` 的幂等 cleanup timer；它只接收 bootstrap 路径，并在 dispatch failure、exchange success 或 failure，或 expiry 后精确一次删除所属文件和目录。handler 不得检查 Origin 相等，只能将有效、未使用且未过期的表单正文 handoff 交换为 session `HttpOnly; SameSite=Strict; Path=/` cookie 中的随机或签名服务端会话凭据；该 cookie 不带 expiry attribute，响应不发送 CORS permission，并返回干净 `303`。包装 `client-connection` API 和事件注册，使两者都要求该 cookie 和精确 origin；保留现有 DNS-rebinding 防护，而不是削弱 privileged-method policy。

- [ ] **Step 4: 运行认证、Web 路由和源码/构建检查**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-routes.spec.ts packages/host/local-runtime/tests/local-auth.e2e.ts packages/client/connection/tests/node-half.host.spec.ts packages/host/webserver/tests/webserver.spec.ts
pnpm run build:lib:host
pnpm run typecheck
```

预期：只有干净重定向后的 Dashboard URL 已有 cookie 时 Dashboard 才启动；cookie 认证在源码和构建组合中保护 HTTP 和 WebSocket carrier。

- [ ] **Step 5: 提交本地认证层**

运行：

```powershell
git add packages/host/local-runtime packages/client/connection
git diff --cached --check
git commit -m "feat(runtime): authenticate local Dashboard clients"
```

### 任务 5：组合规范 Runtime 及其生命周期所有者

**文件：**
- Create: `packages/host/local-runtime/src/runtime.ts`
- Create: `packages/host/local-runtime/src/bin.ts`
- Create: `packages/host/local-runtime/src/idle-lifecycle.ts`
- 新建：`packages/host/local-runtime/src/harness-home-provider.ts`
- Create: `packages/host/local-runtime/tests/runtime-composition.e2e.ts`
- Create: `packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts`
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/base/cordis.patch.yml`
- Modify: `packages/host/local-runtime/package.json`
- 修改：任务 1 所列的每个 production consumer 及其 resolver manifest/config patch

**接口：**
- Consumes: Tasks 1-4 的所有原语，以及现有 `boot()`、WebServer、API proxy、Web frontend、session、settings、workspace、storage 和 credential-reference providers。
- Produces: `startRuntime(config)`、`RuntimeHandle`、`attachClient`、`releaseClient`、`beginAgentWork`、`endAgentWork`、`acquireBackgroundLease` 和 `releaseBackgroundLease`。

- [ ] **Step 1: 编写失败的组合和生命周期测试**

从干净临时根启动规范组合。要求恰好一个 `127.0.0.1` listener 且使用 OS 分配端口，所有可写 provider 根都在 `HARNESS_HOME` 下，且只有健康检查成功后发布端点记录。向 base 和 Web 组合注入同一个 `HarnessHomeProvider`/配置映射，并断言任务 1 的每个 consumer 都得到其已解析路径；若挂载 `resolveDshHome`、`dshHomePath` 或旧 `DSH_HOME` 回退 writer 则失败。附加两个测试客户端，通过一个 API carrier 创建状态并从另一个观察它。要求只有最后一个客户端、活动工作 token 和后台租约都释放后才空闲关闭；要求活动工作 token 阻止关闭；要求最终 dispose 按端点、锁的顺序清理。

- [ ] **Step 2: 运行聚焦组合测试并观察缺失的 Runtime 所有者**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-composition.e2e.ts packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts
```

预期：FAIL，因为不存在规范组合或生命周期 API。

- [ ] **Step 3: 实现 Runtime 所有的组合和计数 API**

创建一个单一 orchestration entry，并具有以下调用方可见 handle：

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export interface RedactedRuntimeStatus {}
export type RuntimeClientId = Branded<'RuntimeClientId'>
export interface RuntimeAttachment {}
export type SessionId = Branded<'SessionId'>
export interface RuntimeWorkLease {}
export interface BackgroundLease { readonly id: Branded<'BackgroundLeaseId'> }

export interface RuntimeHandle {
  readonly status: () => RedactedRuntimeStatus
  attachClient(client: RuntimeClientId): Promise<RuntimeAttachment>
  releaseClient(client: RuntimeClientId): Promise<void>
  beginAgentWork(session: SessionId): Promise<RuntimeWorkLease>
  acquireBackgroundLease(owner: RuntimeClientId): Promise<BackgroundLease>
  dispose(): Promise<void>
}
```

在 `boot()` 前获取锁，并将 WebServer 配置为 `{ host: '127.0.0.1', port: 0 }`。以注入的 `HarnessHomeProvider`/配置映射替换每个 base/Web 组合和任务 1 每个 consumer 的 `DSH_HOME` 或旧 helper 查询；任何提供方都不得静默回退到旧 writer。只挂载一次现有 Web/API/static frontend 服务，并使其根目录从该 Runtime 所有的提供方解析。只计算真实 attachment、活动工作和显式后台租约；仅在归零时启动可配置 idle timer，按持久化 flush、移除端点记录、释放锁和 dispose Cordis root 的顺序执行。内部 `bin.ts` 从环境读取 `HARNESS_HOME`，并只向 stderr 报告脱敏就绪状态。

- [ ] **Step 4: 运行集成、构建和 invariant 验证**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-composition.e2e.ts packages/host/local-runtime/tests/runtime-lifecycle.e2e.ts packages/session/session-persistence/tests/persistence.spec.ts packages/settings/settings-file/tests/concurrency.spec.ts packages/workspace/workspace/tests/workspace.spec.ts
pnpm run build:lib:host
pnpm run verify-package-invariants
pnpm run verify-cordis-config
```

预期：现有 provider 语义继续通过，而集成测试展示恰好一个所有者和共享已提交状态。

- [ ] **Step 5: 提交 Runtime 进程所有者**

运行：

```powershell
git add packages/host/local-runtime packages/bundle/base packages/bundle/web-app
git diff --cached --check
git commit -m "feat(runtime): compose one shared local Runtime"
```

### 任务 6：添加控制语义、忙碌会话串行化以及源码/构建进程 smoke test

**文件：**
- Create: `packages/host/local-runtime/src/control-service.ts`
- 新建：`packages/host/local-runtime/src/runtime-client.ts`
- Create: `packages/host/local-runtime/tests/control-service.spec.ts`
- 新建：`packages/host/local-runtime/tests/runtime-client.spec.ts`
- Create: `packages/host/local-runtime/tests/runtime-process.compat.spec.ts`
- 新建：`packages/host/local-runtime/tests/runtime-cli-process.e2e.ts`
- 新建：`packages/host/local-runtime/tests/runtime-control.snapshot.ts`
- Modify: `packages/core/session/src/index.ts`
- Modify: `packages/host/local-runtime/src/runtime.ts`
- Modify: `packages/host/local-runtime/src/control-routes.ts`

**接口：**
- Consumes: `RuntimeHandle`、会话服务事件和已认证原生控制路由。
- 产出：脱敏 `status`、租约 `acquire`/`release`、`attach`/`release`、类型化 session-busy 响应，以及由 CLI 和 Web 消费的公共 `RuntimeConnector`/`RuntimeClient`。

- [ ] **Step 1: 编写失败的控制和并发工作测试**

要求针对不存在 Runtime 的原生 status 请求返回 `{ kind: 'not-running' }`，且不创建文件或子进程。测试两个独立 CLI 进程竞争 `RuntimeConnector.connect({ start: true })`：恰好一个启动，两个进程都发现并附加同一个健康 Runtime，且没有应用解析端点文件。测试没有 Runtime 时 `connect({ start: false })` 返回 `RuntimeUnavailableError`，且不写入文件、进程、锁或端点记录。演练每个公开 migration method：CLI 与 authenticated Dashboard query 看到相同的耐久 `LegacyMigrationState`；accept 只执行一次 copy，decline 会持久化，target collision 与 failure 返回脱敏可重试 state，且 retry 只在用户修正后成功并保留两个根目录。演练 `observeActiveWork()` 与 `stopOwnUiWork()`，使 Desktop client 只能观察和停止其自身 UI work。要求 `releaseBackgroundLease` 保留附加客户端和活动工作。通过 `--daemon` 和 `--background` 两次获取命名的耐久 Web 租约，断言两个别名为一个 `HARNESS_HOME` 寻址同一租约；随后由较晚启动的 CLI 进程释放它；重复 stop 安全、`status` 幂等，并且附加终端仍保持活动。为一个 session 启动第一个写入型 agent 操作，从另一个客户端请求第二个，并要求 `{ kind: 'session-busy', sessionId, options: ['observe', 'new-session', 'wait'] }`；断言两个操作都不会创建重复 session record。分别用 `node --import tsx/esm` 和 `lib/` 运行内部 binary，以证明端点可被发现并释放。

- [ ] **Step 2: 运行控制和兼容测试并确认其失败**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts packages/host/local-runtime/tests/runtime-cli-process.e2e.ts
```

预期：FAIL，因为不存在 status/control API 或并发 session 准入策略。

- [ ] **Step 3: 实现类型化控制结果和 session 准入**

定义 `RuntimeControlResult` 为包含 `not-running`、`version-mismatch`、`owned-by-live-runtime`、`session-busy` 和 `unavailable` 的 discriminated union。任何分支都不得返回端点令牌或原始文件系统错误。按带品牌的 session id 串行化写入型 agent 准入；读取和观察保持并发。令 status probe 只读取和验证已有端点记录，绝不调用 `startRuntime`。将后台别名路由到同一租约对象，使 release 永不杀死任务或其他客户端。

从 `src/index.ts` 导出以下精确、由基础层拥有的 Node API。CLI/Web 和 Electron Main 不作改写地消费它；仅 connector 拥有竞态安全的启动/发现，私有令牌绝不出现于应用可见值：

```ts
import type { Branded } from '@harness-desktop/dsh-brand'

export type RuntimeId = Branded<'RuntimeId'>
export type RuntimeClientId = Branded<'RuntimeClientId'>
export type SessionId = Branded<'SessionId'>
export type BackgroundLeaseId = Branded<'BackgroundLeaseId'>
export type BrowserHandoffId = Branded<'BrowserHandoffId'>
export type ApprovalId = Branded<'ApprovalId'>
export type ActiveWorkId = Branded<'ActiveWorkId'>
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>
export type DashboardOrigin = Branded<'DashboardOrigin'>

export interface TerminalOpenRequest {
  readonly workspace: string
  readonly initialTask?: string
  readonly sessionId?: SessionId
}
export type TerminalProtocolEvent =
  | { readonly kind: 'session-opened'; readonly sessionId: SessionId }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'tool-activity'; readonly title: string }
  | { readonly kind: 'approval-requested'; readonly approvalId: ApprovalId; readonly prompt: string }
  | { readonly kind: 'model-changed'; readonly model: string }
  | { readonly kind: 'permission-changed'; readonly permission: string }
  | { readonly kind: 'diagnostic'; readonly diagnostic: RedactedRuntimeDiagnostic }
export type TerminalInput =
  | { readonly kind: 'task'; readonly text: string }
  | { readonly kind: 'approval'; readonly approvalId: ApprovalId; readonly decision: 'approve' | 'reject' }
export type TerminalControlCommand =
  | { readonly command: 'model'; readonly model?: string }
  | { readonly command: 'permissions'; readonly permission?: string }
  | { readonly command: 'plan' }
  | { readonly command: 'compact' }
  | { readonly command: 'resume'; readonly sessionId?: SessionId }
  | { readonly command: 'diff' }
  | { readonly command: 'terminal' }
  | { readonly command: 'doctor' }
  | { readonly command: 'exit' }
export interface TerminalConnection {
  events(): AsyncIterable<TerminalProtocolEvent>
  submit(input: TerminalInput): Promise<void>
  runControl(command: TerminalControlCommand): Promise<void>
  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  close(): Promise<void>
}
export interface BrowserHandoff {
  readonly id: BrowserHandoffId
  readonly expiresAt: number
}
export interface DashboardNavigation {
  readonly origin: DashboardOrigin
  readonly handoff: BrowserHandoff
}
export interface DashboardAttachment {
  createBrowserHandoff(): Promise<DashboardNavigation>
  close(): Promise<void>
}
export interface BrowserHandoffTransport {
  open(navigation: DashboardNavigation): Promise<void>
}
export interface RuntimeLease { readonly id: BackgroundLeaseId }
export interface RuntimeStatus {}
export interface RuntimeLeaseStatus { readonly id: BackgroundLeaseId; readonly state: 'present' | 'absent' }
export type RuntimeRecoveryCode =
  | 'runtime-unavailable'
  | 'runtime-version-mismatch'
  | 'runtime-start-failed'
  | 'dashboard-unavailable'
export interface RedactedRuntimeDiagnostic {
  readonly code: RuntimeRecoveryCode
  readonly subject: 'Runtime' | 'Dashboard'
  readonly message: string
  readonly correction: string
  readonly diagnosticId: RuntimeDiagnosticId
}
export type LegacyMigrationState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'decision-required'; readonly sourceLabel: 'DSH_HOME'; readonly retryable: boolean }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly copied: readonly string[] }
  | { readonly kind: 'target-not-empty'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
  | { readonly kind: 'failed'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
export interface ActiveWorkStatus {
  readonly ownUiWork: readonly ActiveWorkId[]
}
export type OwnUiWorkStopResult =
  | { readonly kind: 'stopped'; readonly work: readonly ActiveWorkId[] }
  | { readonly kind: 'none-active' }
  | { readonly kind: 'failed'; readonly diagnostic: RedactedRuntimeDiagnostic }

export interface RuntimeClient {
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  attachDashboard(): Promise<DashboardAttachment>
  acquireBackgroundLease(): Promise<RuntimeLease>
  status(): Promise<RuntimeStatus>
  releaseBackgroundLease(): Promise<RuntimeLeaseStatus>
  getLegacyMigration(): Promise<LegacyMigrationState>
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  declineLegacyMigration(): Promise<LegacyMigrationState>
  retryLegacyMigration(): Promise<LegacyMigrationState>
  observeActiveWork(): Promise<ActiveWorkStatus>
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
  close(): Promise<void>
}

export interface RuntimeConnector {
  connect(options: { readonly start: boolean }): Promise<RuntimeClient>
}

export declare class RuntimeUnavailableError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeBusyError extends Error { readonly sessionId: SessionId; readonly diagnosticId: RuntimeDiagnosticId }
export declare class RuntimeProtocolError extends Error { readonly diagnosticId: RuntimeDiagnosticId }
export declare function normalizeRecoveryDiagnostic(error: unknown): RedactedRuntimeDiagnostic
```

`RuntimeClient.close()` 只释放其客户端附加。每个 `TerminalConnection` 和 `DashboardAttachment` 分别通过 `close()` 释放自身附加；客户端先调用 `attachDashboard()`，再调用该附加上的 `createBrowserHandoff()`，并在浏览器或 Electron Main 不再需要后关闭它。`BrowserHandoffTransport` 由启动器拥有：它以已验证的仅所有者 POSIX mode 或当前用户 Windows ACL 创建一次性 bootstrap 目录和 document，拒绝权限更宽的位置，并写入 `handoff.id` hidden form field。其 file URL、launch arguments 和日志干净，但 HTML body 含该 hidden field。它打开 document 并将精确一次的幂等 cleanup timer 绑定到 `expiresAt`；dispatch failure、exchange success 或 failure、expiry 和 never-dispatched document 都用该 cleanup 精确一次删除所属 document 和目录。该文档从其不透明 file origin 将 field 自动 POST 到 `${origin}/_harness/handoff`；Runtime 只认证被原子消费且未过期的正文值、不发送 CORS permission、设置会话 cookie，并以干净 `303` 重定向到 `${origin}/`。因此 handoff 不存在于任何 navigation URL、query、URL hash、header、referrer、history entry、storage value、Renderer IPC、日志、诊断或 capture 中；只有 verifier 可检查原始 POST body，且在记录前会脱敏。交换后的凭据只允许出现在 Runtime `Set-Cookie`、浏览器 `Cookie` 请求头和浏览器 HttpOnly cookie jar 中，绝不进入 Dashboard JavaScript、Renderer IPC、脚本存储、应用持久化、日志、诊断、快照或会话记录。`normalizeRecoveryDiagnostic()` 是所有调用方唯一的无秘密 normalizer。`RedactedRuntimeDiagnostic` 接口是 Desktop 导入并投影到 Renderer IPC 的精确 Foundation 类型；它绝不包含端点记录字段、令牌、handoff、cookie、凭据值或绝对 home 路径。浏览器 handoff、无启动 status、迁移动作、active-work 操作和 Web 租约操作使用已认证 wire 请求，所有公共成功值或错误序列化均脱敏。定义并测试以下精确控制 wire 请求联合；已认证端点已将 `web` 限定到其唯一 `HARNESS_HOME`，请求和响应均不包含端点记录字段：

```ts
export type RuntimeControlRequest =
  | { readonly operation: 'status' }
  | { readonly operation: 'acquire-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'release-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }
  | { readonly operation: 'observe-active-work' }
  | { readonly operation: 'stop-own-ui-work' }

export type DashboardControlRequest =
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }
```

Runtime 将迁移决定与脱敏结果持久化在 `HARNESS_HOME` 下；Node client 与 authenticated Dashboard control wire 都在重连后重放同一状态。二者均不暴露旧根目录路径或复制的秘密材料。Web 租约在每个 `HARNESS_HOME` 中有持久 ID `web`；acquire、release 和 status 跨进程工作。`status` 与获取操作对该命名租约幂等；租约已不存在时，释放以 `state: 'absent'` 成功。

- [ ] **Step 4: 运行源码、构建和无密钥行为验证**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/control-service.spec.ts packages/host/local-runtime/tests/runtime-client.spec.ts packages/host/local-runtime/tests/runtime-process.compat.spec.ts packages/host/local-runtime/tests/runtime-cli-process.e2e.ts
pnpm run build:lib:host
pnpm exec vitest run --config vitest.snapshot.config.ts packages/host/local-runtime/tests/runtime-control.snapshot.ts
pnpm run check:node-compat
```

预期：两种进程平面通过；两个独立 CLI 进程共享一个 Runtime 和一个耐久命名 Web 租约；新的真实可运行无密钥快照展示脱敏状态和忙碌恢复，不含令牌、秘密或绝对数据路径。

- [ ] **Step 5: 提交控制和进程兼容层**

运行：

```powershell
git add packages/host/local-runtime packages/core/session
git diff --cached --check
git commit -m "feat(runtime): expose safe local Runtime control"
```

### 任务 7：完成包验收检查并交付既有拓扑决策

**文件：**
- 修改：`.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.md`（此工作流交付时移动到 `implemented/`）
- 修改：`.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.zh.md`（此工作流交付时移动到 `implemented/`）
- 修改：`.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.i18n.yaml`（与配对文档一起移动）
- Modify: `docs/architecture.md`
- Modify: `docs/subsystems/README.md`
- Modify: `docs/subsystems/persistence.md`
- Modify: `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.zh.md`

**接口：**
- Consumes: 已发布 Runtime 公共类型、既有 proposed product-topology Agent Note 和已接受的产品设计。
- Produces: 一个简洁的当前状态包契约、既有拓扑 Agent Note 的状态迁移（它已拥有替代方案和理由），以及指向所有子系统的架构链接。

- [ ] **Step 1: 编写失败的文档所有权检查**

添加聚焦 `runtime-docs.spec.ts`，读取包 README 和 architecture/subsystem 页面。要求 README 将 Runtime 说明为唯一持久化所有者、列出不泄露保证并链接设计。要求既有 topology note 作为配对记录移动到 `implemented/`、保留其替代方案和后果、以已交付验证取代未来时工作，并链接回 Runtime 包而非复制拓扑理由。

- [ ] **Step 2: 运行聚焦文档测试和格式门禁**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/runtime-docs.spec.ts
pnpm run verify-agent-note-format
```

预期：FAIL，直到所有者文档存在且批准的拓扑记录可带着已交付证据晋升。

- [ ] **Step 3: 只编写当前契约并记录所有双语配对**

在包 README 中记录正在运行的 Runtime、其配置、类型化错误类别和唯一写入者/回环/令牌规则。既有 [Harness Desktop 产品拓扑 Agent Note](../../../.agents/notes/proposed/architecture/2026-08-15-harness-desktop-product-topology.md) 是拓扑理由和已拒绝 private-child 模型的唯一归宿。此工作流交付时，将该配对记录及其 i18n record 移到 `implemented/`、更新为当前状态验证，并保留其互不重叠的替代方案和后果。通过链接到这些所有者更新 `architecture.md` 和相关 subsystem 页面，而不是重述其测试清单。用匹配的标题、列表、链接和代码围栏写中文对应文档，然后创建所有包 `.i18n.yaml` 记录。

- [ ] **Step 4: 运行聚焦文档和包门禁**

运行：

```powershell
pnpm run verify-translation-pairing --write packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md
pnpm run verify-translation-pairing packages/host/local-runtime/README.md .agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md
pnpm run verify-agent-note-format
pnpm run verify-md-links
pnpm run doc-sync
pnpm run lint
git diff --check
```

预期：所有 Runtime 文档具有一致配对，最终包通过仓库相关文档和静态门禁。

- [ ] **Step 5: 提交 Runtime 文档和验收证据**

运行：

```powershell
git add .agents/notes/implemented docs packages/host/local-runtime
git diff --cached --check
git commit -m "docs(runtime): record shared local Runtime ownership"
```
