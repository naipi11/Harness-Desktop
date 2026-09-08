# Agent Note: Desktop 依赖收集限制清单并发读取

Status: implemented

[English](2026-09-08-desktop-pnpm-manifest-concurrency.md) | 中文

## Problem

Electron Builder 使用 `pnpm list --prod --json --depth Infinity --silent --loglevel=error` 收集生产依赖。在此 Windows 工作区中，pnpm 11.7.0 读取未保存依赖的清单时耗尽文件句柄，并出现 `EMFILE` 错误。其依赖树构建器通过跨工作区项目的无并发限制 `Promise.all` 启动这些读取操作。

## Decision

根目录固定使用 pnpm 11.25.0，其依赖树构建器将未保存依赖的读取限制为四个并发操作。相同的收集命令使用此版本可在同一已安装工作区中成功执行，无需减少依赖深度或更改依赖图。包管理器回归测试要求使用此已验证的精确固定版本；更改版本需要有针对性地重新验证。

## Alternatives considered

自定义收集器或修补 Electron Builder 会增加维护成本，却无法修正失败的 pnpm 操作。减少收集深度可能遗漏传递运行时依赖。提高操作系统限制不能约束工作量，也不是可移植的 Windows 打包修复方案。

## Consequences

贡献者和 CI 工具使用较新的固定包管理器；依赖解析与锁文件保持不变。更改此固定版本时，仍需重新验证实际收集器与隔离的未签名 Windows 安装程序。版本断言保护已知基线，但不能代替产物验证，也不能证明未来 pnpm 版本的正确性。
