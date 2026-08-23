# Agent Note: 分层发布产物闭包

Status: implemented

[English](2026-08-23-release-artifact-closure.md) | 中文

## 问题

源码测试与未打包 Electron 进程无法证明原生安装程序内容完整、移除时保留用户状态，也无法证明 npm tarball 与 standalone archive 脱离开发 checkout 后仍能运行。这些故障发生在普通构建验证之后：安装程序可能漏掉图标，npm 可能借助 hoisting 解析 workspace import，archive 也可能调用宿主 Node 可执行文件或携带其他目标的原生模块。

Pull request 检查也不能仅因产出了类似发布物的文件就获得发布权限。产物检查、已安装执行、签名、上传与发布是不同操作，需要不同凭据和平台条件。

## 决策

Desktop 发布证据保持分层。静态检查要求当前 runner 的准确安装程序矩阵与生成图标资源；已安装 smoke 在匹配的原生平台上执行安装或挂载操作，启动真实 Desktop 并连接已认证 Dashboard fixture，只接受 Desktop 自己的脱敏 ready acknowledgement，然后移除产物并证明临时 `HARNESS_HOME` sentinel 仍然存在。已安装 fixture 会在已认证验证开始前记录已启动 Runtime 的清理根目录，因此即使验证在写入 sentinel 之前失败，cleanup 仍会移除该根目录。Collection lifecycle 会在较早产物的 lifecycle 失败时移除并清理所有尚未访问的已准备产物。每次 Windows 安装尝试都会在清理临时根目录前检查生成的 uninstaller：安装成功时必须存在，真正未安装时可以不存在；独立 rollback 故障会与主故障聚合。Linux 直接启动 AppImage，仅在 FUSE 特定故障时使用解压出的 `AppRun`。Deb 验收把 runner 的依赖状态数据库复制到经过校验的临时根目录，要求包内含有 `postinst` 与 `postrm`，在最小 chroot 内通过非交互式 `sudo dpkg --root=<root> --install` 完成配置，验证 `installed` 状态与生成的 launcher symlink，再通过同一根目录移除，并证明宿主 package 状态没有变化。Windows 负责 NSIS，macOS 负责 universal DMG 与两种架构，Linux 负责 AppImage 与 Deb；任何 runner 都不能用 archive listing 或其他操作系统的模拟替代原生执行。

打包 CLI 保留 `harness` 与 `dsh` 两个使用外部 import 的小型 client entry，并把完整 Runtime graph 部署为物理 bundled package dependencies。Payload 保留 `dsh-host-local-runtime` 自己的 `lib/bin.js` 与 `runtime.cordis.yml`、base/Web/headless patch layer、plugin 与 worker entry，以及目标原生依赖，保证按包相对定位的 Runtime spawn 不会反向解析到 CLI entry。Pack owner 只从名称与版本完全相同的 source package 修复缺失的 declared bin，把该 bin 保留在依赖的 files allowlist 中，再重新解压并审计生成的 tarball；standalone 消费过程从不修复外部提供的字节。验收过程把 tarball 安装到使用空 cache、offline 模式且禁用 scripts 的新 npm prefix，运行两个由该 prefix 拥有的 help 命令，并先要求已安装的 `harness web --status` 在 home 缺失时返回 typed no-start diagnostic，且不创建 Runtime 文件、browser bootstrap 或后代进程。验收把嵌套的已安装 Runtime bin 作为 stdin-owned child 启动，通过已安装 public connector 观察 `session-opened`，用 `harness` 获取 Web lease，再用 `dsh` 与 `harness` 幂等释放，证明保留的 terminal 仍可使用，然后在结束 Runtime stdin 前关闭两层 attachment；process kill 只作为有界的故障 fallback。物理 Node driver 加载已安装 `lib/bin.js` 引用的 `runCli` export：注入的 installed-app activator 只运行一次且不使用 Runtime 或 browser，default resolver 则在不执行 native launch 或 Electron substitute 的条件下报告当前平台安装路径与脱敏 diagnostic。每个验收子进程只接收显式传入且经过清理的环境：环境扩展被禁用，包含 checkout 的环境值与 `PATH` entry 以及 Node 或 TypeScript loader hook 始终缺席，npm 通过绝对可执行文件路径运行。Harness 自有源码与测试、凭据、Desktop 产物和过期 hash chunk 都不进入 payload；已发布的第三方依赖仍保留各自 package manifest 选中的内容，包括依赖自有的源码与测试路径。

