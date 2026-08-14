# Agent Note: Web daemon launch stays in the CLI

Status: implemented

[English](2026-08-14-web-daemon-launch.md) | 中文

## Problem

Web 会话需要在交互式启动器返回后继续运行，同时其应用参数、启动行为、进程所有权和诊断输出仍与前台 `dsh web` 启动一致。已退出的父进程无法报告其脱离的子进程后来是否绑定了 HTTP，因此启动失败需要一个由实现持有的诊断位置。

## Decision

CLI 持有仅用于 Web 的 `--daemon` 和 `--background` 别名。它在向 Web profile 传递清理后的参数前消费任一别名，在适用时以相同的源码启动运行时参数重新执行子进程，输出子进程 PID 与私有 `$DSH_HOME/logs/.../server.log` 路径，并在创建子进程后退出。返回的 PID 使用现有 child-disposal 清理。

`web-startup` 继续持有 `--host`、`--port`、可重复的 `--trusted-host` 和 `--help`。子进程将 URL 和启动失败写入私有日志。父进程成功只表示已创建子进程，不表示 HTTP 已就绪，`--help` 不会创建子进程。

## Alternatives considered

**不重新执行的终端脱离。** 不采用。脱离后的延续进程需要与原调用相同的可执行文件和源码启动运行时上下文；重新执行既能保留该上下文，也能让父进程在记录子进程身份和日志位置后返回。

**`status` 或 `stop` 服务管理器。** 不采用。它会引入持久的服务状态和第二套生命周期 API，却无法让创建子进程证明已就绪。PID 与私有日志保留直接的所有权和诊断方式；不增加就绪轮询、远程 bind 或登录自启。

## Consequences

前台 `dsh web` 行为不变。后台调用方会得到由现有 disposal 清理的 PID，但必须读取私有日志以获得子进程 URL 或诊断启动失败。该进程没有就绪保证，也没有正常 child disposal 以外的生命周期管理命令。
