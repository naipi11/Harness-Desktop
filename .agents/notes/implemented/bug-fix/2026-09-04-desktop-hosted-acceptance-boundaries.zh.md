# Agent Note: Desktop hosted acceptance boundaries

Status: implemented

[English](2026-09-04-desktop-hosted-acceptance-boundaries.md) | 中文

## Problem

canonical local Runtime 在 SSH 或可远程访问的主机上可以选择 browse directory-picker interaction。adaptive chooser 会把 Host backend 与 browser surface 作为动态 Loader entry 挂载，而 ClientModuleRegistry 从 config-tree package anchor 解析 client metadata。local Runtime 的 dependency closure 包含 native picker 选项，却没有 browse 选项，因此 active browse entry 可能不在 browser graph 中，Dashboard 也会隐藏 Add workspace action。

Windows cancellation cleanup 在每次移除 private input 前重新检查 exact supervisor image。移除 supervisor image 后，下一次 proof 会尝试解析一个本来就应当不存在的路径，于是 cleanup 以 inspection error 停止并保留剩余 private input。Windows source acceptance 还把 drive path 传给 Node 的 `--import` 选项，而 Windows 下该选项需要 file URL。

## Decision

`packages/host/local-runtime/package.json` 与 workspace lockfile 声明两个动态 browse-picker package：`@harness-desktop/dsh-host-directory-picker-browse` 与 `@harness-desktop/dsh-client-ui-directory-picker-browse`。native 选项仍是直接依赖。这样 ClientModuleRegistry 的 local-runtime config anchor 拥有 `directory-picker-auto` 可能挂载的完整 package 集合；source Runtime 仍通过 `import.meta.resolve()` 显式解析 patch entry，相关约束记录在 [Linux AppImage health handoff](2026-09-03-linux-appimage-health-handoff.md)。

`apps/desktop/tests/support/runtime-fixture.ts` 在内部保留 hook filesystem path，并在 `--import` 参数处用 `pathToFileURL()` 转换。因此每个 runner 的测试启动都会使用有效的 ESM URL，不改变 packaged application 行为。

`assertWindowsCancellationProof()` 在每个 cleanup step 验证保留下来的 drained acknowledgement。readiness、初次 cancellation proof 以及删除 image 之前的 cleanup，都要求 private supervisor image 是可检查的普通文件且不是链接。cleanup 记录对该 image 成功执行的严格 unlink；只有之后的 `ENOENT` 才允许跳过 image inspection，路径重新出现则必须检查。unlink 时 image 已不存在是错误，不算本次 cleanup 的删除成果。launch bridge 已验证的 supervisor PID 会传给 readiness 与 cancellation probe；没有 PID 的 stale-supervisor retirement 使用 supervisor-filename filter。PID probe 保留 query error，只有 `Get-Process` 明确的 process-ID-not-found error 才表示进程不存在。两条路径都比较 canonical 或规范化的 full path，保持 bounded output，并对其他 query 与 target-path error fail-closed。error cause 保留在有长度上限的 diagnostic 中。

readiness 与 cancellation polling 的 exact-image probe 使用 policy deadline 的剩余时间，最多 15 秒。没有 deadline 时，final cancellation observation 与 cleanup revalidation 使用五秒 timeout；public inspector 与 stale-supervisor retirement 也默认五秒。15 秒是最大上限而非默认值，不会延长这些五秒 observation。

真实进程测试使用有界等待来检查 process identity、process absence 与 command-line probe。文件不存在通过不跟随链接的 metadata inspection 证明：只有 `ENOENT` 表示不存在，瞬态 `EPERM`/`EBUSY` 在有限时间内重试，其他错误则拒绝。exact-process absence query 保留 CIM error，拒绝缺少可检查 executable path 的同名进程行、stderr 或歧义输出，并把每次 child invocation 限制在 wait deadline 剩余时间内。主要 worker 与 cancellation wait window 仍由 policy 选择；有效 drained acknowledgement 只允许额外的一次有界 final exact-image observation。

## Alternatives considered

**把所有 browser package 加入 local-runtime。** 不采用。只有 Host 选中的动态 picker 选项属于这个 dependency closure；静态 browser roster 仍由 Web bundle 与 source patch resolution 负责。

**在所有 exact-image check 中把缺失 supervisor image 当作进程不存在。** 不采用。readiness 或第一次 cancellation proof 中的缺失 target 不能建立 ownership，必须 fail-closed。只有已建立 proof 后的 cleanup 才能跳过已经移除的 image。

**把 exact-image subprocess buffer 扩大到足以容纳嘈杂的 WMI output。** 不采用。probe 按唯一 supervisor filename 过滤，并保留已有 bounded output policy，而不是接受无界 diagnostic volume。

**最后才移除 supervisor image 或取消重复 proof check。** 不采用。cleanup 对每个 private-input removal 保留 proof check；proof helper 区分同一次 cleanup 已移除的 image 与从未证明停止的 image。

## Consequences

远程/SSH source Runtime acceptance 会把 browse client row 放入 `window.__DSH_BOOT__`，因此 workspace directory flow 仍然可用，不会在 Host display 上打开 native chooser。source Dashboard journey 使用与 installed acceptance 相同的动态选择，覆盖 authenticated handoff、workbench、workspace picker、history、settings 与 live approval path。

Windows exact-image cleanup 对不确定的 process ownership 仍 fail-closed，同时在有效 cancellation acknowledgement 后完成 private-input teardown。focused launcher 与 real worker suite 覆盖 canonical image matching、WMI-created supervisor、cancellation 与 private-file cleanup；有效 ack 后的 final observation 使用五秒，不会产生无界等待。
