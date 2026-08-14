# Agent Note: Web daemon launch stays in the CLI

Status: implemented

[English](2026-08-14-web-daemon-launch.md) | 中文

## Problem

Web 会话需要在交互式启动器返回后继续运行，同时其应用参数、启动行为、进程所有权和诊断输出仍与前台 `dsh web` 启动一致。已退出的父进程无法报告其脱离的子进程后来是否绑定了 HTTP，因此启动失败需要一个由实现持有的诊断位置。

## Decision

CLI 持有仅用于 Web 的 `--daemon` 和 `--background` 别名。它在向 Web profile 传递清理后的参数前消费任一别名，在适用时以相同的源码启动运行时参数重新执行子进程，输出子进程 PID 与私有 `$DSH_HOME/logs/.../server.log` 路径，并在创建子进程后退出。调用方持有返回的 PID，并使用平台进程工具管理它。在 POSIX 上，`SIGTERM` 会进入现有的 profile 优雅关闭流程；在 Windows 上，`taskkill /F` 会强制终止，不能证明已优雅 dispose。

`web-startup` 继续持有 `--host`、`--port`、可重复的 `--trusted-host` 和 `--help`。子进程将 URL 和启动失败写入私有日志。父进程成功只表示已创建子进程，不表示 HTTP 已就绪，`--help` 不会创建子进程。

## Alternatives considered

**不重新执行的终端脱离。** 不采用。脱离后的延续进程需要与原调用相同的可执行文件和源码启动运行时上下文；重新执行既能保留该上下文，也能让父进程在记录子进程身份和日志位置后返回。

**`status` 或 `stop` 服务管理器。** 不采用。它会引入持久的服务状态和第二套生命周期 API，却无法让创建子进程证明已就绪。PID 与私有日志保留直接的所有权和诊断方式；不增加就绪轮询、远程 bind 或登录自启。

## Consequences

前台 `dsh web` 行为不变。后台调用方负责管理返回的 PID，并且必须读取私有日志以获得子进程 URL 或诊断启动失败。启动器不提供自动进程清理、就绪保证、`status` 或 `stop` 命令。

构建后 CLI 冒烟测试会启动并停止两个别名。在 POSIX 上，清理会发送 `SIGTERM` 并进入 profile 的优雅关闭路径。在 Windows 上，清理使用 `taskkill /F`；它只证明已强制终止进程树，不证明已优雅 dispose。
