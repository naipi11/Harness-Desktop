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
```

## 产品命令

| 命令 | 用途 |
|---|---|
| `harness [task]` | 打开交互式终端，并可提供一个初始任务。 |
| `harness run <task> [--json]` | 运行且仅运行一个任务；`--json` 输出 JSONL 协议记录。 |
| `harness web [options]` | 打开、保留、检查或释放共享 Runtime 的 Dashboard。 |
| `harness desktop` | 选择 Desktop 模式；不接受参数。 |
| `dsh <args...>` | 通过兼容命令名使用相同的产品语法。 |

原公开 profile、插件管理、headless profile、patch 和配置 dump 命令不属于该产品语法。`--profile` 会被显式拒绝。一次性任务使用 `run`，Dashboard 使用 `web`。

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
