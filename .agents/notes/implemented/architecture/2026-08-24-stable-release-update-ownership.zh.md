# Agent Note: 稳定版发布更新所有权

Status: implemented

[English](2026-08-24-stable-release-update-ownership.md) | 中文

## Problem

签名 manifest 策略、持久化更新偏好、文件系统事务与发布工作流具有不同权限。合并这些职责可能让不可信发布数据进入持久化状态、让 Runtime 修改安装，或让验证任务执行签名或发布。发布证据还需要明确的完成点，以防部分写入的 manifest 集合被消费。

## Decision

`@harness-desktop/dsh-update-policy` 持有签名 manifest 解析与选择、公开发布策略解析和受限 HTTPS 读取。它会校验字段完全一致的记录、规范化 Ed25519 签名、应用、channel、消费方、平台、架构、格式、版本、HTTPS 源、摘要语法及安全归档成员。其内存中的 `VerifiedUpdateArtifact` 只向紧随其后的下载方保留已认证 URL；Runtime 记录、原生 journal 与工作器请求均不含发布 URL、密钥、签名或原始 manifest。

Runtime 通过现有设置提供方持有所选 Desktop channel 与最后一个持久化脱敏结果。存储的 channel 为 `stable`、`beta` 和 `nightly`；存储的结果种类为 `up-to-date`、`staged`、`applied`、`rolled-back` 和 `failed`。固定代码为 `unconfigured-update-source`、`up-to-date`、`staged`、`applied`、`rolled-back`、`manifest-rejected`、`artifact-rejected`、`health-check-failed` 和 `install-failed`。持久化记录只包含版本、channel、种类、代码和可选的最后已知良好版本。恢复进程在回滚后不会再次安排自动检查；后续 Main 进程只会抑制记录为从其当前已安装版本健康检查回滚的完全相同版本和 channel。无法读取结果时会拒绝该候选，但不同候选仍可参与检查。

打包后的 Desktop Main 从资源目录加载 `update-policy.json`，并只在认证 Dashboard 发布后开始一次自动检查。Main 将该检查、下载、暂存、原生移交及结果持久化作为一个生命周期 flight 接纳；关闭过程会停止接纳、终止远程读取，并在 Runtime 拆卸前等待本地暂存或回滚结算。Windows NSIS、使用 universal ZIP 候选的 macOS 与 Linux AppImage 拥有原生替换权；Debian 包把替换交给系统包管理器。`NativeDesktopInstallAdapter` 通过策略端点下载精确已安装版本的候选和保留回滚产物，同步私有文件及其父目录项，并记录事务 journal。打包后的分离工作器及其导入的每个 Main 构建块都会作为精确资源复制，因此安装程序开始替换自身后工作器仍可继续运行。在 Windows 上，其受限环境会保留非秘密的用户状态和 TLS 路径，包括 `HARNESS_HOME`、`TEMP` 与 `NODE_EXTRA_CA_CERTS`，并排除环境中的凭据。它从 `SystemRoot` 推导必需的系统路径，并让候选、回滚及恢复后的 Desktop 均以经过验证的应用目录作为工作目录，避免操作系统缓存解析到私有工作器存储之下。私有 journal 替换会保留已同步的 sibling，只在 `nativeWorkerReadyTimeoutMs` 内重试短暂的 Windows 共享错误；该时间界限到期时仍保留原 journal。安装目录外的外部工作器会再次校验两个摘要，并在 Main 可以退出前为两个安装器建立私有快照。公开策略使用 `nativeWorkerReadyTimeoutMs` 单独限制该准备时间；`healthCheckTimeoutMs` 限制等待旧进程退出以及安装后的候选 Dashboard 健康检查。旧进程超时会保持稳定安装不变。macOS 通过 Foundation 的固定路径原子替换发布候选 `.app`，不再执行两次目录 rename，因此进程中断不会让配置的 `.app` 名称消失。Windows 工作器仅通过候选 argv 传递一个 128-bit 启动 nonce，并在事务心跳中发布同一 nonce；Main 只接受这一精确配对和不晚于当前时间的 timestamp。其他平台继续使用进程启动时间检查。工作器会追踪候选的精确进程树身份；重启后的候选若没有有效心跳证明，会在 Dashboard 健康检查前安排回滚。工作器只接受匹配的 Dashboard 健康确认；候选启动失败、候选进程树退出、候选健康超时、journal 损坏或回滚请求都会终止候选进程树并安装保留发行版。自动回滚会在保留安装器成功后、稳定应用启动前发布事务绑定的完成标记，因此只有该稳定版本可以报告已回滚健康状态。Runtime 先记录终态结果，随后 Main 才把 journal 原子变更为 `cleanup-pending`；进程重启后会继续幂等清理已知事务标记、缓存和 journal，并保留未知条目。成功暂存、应用及健康检查失败后的成功恢复分别映射为 Runtime 的 `staged`/`staged`、`applied`/`applied` 与 `rolled-back`/`health-check-failed`；其他失败会映射为脱敏的 `failed` 结果。

