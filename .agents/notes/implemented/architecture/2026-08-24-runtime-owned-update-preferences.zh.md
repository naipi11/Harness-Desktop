# Agent Note: Runtime 所有的 Desktop 更新偏好

Status: implemented

[English](2026-08-24-runtime-owned-update-preferences.md) | 中文

## 问题

Harness Desktop 客户端需要一个所选更新频道和耐久结果记录，同时不能引入客户端私有持久化写入方，也不能让更新位置、manifest、凭据、路径或原始错误泄漏到共享状态。

## 决策

`@harness-desktop/dsh-host-local-runtime` 通过已组合的设置提供方注册 `desktop-update` namespace。该区段包含一个 `stable`、`beta` 或 `nightly` 频道，并在存在时包含一条固定格式结果：语义版本、固定结果种类、固定脱敏代码以及可选的最后已知良好版本。

已认证 Dashboard 控制只读取和变更所选频道。已认证原生控制还会记录脱敏结果。HTTP 路由会在到达控制服务前拒绝额外字段和无效频道、版本、种类或代码值；设置所有者会对已存数据重复执行相同的固定字段准入。

Runtime 不获取 manifest、不持有生产信任根、不下载产物、不暂存安装、不请求重启，也不回滚版本。这些操作需要单独配置的生产信任和按平台划分的安装所有权。

## 考虑过的替代方案

**Electron user data 与 CLI 本地文件。** 被拒绝，因为可独立写入的客户端存储可能与共享 `HARNESS_HOME` 状态发生分歧，并绕过 Runtime 的串行设置提供方。

**向 Dashboard 控制公开完整结果。** 被拒绝，因为 Dashboard 需要的是用户偏好，而非 UI 的原生启动器拥有安装器状态，且不能把哪怕已脱敏的安装历史投影到任意浏览器控制中。

**任意诊断文本或 manifest 字段。** 被拒绝，因为失败更新通常含有 URL、路径、签名和传输错误；封闭记录阻止这些值进入设置、控制响应或诊断。

## 后果

所有频道和结果写入都使用既有设置写入队列，并随其余 `HARNESS_HOME` 状态跨客户端重启保留。所选频道会在原生和 Dashboard 客户端之间一致可见，而 Dashboard 控制无法读取或写入结果。

精简组合没有设置提供方时，更新控制通过既有脱敏 Runtime 失败路径失败。没有配置生产信任根的产品仍没有网络或安装器变更路径。

`update-preferences`、控制服务、公开 Runtime 客户端、私有路由以及源码/构建进程兼容性测试固定记录、所有权拆分、恶意请求拒绝和共享 Runtime 行为。
