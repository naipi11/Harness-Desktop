# `harness` CLI（命令行界面）行为参考

[English](README.md) | 中文

本参考定义 `harness` 与 `dsh` 共享的公开产品语法。[`src/args.ts`](../src/args.ts) 只解析一次 argv，[`src/main.ts`](../src/main.ts) 将得到的模式分派到显式的 Runtime、浏览器和终端依赖。

## 语法

| 模式 | 语法 | 结果 |
|---|---|---|
| 交互 | `harness [task]` | 打开终端，并可接纳一个初始任务。 |
| Run | `harness run <task> [--json]` | 通过终端协议运行且仅运行一个任务。 |
| Web | `harness web [options]` | 打开、保留、检查或释放 Runtime 的 Dashboard。 |
| Desktop | `harness desktop` | 选择不带参数的 Desktop 模式。 |

`dsh` 接受相同语法，并在帮助与纠正提示中报告自己的命令名。`-h`/`--help` 与 `-V`/`--version` 是产品选项。未知选项和属于其他模式的参数都是用法错误。

公开解析器没有 profile、插件管理、headless profile、patch 或配置 dump 模式。尤其是，任何形式的 `--profile` 都会在分派前被拒绝。原 profile 时代的命令不是兼容语法。

### 交互

不带参数时会打开交互式终端。一个位置参数会作为初始任务接纳。超过一个位置参数，或任何不属于该模式的产品选项都会被拒绝。运行命令时所在的目录会作为 workspace 发送给共享 Runtime。

### Run

`run` 要求且仅要求一个任务。`--json` 最多出现一次，并选择以换行分隔的协议输出；不带该选项时，CLI 会渲染终端事件流。操作结算后，CLI 会关闭自己的终端连接和 Runtime 基础连接。

### Web

```sh
harness web
harness web --open
harness web --no-open
harness web --background --no-open
harness web --status
harness web --stop
```

打开操作会启动或连接共享的本地 Runtime。默认启用浏览器调度；`--open` 显式表达该默认值，`--no-open` 则禁止调度。`--daemon` 与 `--background` 是请求由 Runtime 持有的具名 `web` lease 的等价写法，可以与任一浏览器选择组合。它们不会创建分离的逐命令 Web 子进程、PID 记录或子进程日志。

调起浏览器时，Runtime 会签发一次性 handoff，并返回不含凭据的回环 Dashboard origin 及其过期时间。CLI 只会把 handoff 写入仅当前用户可访问的临时 HTML 文档的 POST 正文。调度的本地文件 URL 既不包含 handoff，也不包含 Runtime access token。

Runtime 客户端 API 不向 CLI 暴露 handoff 交换完成状态。CLI 仍在运行时，调度失败会立即删除文档，handoff 过期则通过同一个记忆化操作删除文档。如果 CLI 在过期前自然退出，所有权会移交给通过纯 Node 启动的分离辅助进程；该进程只接收文档路径和过期时间，不接收继承的 Node loader/eval 参数、handoff、access token 或继承环境，并在原过期时间删除文档。

`--status` 只连接已有 Runtime，并输出其 Runtime 标识、Dashboard origin 与具名 Web lease 状态。Runtime 不存在时会返回非零状态，且不会创建 `$HARNESS_HOME`。`--stop` 同样要求已有 Runtime，并幂等地仅释放具名 Web lease。它不会终止 Runtime、关闭其他客户端或取消活动工作。`--status` 和 `--stop` 不能与后台 lease 选项组合，并且绝不会打开浏览器。

### Desktop

`desktop` 不接受参数，并选择 Desktop 产品模式。它不会创建终端或 Web Runtime 连接。

## Runtime 行为

CLI 通过 `HARNESS_HOME` 解析本地 Runtime。交互、run 与 Web 调用会作为客户端连接；Runtime 持有其 endpoint、会话、后台 lease 与活动操作。释放一条 CLI 连接不会让它获得无关客户端或工作的所有权。

产品语法失败会以 2 退出，并提供纠正语法行。无法找到或连接所需 Runtime 的 Web 操作使用 Runtime 不可用退出路径；其他本地 Web 失败使用通用本地失败路径。诊断会经过归一化，绝不回显 handoff、endpoint token 或原始私有原因。

## 源码与构建后执行

仓库脚本通过 `node --import tsx/esm` 启动源码，并为 Runtime 进程启动保留该启动器。安装后的命令通过纯 Node 运行构建后的 bin。分离的浏览器清理辅助进程是独立 `.mjs` 文件，并且有意不继承源码 loader 参数或 eval 代码。

```sh
pnpm run build
pnpm harness run "check the workspace" --json
node apps/cli/lib/bin.js run "check the workspace" --json
```