序列化计划与分离工作器标记路径使用 `plan.platform`；Main 读取自身私有缓存时使用执行 Node 的宿主平台。这两类路径域不会互相替代。

在 Windows 上，Main 会把打包的 `windows-native-update-supervisor.exe` 复制到私有工作器目录，并且绝不在已安装资源位置直接执行它。这个无依赖的 AMD64 GUI supervisor 通过 Job Object 持有 PowerShell 工作器和安装器后代，而 Main 会保留启动所有权，直到 UUID 绑定的就绪记录稳定。就绪失败会使用私有取消请求；只有 supervisor 排空 Job、发布匹配确认并以取消完成代码退出后，Main 才会删除私有输入。候选与回滚 NSIS 安装器会通过最后一个 `/D=` 参数接收经过验证的应用目录，不依赖注册表中的安装状态。终态 journal 身份使用 Candidate Job 持有的精确 PID 与可执行路径，不比较由不同进程分别估算的 epoch 启动时间。候选 Desktop 与恢复后的 Desktop 使用显式 breakaway 路径，因此在 supervisor 成功结算后仍可存活，同时不会让安装器后代逃离 Job。

每个 NSIS 包都会复制一个一次性策略状态标记。复制完新包文件后，安装器宏只有成功读到精确的新 `present` 标记时才保留 `resources/update-policy.json`；标记缺失、无法读取或格式错误时都会删除该策略，随后删除标记本身。任一删除失败时安装器会中止，而不会在继承信任的状态下启动。因此有意省略策略的后继版本不会继承旧版本的信任配置；携带策略的后继版本只会保留自身策略，而不依赖旧版本卸载器的行为。

