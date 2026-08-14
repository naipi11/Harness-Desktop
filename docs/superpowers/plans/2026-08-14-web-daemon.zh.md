# Web 守护启动实施计划

[English](2026-08-14-web-daemon.md) | 中文

> **面向代理执行者：** 必须使用子技能：按任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 增加跨平台的 `dsh web --daemon` 和 `dsh web --background` 等价别名，使现有 Web 配置在调用终端之外运行。

**架构：** 仅在选中 Web 配置后，CLI 辅助模块识别别名；它在重新执行 CLI 前移除别名，并以私有文件输出启动一个脱离终端的 Node 子进程。子进程沿用现有 Web 配置启动路径；操作系统确认创建后，父进程输出 PID 与日志路径并退出。

**技术栈：** Node.js 22 的子进程和文件系统 API、TypeScript、Commander、Vitest、现有的构建后 CLI 冒烟测试基础设施，以及成对 Markdown 文档。

## 全局约束

- 将 `--daemon` 和 `--background` 作为仅适用于 Web 的等价别名；同一次调用同时出现时只创建一个子进程。
- 子进程必须保持前台 Web 的启动、主机、端口、信任、就绪和关闭路径不变。
- `--help` 优先：移除脱离别名、打印帮助，且不创建子进程。
- 使用脱离终端的子进程、忽略 stdin、在 `$DSH_HOME/logs/` 下保存私有输出、设置 `windowsHide: true`，并在其 `spawn` 事件后调用 `unref()`。
- 父进程成功只表示子进程已创建；普通服务器启动失败仍写入私有日志。
- 不增加依赖、远程绑定、就绪轮询、服务管理器命令或登录自启动行为。
- 保持 Node 支持范围为 `^22.19.0 || >=24.0.0`、严格 ESM TypeScript、成对文档、已实施 Agent Note、聚焦单元覆盖、构建后 CLI 冒烟测试和无密钥快照。

---

### 任务 1：添加可测试的脱离启动辅助模块

**文件：**

- 创建：`apps/cli/src/web-daemon.ts`
- 创建：`apps/cli/tests/web-daemon.spec.ts`

**接口：**

- 产出：`resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean }`。
- 产出：`launchWebDaemon(input: { entry: string; patches: readonly string[]; args: readonly string[] }): Promise<{ pid: number; logPath: string }>`。
- 产出：可注入的文件系统和子进程适配器；生产实现通过 `resolveDshHome()` 解析主目录。
- 由任务 2 使用：仅在 `apps/cli/src/bin.ts` 中的 `profile === 'web'` 分支使用。

- [ ] **步骤 1：先编写失败的单元测试**

```ts
expect(resolveWebDaemonInvocation(['--port', '0', '--daemon', '--background']))
  .toEqual({ args: ['--port', '0'], detached: true })
expect(resolveWebDaemonInvocation(['--daemon', '--help']))
  .toEqual({ args: ['--help'], detached: false })

const launched = launchWebDaemon({ entry: '/dsh/bin.js', patches: ['overlay.yml'], args: ['--port', '0'] }, adapters)
child.emit('spawn')
await expect(launched).resolves.toMatchObject({ pid: 417 })
expect(adapters.spawn).toHaveBeenCalledWith(process.execPath, ['/dsh/bin.js', '--profile', 'web', '--patch', 'overlay.yml', '--port', '0'], expect.objectContaining({ detached: true, windowsHide: true, stdio: ['ignore', 9, 9] }))
```

- [ ] **步骤 2：确认实现前测试失败**

运行：`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts`

预期：失败，因为 `../src/web-daemon.ts` 尚不存在。

- [ ] **步骤 3：实现辅助模块**

```ts
export function resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean } {
  const requested = args.some(arg => arg === '--daemon' || arg === '--background')
  const cleaned = args.filter(arg => arg !== '--daemon' && arg !== '--background')
  return { args: cleaned, detached: requested && !cleaned.some(arg => arg === '-h' || arg === '--help') }
}
```

