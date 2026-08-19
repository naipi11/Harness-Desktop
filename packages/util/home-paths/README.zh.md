# dsh-home-paths

[English](README.md) | 中文

共享的无依赖文件系统路径辅助工具。Harness Desktop 数据根目录策略归属 [`dsh-host-local-runtime`](../../host/local-runtime/README.md)。

`expandHomePath()` 使用操作系统主目录展开 `~`、`~/...` 和 Windows 风格的 `~\...` 前缀。它会保留非波浪号路径和 `~user/...` 原样不变。

## 监听路径

`canonicalizeWatchPath()` 为原生文件系统 watcher 提供一种稳定的目标路径表示。它通过 `fs.realpath()` 解析层级最深的现有祖先路径，再拼回缺失的后缀，因此即使文件或目录尚未创建也仍可监听。尤其是，Windows 8.3 别名不能与原生 watcher 后端发出的长路径混用。

该包刻意保持很小且不依赖 harness，因此产品包可共享文件系统原语，而无需导入宿主策略。

## 已知限制与暂缓事项

- **展开范围刻意保持狭窄**：只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量和 shell 表达式保持不变。
- **规范化会读取，但绝不修改**：`canonicalizeWatchPath()` 会执行 `realpath` 探测，并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。