CLI 持有自身的包管理器提示与独立 payload 事务，不使用 Runtime 状态。npm 布局只输出 `npm update -g @harness-desktop/cli`，不会执行该命令。独立归档把 launcher 与恢复入口放在 `payload/current` 之外；updater 从该固定根目录加载公开策略，校验更新候选 manifest 与按当前版本索引的回滚 manifest，然后下载并检查候选字节、成员及可执行路径。仅含 `manifest.json` 的紧凑签名成员列表只有在归档内该 catalog 枚举所有安全成员时才会被接受；随后可执行路径会相对于已验证的 catalog 成员校验。launcher 可见的阶段 journal 和确定性的 `payload/retained` 路径，使下一次调用可在任意 rename 中断后保守恢复最后一个稳定 payload。通过排他创建的锁会拒绝第二个暂存事务；其不可预测的所有权令牌会持续持有到替换、进程树健康结算、回滚和私有文件清理完成。即使诊断性过期时间已到，只要 owner 身份仍精确匹配，就仍由该 live owner 持有事务；这包括 POSIX owner 的映像从 `payload/current` 移至 `payload/retained` 的情形，只有已终止或身份不匹配的 owner 才允许恢复。Windows 使用 ZIP；macOS 和 Linux 使用 tar.gz 以保留可执行权限。原生 Linux 产物行会在 Desktop 与独立 CLI 组装前，在匹配的 manylinux 2.28 镜像中重建 `node-pty`，并拒绝缺失 binding 或要求更高 GLIBC 的二进制。deploy 安装有意跳过 package script 后，CLI packer 会把该精确 binding 复制到部署后的 `node-pty` 包，并将其保留在 package files allowlist 中。Linux AppImage 和 Deb 的检查都会要求该 binding；独立归档的组装与校验随后要求该目标 binding，打包 Koffi 时还同时要求 `linux_<arch>` 与 `musl_<arch>` 两种 Koffi 二进制。缺失或错误架构的原生模块会在归档成为发布证据前被拒绝。macOS 和 Linux 在命令进程中完成切换和健康检查后释放已校验的锁；Windows 会把精确锁、journal 及固定 payload 路径移交给系统 PowerShell 工作器，工作器会在就绪前接管锁所有权，并在替换前和最终删除前再次检查。该工作器等待命令进程退出，切换 payload，把捆绑 Node 与 CLI 入口作为一棵进程树检查，并在健康检查失败时恢复保留 payload。缺失或无效策略会在候选 I/O 或变更前返回 `unconfigured-update-source`。

人工回滚只有一个安装器所有者。Windows 以事务命名的本地 mutex 保证只有写入匹配完成标记的工作器可以运行 NSIS 并重启稳定应用。macOS 和 Linux 只有在新的回滚工作器已就绪后，Main 才发布 `rollback-scheduled`；既有看门狗随后让出执行权，不再恢复安装字节。

## 发布证据与审批

`writeUpdateManifests()` 会先在内存中准备每个目标 manifest，再通过一次独占目录创建预留最终输出根目录，把集合写入私有内部暂存目录，并把该暂存目录重命名为 `ready`。它只在产物盘点完成后读取 Ed25519 私钥，对每个精确目标签名，并通过共享策略再次检查结果。脚本不会改动竞争方持有的根目录，失败清理也绝不会递归删除已预留的根目录。

无凭据的 Desktop 产物工作流使用 `--publish never`、临时公开策略和禁用签名进行打包。Desktop 软件包声明公开仓库主页和 GitHub noreply 作者，以便 Debian FPM 元数据具有可追溯的维护者。其 Deb 目标固定使用安全文件名 `harness-desktop_${version}_${arch}.${ext}`，因此 scoped 软件包名不能创建嵌套的 release 路径。Linux 产物检查使用 CI 提供的 `unsquashfs` 处理有界私有 SquashFS 快照，并且只提取指定资源；它绝不执行候选 AppImage 字节。Debian payload 预检会把 `dpkg-deb --fsys-tarfile` 直接流入私有 tar 文件，因此绝不在成员安全检查前缓冲安装包 payload。每一行都会通过稳定且不跟随链接的句柄只读取每个产物一次，写入精确的私有快照，并且只用这些快照完成盘点、临时 Ed25519 签名、manifest 校验、摘要绑定、证据收集及产品上传。`DSH_UPDATE_SNAPSHOT_ROOT` 选择供校验、证据收集与上传共享的根目录：CI 在干净检出中把它固定为 `dist/ci-update-snapshots`，完整的本地证据运行则必须显式选择自己的新子目录。未设置该变量的仅校验本地调用会预留新的 `dist/update-snapshots-*` 子目录，并且绝不删除或替换既有根目录；收集器拒绝推断根目录或回退到陈旧的 CI 快照。证据收集器会重新计算产物与 manifest 快照的摘要，并拒绝任何绑定不匹配。原生 CI 在每个可自更新目标上持有测试身份的健康提交与看门狗回滚证据：Windows NSIS、macOS universal ZIP，以及使用真实 FUSE 运行时的 Linux AppImage；macOS 临时策略会为同一构建/校验结果中的 Intel 与 Apple Silicon 两种 CLI tar.gz 同时提供候选和回滚端点。每一行还持有对应的 Windows CLI ZIP、Linux CLI tar.gz 归档、macOS `lipo` 检查和 Linux Deb 检查。每一行始终上传脱敏的产物哈希和检查结果记录，而产品快照仅在该行成功后上传。AppImage 策略证明其自更新目标；Deb 策略作为嵌入资源解析，但不要求自更新端点。单个主机的本地或缓存产物不能证明其他原生行，也不能证明新建的独立归档。

