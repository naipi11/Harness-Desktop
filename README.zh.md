# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 原生 CLI 产物

发布 CI 会生成 Linux x64/arm64、macOS x64/arm64 和 Windows x64 的独立 CLI 压缩包。POSIX 压缩包命名为 `dsh-<version>-<platform>-<arch>.tar.gz`，Windows 使用 `.zip`；每个压缩包都有对应的 `.sha256` 文件，并包含目标平台的 `node-pty` 原生资产。

在 Linux 或 macOS 上，下载匹配的压缩包和校验文件，验证后解压：

```sh
sha256sum -c dsh-<version>-linux-x64.tar.gz.sha256
tar -xzf dsh-<version>-linux-x64.tar.gz
./dsh-<version>-linux-x64 --help
```

在 Windows PowerShell 中验证并解压 Windows 压缩包：

```powershell
$sum = Get-Content .\dsh-<version>-win-x64.zip.sha256 -Raw
$parts = $sum.Trim() -split '\s+', 2
if ((Get-FileHash .\dsh-<version>-win-x64.zip -Algorithm SHA256).Hash.ToLower() -ne $parts[0].ToLower()) { throw 'checksum mismatch' }
Expand-Archive .\dsh-<version>-win-x64.zip -DestinationPath .
dsh-<version>-win-x64.exe --help
```

Windows x64 发布版本还包含使用 Inno Setup 构建的 `dsh-<version>-win-x64-setup.exe`。运行安装程序即可按当前用户将 `dsh.exe` 安装到 `%LOCALAPPDATA%\DeepSeek Harness`，并在 Windows 设置中提供卸载程序。Debian x64 和 arm64 发布版本分别包含 `dsh_<version>_amd64.deb` 和 `dsh_<version>_arm64.deb`；使用 `sudo apt install ./dsh_<version>_<architecture>.deb` 安装，使用 `sudo apt remove dsh` 卸载。安装前请先验证对应的 `.sha256` 文件。这些安装包仅支持 Windows x64 与 Debian x64/arm64；其他 Linux 发行版可使用 CLI 压缩包。CLI 分发不声称支持 Electron、DMG、MSI、AppImage 或 Python wheel。可在本地为原生目标构建，例如使用 `DSH_CLI_TARGET=node24-linux-x64 pnpm run build:cli-exe`。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
