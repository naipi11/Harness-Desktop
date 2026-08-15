# `@deepseek-ai/dsh`

[English](README.md) | 中文

`harness` 是 Harness Desktop 中用于启动 profile 的主命令；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。`dsh` 保留为兼容命令名。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/main.ts`](src/main.ts) 分派两个命令名，每个入口只加载选中的命令名。无效命令、来自其他模式的选项、配置错误和启动失败都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `harness --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 的指定 profile。 |
| `harness --profile headless "job"` | 运行一个全新的持久化会话，打印最终答案并退出。 |
| `harness web` | `--profile web` 的别名；`--daemon` 和 `--background` 仅将 Web 放到后台启动。 |
| `harness plugin --profile <name> <pnpm args>` | 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件。 |
| `dsh <args...>` | 兼容别名，保持相同的 profile 和数据行为。 |

运行命令时所在的目录将作为默认 workspace 根目录。`web` 和 `headless` profile 在首次使用时会从随附模板自动初始化；其他任何 profile 都必须通过 `harness plugin` 创建。

`harness web --daemon` 与 `harness web --background` 是等价且仅用于 Web 的别名。父进程会输出子进程 PID 和私有日志路径，然后退出；成功只表示已创建子进程，不表示 HTTP 已就绪。调用方使用平台进程工具管理该 PID：在 POSIX 上，`SIGTERM` 会进入现有的 profile 优雅关闭流程；在 Windows 上，`taskkill /F` 会强制终止，不能证明已优雅 dispose。子进程会把 URL 和启动失败写入私有日志，`--help` 不会创建子进程。不带这些别名的 `harness web` 保持前台行为；操作细节见 [CLI（命令行界面）行为参考](reference/README.md)。

## 应用参数

启动器只解析自身的 flag，并将其后的所有内容交给已启动的 profile；注入该 profile 的任意应用插件都可以解析这份共享的不可变快照（[`dsh-cmdline`](../../packages/boot/cmdline/README.md)）。因此，启动器的 flag 必须写在最前面；启动器无法识别的第一个 token 标志着应用参数的开始：

```sh
harness --profile web --port 8080       # --port belongs to the web app
harness --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
harness --profile headless "run the tests"
harness --profile web --help            # the web app's flags, not the launcher's
harness --help                          # the launcher's own help
```

## Profile

profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest（元数据清单）`dsh.profile` 和其中按顺序排列的 `bundles` 列表；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。

配置树以空根为起点，依次叠加以下配置层：
- `dsh.profile.bundles` 中各组合包的 patch
- profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `--patch` 指定的覆盖层

`dsh.profile.bundles` 中列出的组合包先从 Harness Desktop 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`），再从 profile 自身的 `node_modules` 解析；pnpm 会将树外插件安装到该目录。

使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查组合后的配置树。

层的确切优先级、flag、关闭行为、部署默认值和源码执行方式，以 [CLI（命令行界面）行为参考](reference/README.md)为准。

## 开发

生产运行需要已构建的包与前端产物。请在仓库根目录单独运行 `pnpm run build`，然后使用 `pnpm harness <args...>` 运行 TypeScript 入口并转发所有参数；`pnpm dsh <args...>` 保持兼容。模块解析约定以[源码执行参考](reference/README.md#source-execution)为准。
