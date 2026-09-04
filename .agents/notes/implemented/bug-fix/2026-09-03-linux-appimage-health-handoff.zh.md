# Agent Note: Linux AppImage health handoff

Status: implemented

[English](2026-09-03-linux-appimage-health-handoff.md) | 中文

## Problem

Linux AppImage 可能在 detached worker 发布事务 heartbeat 之后才启动挂载后的 Electron Main。若要求 heartbeat 时间戳晚于 candidate 的 epoch 估计，就会拒绝这个合法启动并触发 health-check rollback。source live Runtime entry 也需要使用解析后的 package URL，因为 ClientModuleRegistry 的 metadata 解析锚点位于 local-runtime package，而不是每个 bundle package。成功的 candidate 会在 finalization 期间移除 applied marker，因此要求这个短暂 marker 的已安装更新测试无法区分已提交 candidate 与失败的交接。

hosted macOS arm64 runner 在 electron-builder 创建 x64/arm64 pair 之前只安装了 host 架构的 optional native package，因此 universal packaging 在两个 app 中看到了相同的 arm64 `sharp` Mach-O。manylinux node-pty Makefile 保留了指向容器挂载范围之外 runner-temp `node-gyp` include 的绝对路径。Windows packaged Runtime verifier 还丢弃了可以说明加载失败原因的子进程 diagnostic。

release-workflow helper 测试会有意清空子进程环境，因此在 hosted runner 上调用裸 `node` binary 并不具备可移植性。macOS artifact verifier 还假设每个 DMG 与 ZIP 都使用字面名称 `Harness Desktop.app`，但 archive layout 才是权威来源。

## Decision

`apps/desktop/tests/support/runtime-live-entry.mjs` 在 boot 前使用 `import.meta.resolve()` 解析 source patch 插入项中的每个 bare package name，同时保留 `cordis:` 与已有的 `file:` entry。Built Runtime composition 继续使用现有的 patch 解析路径。`isCurrentWatchdogHeartbeat()` 允许 Linux heartbeat 不早于 `candidateStartedBeforeMs - healthCheckTimeoutMs`，且不晚于观测时间；Windows launch nonce 语法与默认的严格 helper 行为保持不变。Linux 已安装更新测试接受两种情况：带有存活 candidate process 的实时 applied marker，或 candidate version 已安装、私有 journal 已消失且 Runtime 报告 `applied:applied` 或 `up-to-date:up-to-date`。

freshness window 使用已有 policy health window，而不是新增部署 tunable 字段。事务专属私有存储和 worker 的终态 applied outcome 仍然是必需条件，因此近期 heartbeat 不能在没有 detached worker proof 的情况下提交更新。source resolver 属于测试 Runtime 基础设施；它不会仅为改变解析锚点而向 `dsh-host-local-runtime` 增加所有 bundle package 的直接依赖。

Windows PowerShell 在执行 supervisor 的 worker 脚本前会向 `PATHEXT` 追加 `.CPL`。`createWindowsWorkerEnvironment()` 显式包含这个扩展，使 WMI 子进程 receipt 与受限环境一致，同时不扩大允许的环境变量名称集合。

workspace 为当前操作系统声明同时解析 x64 与 arm64 optional dependency。macOS builder 保留相同的目标 native Mach-O package 文件，同时继续对架构不同的文件执行 lipo。manylinux job 以只读方式把生成 Makefile 使用的 `RUNNER_TEMP` 挂载到相同路径。CLI release path 使用 `pnpm deploy --legacy` 与 hoisted node_modules tree；若 legacy deploy 没有顶层 Linux node-pty，就从源 package 物理 materialize，并在 pack 前移除 devDependencies，因此 workspace package 不会保留指向源树的 injected link。hosted job 在 packed-CLI smoke 后以 `prod=false` 恢复完整 workspace，再执行后续 release 命令。隔离 Deb fixture 只在自有 dpkg root 内使用 `--force-depends`，因为该 root 不含 runner 的系统包；它仍要求包状态为已配置、文件与 launcher 正确、真实启动成功且宿主状态不变。

workflow helper 使用 `process.execPath` 启动 fixture。macOS DMG 与 ZIP inspection 在有深度上限的范围内定位唯一的非 symlink `.app` bundle，并相对于该 bundle 应用必需资源检查。Linux hosted UI smoke 使用私有 Xvfb display，因为 runner 没有 X server。Electron Builder 显式保留 `runAsNode` fuse 供 packaged worker 使用。local Runtime package 显式导出 test-only `./bin` entry。Unix Runtime verification 使用临时外部 ESM probe 导入精确的 asar entry；Windows 以显式 test-only probe flag 启动正常 packaged Main，再由 Main 通过该 package export 导入同一 entry。pack 后的 release checks 直接调用 pinned Node、Vitest 或 Playwright entry，因此 pnpm dependency-status check 不会修改 workspace。standalone archive verification 在解包后比较 realpath，避免归档 symlink 造成错误的宿主 Runtime 判定；launcher diagnostic 保留有长度上限的退出码、stdout 和 stderr。两条 Desktop Runtime 路径都 pipe 输出，记录退出码、signal、forced-failure 状态和 ready marker，以及有长度上限的 diagnostic；超时只终止该 child tree，并重试删除自有目录。

## Alternatives considered

**在写入 worker heartbeat 前加入固定延迟。** 不采用。AppImage mount 与 Electron 启动时间随 runner 变化，固定延迟要么保留竞态，要么浪费 health window。

**移除 Linux 时间戳下界。** 不采用。同一事务的 heartbeat 仍处于私有存储并绑定事务，但不受限制的旧记录会削弱 restart 处理。已有 health window 限制可接受的记录年龄。

**要求 candidate finalization 后仍保留 applied marker。** 不采用。Runtime 记录终态 outcome 后由 finalization 负责移除 marker。测试消费这个持久化 outcome，而不是改变更新生命周期。

**把所有 browser package 都加入 local-runtime 的直接依赖。** 不采用。这会复制 bundle dependency graph，并使 source patch 解析依赖 package 布局。File URL 明确记录 source loader 的 package origin。

## Consequences

当 Runtime fork 或 mount Main 的时间晚于 worker 的即时 launch 返回时，Linux AppImage candidate 仍可完成 health handoff。Linux 已安装测试证明 candidate replacement 以及 finalization 后的 `applied` outcome；既有 rollback 场景仍要求 health 未确认时保留稳定产物。原生 Linux 证据仍依赖具备 Electron 运行库、FUSE、SquashFS 工具和目标兼容 native binding 的 runner；WSL 结果不能提供 macOS 证据或 manylinux 兼容性证明。
