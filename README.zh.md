# Harness Desktop

[English](README.md) | 中文

Harness Desktop（`harness`）是一款开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

Harness Desktop 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx --package @deepseek-ai/dsh harness web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

过渡期 npm 包仍以 `@deepseek-ai/dsh` 发布；`dsh` 保留为兼容命令名，并使用相同的数据与 profile 布局。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/naipi11/Harness-Desktop.git
cd Harness-Desktop
pnpm install
pnpm run build
pnpm harness web
```

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