以仅所有者权限创建 `$DSH_HOME/logs/`，通过 `mkdtempSync` 创建唯一子目录，以仅所有者模式独占打开 `server.log`，并将同一个描述符交给子进程的 stdout 和 stderr。重建子进程 argv：`['--profile', 'web', ...patches.flatMap(path => ['--patch', path]), ...args]`。等待 `spawn` 或 `error`，在任一路径关闭父进程描述符，仅在 `spawn` 后调用 `unref()`，并抛出明确指出日志或 spawn 操作失败的错误。

- [ ] **步骤 4：运行聚焦验证**

运行：`pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts && pnpm exec tsc -p apps/cli/tsconfig.json --noEmit`

预期：通过；覆盖别名规范化、帮助优先级、重建 argv、脱离选项、描述符归属和启动错误。

- [ ] **步骤 5：提交任务 1**

```sh
git add apps/cli/src/web-daemon.ts apps/cli/tests/web-daemon.spec.ts
git commit -m "feat(cli): launch web server in background"
```

### 任务 2：分发 Web 别名并测试可见行为

**文件：**

- 修改：`apps/cli/src/bin.ts`
- 修改：`packages/bundle/web-app/src/startup.ts`
- 修改：`packages/bundle/web-app/tests/startup.spec.ts`
- 创建：`apps/cli/tests/web-daemon.compat.spec.ts`
- 创建：`apps/cli/tests/web-daemon.snapshot.ts`

**接口：**

- 使用：任务 1 的 `resolveWebDaemonInvocation()` 和 `launchWebDaemon()`。
- 产出：带清理后参数的前台 `runProfile()`，或父进程 stdout `dsh web: started detached process <pid>; log: <path>`。
- 产出：帮助文本同时命名两个别名，但不把它们加入 `WebStartupValues`。
- 使用：`DSH_REQUIRE_BUILT_CLI_SMOKE` 与子进程 URL 行 `dsh web: http://127.0.0.1:<port>`。

- [ ] **步骤 1：编写失败的真实进程与帮助测试**

```ts
const parent = await runBuiltBin(['web', '--daemon', '--port', '0'], { DSH_HOME: home })
expect(parent.code).toBe(0)
const [, pid, logPath] = parent.stdout.match(/^dsh web: started detached process (\d+); log: (.+)\n$/u) ?? []
await waitForLogLine(logPath, /dsh web: http:\/\/127\.0\.0\.1:\d+/u)
await expect(fetch(urlFromLog(logPath))).resolves.toMatchObject({ ok: true })
await stopDetachedProcess(Number(pid))
```

兼容性测试在 `DSH_REQUIRE_BUILT_CLI_SMOKE !== '1'` 时跳过，并要求存在 `apps/cli/lib/bin.js` 与 `apps/web/dist/index.html`。它使用隔离的临时 `DSH_HOME`，轮询子进程日志，清理后移除该主目录；Windows 使用 `taskkill /PID <pid> /T /F`，其他平台发送 `SIGTERM` 后等待。

快照从 `DSH_EXAMPLE_MODE` 运行源代码或构建后的 CLI，参数为 `web --daemon --help`，并快照 `{ code: 0, stderr: '', stdout }`。它断言两个别名都出现，且 PID/日志行不出现。

- [ ] **步骤 2：确认测试失败**

运行：`pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts --maxWorkers=1 --no-file-parallelism`

预期：失败，因为 CLI 尚未分发辅助模块、帮助缺少两个别名，也没有 PID/日志行。

- [ ] **步骤 3：接入分发和帮助**

```ts
const web = invocation.profile === 'web' ? resolveWebDaemonInvocation(invocation.args) : undefined
if (web?.detached) {
  const launched = await launchWebDaemon({ entry: fileURLToPath(import.meta.url), patches: invocation.patches, args: web.args })
  process.stdout.write(`dsh web: started detached process \${String(launched.pid)}; log: \${launched.logPath}\n`)
  break
}
await runProfile({ environment: loadLayeredEnv('dsh'), profile: invocation.profile, patchFiles: invocation.patches, args: web?.args ?? invocation.args })
```

