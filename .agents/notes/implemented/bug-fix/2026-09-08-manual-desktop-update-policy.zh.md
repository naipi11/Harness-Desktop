# Agent Note: Policy-less Desktop previews start without an update error

Status: implemented

[English](2026-09-08-manual-desktop-update-policy.md) | 中文

## Problem

未签名、手动安装的预览版有意省略生产更新信任配置。把这种缺失当成损坏的策略，会在 Dashboard 启动前显示阻塞式原生错误，尽管该包本来就禁用了自动更新。

## Decision

`loadDesktopUpdateSource()` 仅在读取已安装策略返回 `ENOENT` 时返回无更新源。Main 随后继续正常启动，不构造原生更新适配器，也不获取 manifest。JSON 损坏、策略字段无效、目标平台不受支持及其他读取失败仍拒绝；Main 保留固定的更新错误提示。现有原生恢复记录不会被当成已配置更新源的证据。

## Alternatives considered

嵌入占位公钥或在线更新源会造成误导性的信任配置和多余的网络行为。忽略所有策略错误会隐藏损坏或无法读取的安装。对有意缺失的策略继续报错会阻止预览版无人值守启动，却不能让更新校验更安全。

## Consequences

Windows 预览版仍需手动安装，没有自动更新频道。测试覆盖策略缺失且不请求网络、损坏及无法读取的策略被拒绝，以及显式指定的打包可执行文件不依赖源码 Runtime 冷启动进入 Dashboard 与设置。生产签名和原生更新验收仍是独立要求。