Standalone CLI archive 消费这个闭合 tarball payload，以及由准确版本、平台、架构、文件名与 SHA-256 allowlist 选中的本地 Node distribution。Producer 从不下载。ZIP 与 tar.gz 使用稳定顺序、时间戳、所有权和 mode，带排序后的逐文件 digest map、排序后的 executable-path manifest 与匹配的 checksum sidecar；每个 `.node` 成员都经过目标检查并被记录。Executable 集合保留已部署文件的执行位，并包含声明的 package bin、目标 ripgrep、macOS node-pty `spawn-helper`、launcher 与 bundled Node。生产与验证都使用有界 worker pool 检查大型目录树。Tar 验证会拒绝未带 `0755` mode 的已记录 executable；ZIP 验证会在执行前根据经过 checksum 保护的 manifest 恢复 `0755`。执行 archive 前，已经启动的 verifier 会在自己的环境中加入临时 preload 以及恶意 Node 与 TypeScript loader 变量。每个 bundled-Node probe、native load、launcher 与 Runtime lifecycle 子进程只接收 verifier 显式传入且不扩展的环境；两种 archive lifecycle 都结束后，验证过程要求 preload marker 始终不存在，恢复原始进程环境，并移除 probe 目录。任何继承恶意 preload 的子进程都会产生 `standalone CLI: archive child inherited hostile ambient Node loader`。验证过程用 bundled Node 可执行文件加载已记录的原生模块，确认 `process.execPath` 位于该运行时内，从空目录运行两个 help entry，通过 `harness` 启动 Runtime，用 `dsh` 连接并释放 lease，期间没有 package manager、registry、network 或 system Node path。

Pull request 与普通 smoke workflow 保留 `--publish never` 和只读仓库权限。Release smoke 先生成并验证图标，再构建，最后才打包，因此构建不会捕获过期的生成资源。Runtime 获取是 offline producer 之前显式执行的 workflow 输入。CI retention 只列出已检查 NSIS setup executable、universal DMG、AppImage、Deb、standalone ZIP/tar.gz 与 checksum sidecar 的 glob；builder metadata、blockmap、unpacked tree 与 test result 都不进入 workflow artifact。这种受限保留不是 release distribution。签名、notarization、update-manifest 上传、npm 发布与 GitHub Release 创建仍然缺席，必须交给另行授权的发布工作。

## 曾考虑的替代方案

**把未打包 Electron 启动当成 package 验收。** 它不执行安装程序 metadata、原生移除、挂载镜像行为或已安装图标资源，因此没有覆盖风险最高的打包操作。

**把 archive listing 当成已安装成功。** Listing 是有效的静态证据，却无法证明已安装可执行文件能够认证 Dashboard、发出归属明确的 ready acknowledgement，或在移除时保留 `HARNESS_HOME`。

**允许 npm 或 standalone verifier 使用在线解析与 system Node 可执行文件。** 这类验证可能只因 runner 有暖 cache、registry 访问、workspace hoisting 或 `PATH` 上存在 Node 而通过，交付字节本身仍未得到证明。

**由 standalone producer 内部下载 Node。** 把获取与验证合并，会让未经审查的网络响应成为产物的一部分。独立获取步骤配合已提交 allowlist，使 producer 保持 offline 与 fail-closed。

**在一个 runner 上交叉模拟原生安装程序。** 外来操作系统的工具输出不能证明原生安装、挂载、架构、launcher 或卸载行为，因此 workflow 改为承担三个原生 job 的成本。

## 后果

发布 smoke 需要更多时间与平台容量，因为源码、packed npm、deterministic archive、静态安装程序和已安装产物检查保持分离。Node 版本与 distribution checksum 是需要审查的数据，只能显式变更；每个操作系统也必须维护自己的安装程序 fixture。

作为回报，每个通过验收的产物都有具名证据层和当前 runner owner。Pull request 无需获得签名或发布权限，就能证明完整 offline CLI 字节与真实原生 Desktop lifecycle；后续发布工作也能消费同一批已检查产物，而无需在持有凭据时重新构建。
