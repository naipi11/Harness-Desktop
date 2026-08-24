# Harness Desktop

[English](README.md) | 中文

Harness Desktop（`harness`）是一款开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

Harness Desktop 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，再全局安装 CLI 并运行：

```sh
npm install -g @harness-desktop/cli
harness web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

如需后台运行，使用 `harness web --daemon`（或 `--background`）：父进程会输出子进程 PID 与私有日志路径，然后退出。

CLI 以 `@harness-desktop/cli` 发布；`dsh` 保留为兼容命令名，并使用相同的数据与 profile 布局。

`harness update`（或 `dsh update`）会根据检测到的安装形式执行相应行为。npm 安装只输出 `npm update -g @harness-desktop/cli`，不会执行该命令。独立归档的校验与回滚行为见 [CLI 更新参考](apps/cli/README.md#update)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/naipi11/Harness-Desktop.git
cd Harness-Desktop
pnpm install
pnpm run build
pnpm harness web
```

`pnpm harness web` 在前台启动 Web UI。如需后台运行，使用 `pnpm harness web --daemon`（或 `--background`）：父进程会输出子进程 PID 与私有日志路径，然后退出。

### 桌面客户端

Electron 客户端支持 Windows、macOS 与 Linux。安装包分发已具备签名前准备，但仍受审批约束：Windows 签名、macOS 公证、更新 manifest 签名、npm 发布、更新产物上传及创建 GitHub Release 均需分别授权。从仓库源码目录运行：

```sh
git clone https://github.com/naipi11/Harness-Desktop.git
cd Harness-Desktop
pnpm install
pnpm run build
pnpm desktop
```

如需为当前平台构建安装包：

```sh
pnpm --filter @harness-desktop/dsh-desktop run package
```

发布产物与证据矩阵如下：

| 平台 | Desktop 产物 | 独立 CLI 产物 | 原生证据负责人 |
|---|---|---|---|
| Windows | NSIS | ZIP | Windows CI |
| macOS | Universal DMG | tar.gz | macOS CI，包括 `lipo` 检查 |
| Linux | AppImage 与 Deb | tar.gz | Linux CI |

CI 使用 `--publish never` 构建每一行；在当前平台进行的本地构建不能证明其他操作系统的产物。如需免安装目录而非安装包，将 `package` 替换为 `package:dir`。本地产物位于 `apps/desktop/release/`。

Desktop 与 CLI 的发布默认值均会拒绝未配置的更新：代码中不含生产更新公钥、不可变 HTTPS 源或发布位置，因此未配置可实际运行的自动更新。启用更新前，必须对这些先决条件以及上述每项外部发布审批分别进行审计。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/naipi11/Harness-Desktop/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