在 Web 帮助示例中加入两个别名。不要把它们放入 `WebStartupValues`，因为它们在 Web 行存在前就改变启动器进程的生命周期。

- [ ] **步骤 4：构建并运行行为覆盖**

运行：`pnpm run build && pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.spec.ts && DSH_REQUIRE_BUILT_CLI_SMOKE=1 pnpm exec vitest run apps/cli/tests/web-daemon.compat.spec.ts && DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts`

预期：通过；父进程创建后退出，子进程提供构建后的 Web UI，帮助展示两个别名，面向用户的帮助文本保持稳定。

- [ ] **步骤 5：提交任务 2**

```sh
git add apps/cli/src/bin.ts packages/bundle/web-app/src/startup.ts packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-daemon.snapshot.ts
git commit -m "feat(cli): support detached web launch"
```

### 任务 3：记录用户操作和已交付的决策

**文件：**

- 修改：`apps/cli/README.md`、`apps/cli/README.zh.md` 和 `apps/cli/README.i18n.yaml`
- 修改：`apps/cli/reference/README.md`、`apps/cli/reference/README.zh.md` 和 `apps/cli/reference/README.i18n.yaml`
- 修改：`packages/bundle/web-app/README.md`、`packages/bundle/web-app/README.zh.md` 和 `packages/bundle/web-app/README.i18n.yaml`
- 创建：`.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`、`.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md` 和 `.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml`

**接口：**

- 说明：别名、父进程成功语义、PID/日志输出、私有日志、前台兼容性和子进程信号处置。
- 说明：CLI 移除别名后，`web-startup` 仍负责主机、端口、trusted-host 和帮助。
- 记录：包含 Problem、Decision、Alternatives considered 和 Consequences 的已实施功能 Agent Note。

- [ ] **步骤 1：确认新决策记录尚不存在**

运行：`pnpm run verify-translation-pairing .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`

预期：失败，因为 Agent Note 成对文件尚不存在。

- [ ] **步骤 2：编写成对操作文档和记录**

在 CLI 入口和 Web 别名参考中记录 `dsh web --daemon` 与 `dsh web --background`。说明父进程成功报告的是子进程创建而非就绪，子进程 URL 和启动失败位于私有日志，`--help` 不创建子进程，返回 PID 使用现有的子进程处置。将别名描述为 CLI 在 Web 提供方接收清理后参数前消耗的唯一 Web 进程生命周期控制。

以如下确切章节顺序创建已实施 Agent Note：

```markdown
# Agent Note: Web daemon launch stays in the CLI

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences
```

记录拒绝仅脱离终端而不重新执行，以及拒绝 `status`/`stop` 管理器。说明私有日志是诊断子进程启动失败的必要条件。

- [ ] **步骤 3：重新记录配对信息并运行文档检查**

运行：`pnpm run verify-translation-pairing --write apps/cli/README.md apps/cli/reference/README.md packages/bundle/web-app/README.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md && pnpm run doc-sync && git diff --check`

预期：通过；所有更新的成对文档具有匹配结构和当前哈希，Agent Note 格式有效，Markdown 检查通过。

- [ ] **步骤 4：提交任务 3**

```sh
git add apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/cli/reference/README.md apps/cli/reference/README.zh.md apps/cli/reference/README.i18n.yaml packages/bundle/web-app/README.md packages/bundle/web-app/README.zh.md packages/bundle/web-app/README.i18n.yaml .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml
git commit -m "docs: document detached web launch"
```

## 计划自检

- 规格覆盖：任务 1 覆盖规范化、脱离 spawn、私有日志、子进程 argv 和即时设置失败。任务 2 覆盖仅 Web 分发、帮助优先级、子进程启动路径不变、真实构建服务器连续性和无密钥可见输出快照。任务 3 覆盖操作文档、配对记录和必需的功能决策。
- 占位符扫描：每项任务均列出文件、接口、测试、预期结果、实现行为和提交。
- 类型一致性：任务 1 定义 `resolveWebDaemonInvocation()` 与 `launchWebDaemon()`；任务 2 使用相同的名称和字段。
