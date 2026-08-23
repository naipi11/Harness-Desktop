# Agent Note: 分层发布产物闭包

Status: implemented

[English](2026-08-23-release-artifact-closure.md) | 中文

## 问题

源码测试与未打包 Electron 进程无法证明原生安装程序内容完整、移除时保留用户状态，也无法证明 npm tarball 与 standalone archive 脱离开发 checkout 后仍能运行。这些故障发生在普通构建验证之后：安装程序可能漏掉图标，npm 可能借助 hoisting 解析 workspace import，archive 也可能调用宿主 Node 可执行文件或携带其他目标的原生模块。

Pull request 检查也不能仅因产出了类似发布物的文件就获得发布权限。产物检查、已安装执行、签名、上传与发布是不同操作，需要不同凭据和平台条件。

## 决策

Desktop 发布证据保持分层。静态检查要求当前 runner 的准确安装程序矩阵与生成图标资源；已安装 smoke 在匹配的原生平台上执行安装或挂载操作，启动真实 Desktop 并连接已认证 Dashboard fixture，只接受 Desktop 自己的脱敏 ready acknowledgement，然后移除产物并证明临时 `HARNESS_HOME` sentinel 仍然存在。Windows 负责 NSIS，macOS 负责 universal DMG 与两种架构，Linux 负责 AppImage 与 Deb；任何 runner 都不能用 archive listing 或其他操作系统的模拟替代原生执行。

打包 CLI 保留 `harness` 与 `dsh` 两个使用外部 import 的小型 client entry，并把完整 Runtime graph 部署为物理 bundled package dependencies。Payload 保留 `dsh-host-local-runtime` 自己的 `lib/bin.js` 与 `runtime.cordis.yml`、base/Web/headless patch layer、plugin 与 worker entry，以及目标原生依赖，保证按包相对定位的 Runtime spawn 不会反向解析到 CLI entry。验收过程把 tarball 安装到新 npm prefix，使用空 cache、offline 模式并禁用 scripts，通过 `harness web --background --no-open` 启动 Runtime，用 `dsh web --status` 连接，释放 lease，并运行两个由该 prefix 拥有的 help 命令。源码、测试、凭据、Desktop 产物与过期 hash chunk 都不进入 payload。

Standalone CLI archive 消费这个闭合 tarball payload，以及由准确版本、平台、架构、文件名与 SHA-256 allowlist 选中的本地 Node distribution。Producer 从不下载。ZIP 与 tar.gz 使用稳定顺序、时间戳、所有权和 mode，带排序后的逐文件 digest map 与匹配的 checksum sidecar；每个 `.node` 成员都经过目标检查并被记录。生产与验证都使用有界 reader pool 对大型目录树进行 hash。验证过程把两种格式解压到一次性目录，用 bundled Node 可执行文件加载已记录的原生模块，确认 `process.execPath` 位于该运行时内，从空目录运行两个 help entry，通过 `harness` 启动 Runtime，用 `dsh` 连接并释放 lease，期间没有 package manager、registry、network 或 system Node path。

Pull request 与普通 smoke workflow 保留 `--publish never` 和只读仓库权限。Runtime 获取是 offline producer 之前显式执行的 workflow 输入。CI 仅把已检查 Desktop 产物、standalone archive 与 checksum sidecar 保留为 workflow artifact；这种受限保留不是 release distribution。未经脱敏的 test-result 上传、签名、notarization、update-manifest 上传、npm 发布与 GitHub Release 创建仍然缺席，必须交给另行授权的发布工作。

## 曾考虑的替代方案

**把未打包 Electron 启动当成 package 验收。** 它不执行安装程序 metadata、原生移除、挂载镜像行为或已安装图标资源，因此没有覆盖风险最高的打包操作。

**把 archive listing 当成已安装成功。** Listing 是有效的静态证据，却无法证明已安装可执行文件能够认证 Dashboard、发出归属明确的 ready acknowledgement，或在移除时保留 `HARNESS_HOME`。

**允许 npm 或 standalone verifier 使用在线解析与 system Node 可执行文件。** 这类验证可能只因 runner 有暖 cache、registry 访问、workspace hoisting 或 `PATH` 上存在 Node 而通过，交付字节本身仍未得到证明。

**由 standalone producer 内部下载 Node。** 把获取与验证合并，会让未经审查的网络响应成为产物的一部分。独立获取步骤配合已提交 allowlist，使 producer 保持 offline 与 fail-closed。

**在一个 runner 上交叉模拟原生安装程序。** 外来操作系统的工具输出不能证明原生安装、挂载、架构、launcher 或卸载行为，因此 workflow 改为承担三个原生 job 的成本。

## 后果

发布 smoke 需要更多时间与平台容量，因为源码、packed npm、deterministic archive、静态安装程序和已安装产物检查保持分离。Node 版本与 distribution checksum 是需要审查的数据，只能显式变更；每个操作系统也必须维护自己的安装程序 fixture。

作为回报，每个通过验收的产物都有具名证据层和当前 runner owner。Pull request 无需获得签名或发布权限，就能证明完整 offline CLI 字节与真实原生 Desktop lifecycle；后续发布工作也能消费同一批已检查产物，而无需在持有凭据时重新构建。