Desktop 的 `prepackage` 与 `prepackage:dir` 生命周期钩子会在 Electron Builder 之前运行跨平台原生准备命令；该命令在 Windows x64 上从当前 C 源码重新构建并校验原生 supervisor，在其他平台跳过。产物工作流依赖这些包入口，不再单独编译 supervisor。Windows 专属目录 FileSet 只从 x64 原生输出中选择 `windows-native-update-supervisor.exe`，并把它复制到 `resources/windows-native-update-supervisor.exe`；macOS 与 Linux 配置不会声明或携带它，`.obj` 与无关输出也会被排除。目录复制会让该 EXE 到达 Electron Builder 的额外文件 transformer。无凭据 CI 把 `signExecutable` 设为 false，因此 Electron Builder 会在发现签名身份前返回空 signing transformer；另行审批的发布构建则提供普通 `signIf()` 复制后操作，不会引入 supervisor 专用凭据或签名代码。无签名验证要求最终 NSIS 资源和 `win-unpacked` 资源与当前原生构建字节一致，并把两者识别为 AMD64 Windows GUI PE 映像。由于签名会有意改变已复制资源的字节，签名发布还需要单独的 Authenticode 与已审批签名方证据。

生产更新信任仍是单独的运维先决条件：任一 updater 运行前，公钥、已配置的精确 HTTPS 源及发布位置均需独立审计。设置 `DSH_DESKTOP_SIGNING_MODE=release` 的构建还必须提供有效且只含公开信息的 `DSH_DESKTOP_UPDATE_POLICY`，并强制 Electron Builder 进行代码签名，因此签名材料缺失或不可用会导致失败，而不会产出未签名发行版；独立 CLI 构建需要匹配的 `DSH_UPDATE_POLICY`。Windows 签名、macOS 公证、生产更新 manifest 签名、npm 发布、更新产物上传及创建 GitHub Release 均为单独审批操作。手动 candidate 工作流只验证是否恰好选择了一个未来操作；它不含凭据、release 权限、环境或外部操作步骤。

`1.0.1` 是已发布 `v1.0.0` 发行版的后继稳定候选。已发布的 `v1.0.0` 不包含原生 updater，因此该版本用户必须手动安装首个签名的 `1.0.1` 安装器；不承诺原位自动迁移。发布组装会拒绝复用或移动现有公开 tag；该 tag 之后的兼容性变更必须提供版本化迁移或显式且有文档记录的拒绝行为。

## Alternatives considered

- **让 Runtime 安装更新** — 不采用，因为 Runtime 持有持久化共享状态，而原生安装变更属于 Desktop Main 或独立 CLI 事务。
- **发布默认生产密钥与源** — 不采用，因为部署信任与发布位置需单独审计，并且必须在获得授权前保持缺失。
- **把已预留的 manifest 根目录视为就绪** — 不采用，因为写入方可能在预留后失败；内部 `ready` 重命名才是完整集合的发布点。
- **通过工作流布尔值组合签名与发布** — 不采用，因为休眠的外部命令与凭据会让证据收集获得更改 release 状态的权限。

## Consequences

仓库验证可以证明已打包的自动更新与回滚路径，但不会授予外部发布权限。运维方必须提供已审计的生产信任，并分别取得每项外部审批。原生证据仍由各平台持有，本地无签名产物仍只构成本地证据。
