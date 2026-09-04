# `@harness-desktop/cli`

[English](README.md) | 中文

`harness` 是 Harness Desktop 的产品客户端。`dsh` 是兼容命令名，使用相同的语法与数据。[`src/args.ts`](src/args.ts) 持有公开命令语法，[`src/main.ts`](src/main.ts) 将两个命令名分派到共享的本地 Runtime。

## 快速开始

```sh
harness
harness "fix the tests"
harness run "fix the tests" --json
harness web
harness web --background --no-open
harness web --status
harness web --stop
harness desktop
harness update
```

## 产品命令

| 命令 | 用途 |
|---|---|
| `harness [task]` | 打开交互式终端，并可提供一个初始任务。 |
| `harness run <task> [--json]` | 运行且仅运行一个任务；`--json` 输出 JSONL 协议记录。 |
| `harness web [options]` | 打开、保留、检查或释放共享 Runtime 的 Dashboard。 |
| `harness desktop` | 选择 Desktop 模式；不接受参数。 |
| `harness update` | 对 npm 安装输出更新命令，或校验并原子切换已配置的独立归档。它不会创建 Runtime 或 Web lease。 |
| `dsh <args...>` | 通过兼容命令名使用相同的产品语法。 |

原公开 profile、插件管理、headless profile、patch 和配置 dump 命令不属于该产品语法。`--profile` 会被显式拒绝。一次性任务使用 `run`，Dashboard 使用 `web`。

## 更新

`harness update` 与 `dsh update` 不接受参数，并且只根据解析后的安装布局选择行为：

| 安装形式 | 行为 |
|---|---|
| npm | 只有解析到 `node_modules/@harness-desktop/cli` 布局时才符合条件。该命令输出 `npm update -g @harness-desktop/cli` 并成功退出，不会运行 npm，也不会加载候选。 |
| 独立归档 | 解析到固定 launcher 根目录下 `payload/current/cli/package/lib/<entry>` 的入口即符合条件。Windows 发行版使用 ZIP；macOS 和 Linux 发行版使用 tar.gz 以保留可执行权限。每个发行 bundle 都嵌入经过审计的公开信任、精确的候选源，以及按当前版本索引的回滚源。 |
| 源码或其他布局 | 该安装不受支持；命令向 stderr 输出 `CLI update failed.`，并以 `1` 退出。 |

源码树不提供生产信任配置或发布源。独立 bundle 缺少嵌入的公开策略或该策略无效时，`update` 会报告 `unconfigured-update-source`，不执行候选 I/O 或文件系统变更，并以 `1` 退出。已校验候选的版本不高于当前版本时，会以代码 `version-not-newer` 输出 `No update available.` 并以 `0` 退出。

嵌入公开策略后，`update` 会使用共享签名 manifest 策略，为当前主机选择更新的 stable 归档：Windows 使用 ZIP，macOS 和 Linux 使用 tar.gz；并为精确的已安装版本、当前平台与架构校验回滚 manifest。该命令会先校验两个 manifest 与已配置的精确 HTTPS 源，然后下载候选并校验其归档摘要、完整成员集合及可执行路径，再解压出私有 `.harness-candidate-<uuid>` 目录。固定 launcher、恢复入口、公开策略、锁及阶段 journal 均位于可替换 `payload/current` 目录树之外。每次 payload rename 前，updater 都会同步私有临时 journal 文件，以原子操作发布该文件，并在平台支持时同步其父目录。当前 payload 只会移动到确定性的 `payload/retained`；后续 launcher 会在任一未完成阶段后保守恢复该目录，并拒绝损坏、逃逸、链接形态或有歧义的恢复路径。

健康的候选会成为 `payload/current`。保留 payload 只会在清理成功后删除；清理失败会保留候选和确定性的回滚 payload，并报告 `applied-with-cleanup-failure`。健康检查失败时，事务会移开候选、恢复保留 payload，并且仅在清理成功后报告 `rolled-back`。候选捆绑的 Node 与 `cli/package/lib/bin.js --help` 进程树构成健康生命周期单位：成功要求 leader 退出且没有存活后代，失败则会在回滚前终止并等待整棵进程树。Windows 上，外部系统 PowerShell 工作器会接管精确锁身份，在 update 命令退出后执行带 journal 的 payload 切换，并应用相同的已捕获进程树规则；`restart-scheduled` 不会启动新的交互 CLI。精确锁持有者已终止或到达有界过期时间后，系统可以执行已校验的恢复；损坏的锁会拒绝启动。恢复失败时会报告 `transaction-failed`，不会声称已经回滚。该事务绝不会读取、创建或修改 `HARNESS_HOME`，也不会创建 Runtime 或 Web lease。

当前独立更新结果如下：

| 结果 | 可见输出 | 退出码 |
|---|---|---|
| `up-to-date`（`version-not-newer`） | 向 stdout 输出 `No update available.` | `0` |
| `applied` | 向 stdout 输出 `CLI update applied.` | `0` |
| `applied-with-cleanup-failure` | 向 stderr 输出 `CLI update applied, but cleanup failed.` | `1` |
| `restart-scheduled` | 向 stdout 输出 `CLI update scheduled; it completes after this command exits.` | `0` |
| `rolled-back` | 向 stderr 输出 `CLI update rolled back.` | `1` |
| `failed`（`candidate-rejected`、`transaction-failed`、`unconfigured-update-source` 或 `unsupported-installation`） | 缺少策略时输出 `CLI update unavailable [unconfigured-update-source]. Install a current standalone release.`；否则向 stderr 输出 `CLI update failed.` | `1` |

打包平台与原生 CI 证据范围由根目录的[发布产物矩阵](../../README.md#desktop-app)统一说明。通过本地检查不会配置生产更新信任，也不会授权签名、公证、发布、上传或创建 GitHub Release。

## Profiles

profile 记录仍是供嵌入方与测试 fixture（测试前置数据）使用的旧版／内部 app-boot 格式。共享产品 Runtime 不会加载它们。本标题用于保持现有文档链接有效，并不恢复公开 profile 命令。

## 共享 Runtime 与 Web

交互、run 和 Web 模式会连接通过 `HARNESS_HOME` 选定的同一个本地 Runtime；运行命令时所在的目录是终端 workspace。关闭 CLI 连接不会终止无关客户端或活动工作。

`harness web` 会启动或连接 Runtime，并默认打开 Dashboard。`--no-open` 禁止调起浏览器。`--daemon` 与 `--background` 是请求由 Runtime 持有的具名 `web` lease 的等价写法，而不是启动分离的逐命令 Web 子进程。`--status` 在不启动 Runtime 的情况下检查已有 Runtime。`--stop` 会幂等地仅释放具名 Web lease，并保留 Runtime、其他客户端与活动工作。

打开浏览器时会使用仅当前用户可访问的临时 HTML 文档，其 POST 正文包含一次性 handoff；调度的本地文件 URL 既不包含该 handoff，也不包含 Runtime access token。Runtime 客户端 API 不会向 CLI 报告交换完成状态，因此父进程仍在运行时，会在调度失败或 handoff 过期时删除文档。如果 CLI 先退出，它会把路径和现有过期时间（而非凭据）移交给使用纯 Node 启动的分离清理辅助进程。完整命令与生命周期细节见 [CLI（命令行界面）行为参考](reference/README.md)。

## 开发

源码执行保留 `pnpm harness` 使用的 `node --import tsx/esm` 启动器；构建后执行使用 `apps/cli/lib/bin.js`。测试安装路径前，请先构建包、Web 与 Desktop 产物：

```sh
pnpm run build
pnpm harness web --status
node apps/cli/lib/bin.js web --status
```
