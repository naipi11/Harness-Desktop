# Agent Note: Electron-native directory picker child mode and IPC lifetime

Status: implemented

[English](2026-09-08-electron-native-directory-picker.md) | 中文

## Problem

本地 Runtime 在启动应用子进程前会消费自身的 `ELECTRON_RUN_AS_NODE` 标记。Windows 目录选择器复用 `process.execPath`；打包后的 Electron Runtime 如果不显式提供 Node 模式环境，启动 JavaScript worker 时就会启动另一个应用。普通 Node 单元测试和基于源码 Runtime 的 Dashboard 测试没有覆盖这一打包后的交接。另一个 worker 缺陷会在非最终的 `showing` 通知发送完成时关闭 IPC，但所选目录或取消结果仍需要通过该通道返回。

## Decision

原生选择器根据 `process.versions.electron` 判断子进程执行模式，仅在该子进程的环境副本中设置 `ELECTRON_RUN_AS_NODE=1`，不修改 Runtime 环境。worker 发送 `showing` 时不关闭连接；仅在最终结果或错误发送完成后关闭 IPC。父进程断开连接时终止子进程的行为保持不变。

COM 返回值在释放分配内存前使用 Koffi 的 NUL 结尾 `decode.string16` API 解码。`koffi.view` 会暴露外部 ArrayBuffer，在 Electron 中执行到选择结果读取时导致进程中止。复制字符串也避免把非零 UTF-16 码元中的零低字节误认为字符串结束。

规范 Runtime 提供与 CLI 相同的分发预设列表。源码启动读取 CLI 的权威目录，构建包在 Runtime 模块旁携带副本并声明每个预设所需的插件依赖。这修复了成功添加目录后的下一步：此前创建会话会因为找不到 `standard` 而被拒绝。系统预设仍优先于用户根目录；该修复不会创建或覆盖用户预设。

## Alternatives considered

**在 Runtime 环境中保留 Node 模式。** 不采用，因为无关子进程不应继承 Electron 专属的执行模式覆盖；该子进程的启动由选择器负责。

**用浏览式后端隐藏失败。** 不采用，因为本地 Windows 组合明确提供原生选择器；更换交互会留下打包 worker 缺陷及其缺失的验收覆盖。

## Consequences

打包后手动更新预览版的验收通过 Dashboard 打开真实 Windows 对话框，输出测试专用的非 ASCII 目录，供操作员或桌面控制助手选择。Playwright 随后验证工作区出现且刷新后仍被选中；这是交互式验收，不是无人值守的原生输入自动化。临时 Windows 配置目录包含标准 shell 文件夹，以便原生对话框初始化。源码测试分别约束 Node 模式选择、IPC 发送回调顺序、取消以及不使用外部内存视图的 UTF-16 解码。这些检查不代表模型提供方请求或自动更新已通过验收。
