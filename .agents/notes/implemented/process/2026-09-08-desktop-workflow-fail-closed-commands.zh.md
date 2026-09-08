# Agent Note: 失败时阻断的 Desktop 工作流命令

Status: implemented

[English](2026-09-08-desktop-workflow-fail-closed-commands.md) | 中文

## 问题

等效的内联命令可能偏离定义发布检查的 package 脚本。多架构循环可能掩盖先前的失败，不受限制的诊断上传也可能泄露已安装应用的内容。[不执行发布的证据决策](2026-08-25-non-publishing-release-candidate-evidence.md)仍负责候选版本隔离；本记录补充命令执行和上传限制，并不取代该决策。

## 决策

[Desktop 工作流](../../../../.github/workflows/desktop-artifacts.yml)按要求的顺序调用规范的 package 命令。适用于 Windows 的步骤使用原生 PowerShell。三项图形检查使用固定的 Linux Xvfb 命令分支，并显式传播原生命令的退出状态；Desktop 更新器测试保留 `--maxWorkers=1`。两种 macOS CLI（命令行界面）架构共享一个构建结果和一个验证结果，每次调用后立即检查退出码。

[配置验证器](../../../../scripts/desktop-release-config.ts)要求精确的命令内容和原生 PowerShell。证据上传仅接受脱敏的证据 JSON、就绪的 manifest（元数据清单）和快照绑定信息。不上传已安装应用的原始错误上下文。

## 考虑过的替代方案

**接受任意等效的内联命令。** 否决，因为命令列表和执行参数可能偏离 package 所拥有的定义。

**保留原始错误上下文或扩大上传列表。** 否决，因为未经脱敏的诊断信息不属于已审查的证据格式。

**在所有运行器上使用 Bash。** 否决，因为 Windows 作业要求原生 PowerShell；固定的 Linux 命令分支保留无头图形检查，同时不改变 Windows 的执行方式。

## 影响

静态检查会拒绝缺失串行执行、Xvfb、逐架构失败传播或上传脱敏限制的配置。工作流修改必须保留这些明确形式。聚焦的配置和证据测试验证源代码规则，而非实际的原生产物打包或安装。各操作系统运行器仍需提供自己的执行证据；本地静态检查结果不构成发布授权。
