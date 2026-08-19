# Agent Note: 单一 Harness home provider

Status: implemented

[English](2026-07-24-single-harness-home-resolver.md) | 中文

## 问题

宿主本地消费方曾分别解释可写用户数据根目录。插件可能读取 `$DSH_HOME`、使用 `~/.dsh`，或者接收配置路径；应用启动器和 Loader 表达式还会再次解析同一事实。因此，即使默认值看似相同，也无法证明设置、凭据、会话、附件、skill、指令、profile 和 shell 子进程使用同一个目录。

可写根目录策略还需要平台默认值，并且必须区分迁移来源。若把旧 `$DSH_HOME` 值当作写入回退，就会永久保留两个活动根目录，并允许兼容来源重定向新数据。

## 决策

`@harness-desktop/dsh-host-local-runtime` 负责可写根目录策略。`resolveHarnessHome()` 接受非空白的 `HARNESS_HOME` 覆盖值；未设置时，Windows 选择 `%LOCALAPPDATA%\Harness Desktop`，macOS 选择 `~/Library/Application Support/Harness Desktop`，Linux 选择 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。它返回绝对路径且带品牌类型的 `HarnessHome`。`$DSH_HOME` 只作为旧数据导入候选报告，绝不选择写入目标。

每个应用都在 Loader 树挂载前创建一个不可变的 `HarnessHomeProvider`。`dsh-app-boot` 向 Loader 发布该 provider，以及派生的 `harnessHome` 和 `harnessHomePath(...)` 表达式值。组合把这些已解析值传给每个宿主本地消费方；消费方不得重新读取环境、创建第二个 provider 或增加 `$DSH_HOME` 写入路径。需要隔离的启动器在创建 provider 前提供 `HARNESS_HOME`，无环境变量启动则保留平台默认值。

`@harness-desktop/dsh-home-paths` 保留波浪号展开和监听路径规范化等无依赖路径原语，但不负责数据根目录策略。持久写入方接收已解析 provider 或其子路径：设置、凭据、会话持久化、附件和匿名身份都写入同一个 home。profile、agent 指令、preset、skill 发现和受管理的 shell 环境消费同一次解析结果。

组装验证通过真实 profile manifest 运行构建产物，其组合包列表包含 `@harness-desktop/dsh-base`。专用的产物 Vitest lane 写入每一种持久产物，并从进程外观察读取侧消费方。源码测试清单排除该 lane，独立产物命令会先构建所需宿主产物。

## 备选方案

**让每个插件自行解析环境。** 即使调用相同 helper，也仍会在不同时刻解析，并允许配置绕过应用持有的值。注入使一个已经解析的 provider 成为唯一写入权威。

**保留 `$DSH_HOME` 作为可写兼容回退。** 旧值可以为显式导入工作流标识数据，但通过它写入会保留本决策要消除的双根目录行为。新写入只使用 `HARNESS_HOME` 或平台默认值。

**把配置、数据和缓存拆分到不同根目录。** 平台数据目录约定提供默认位置，但 Harness 持有的每个持久子目录仍位于一个根目录下。多根目录分类会在没有当前消费方需求的情况下重新引入协调问题。

**用手工缩小组合验证提供方。** 这种树可以验证单个构造器，却可能遗漏出厂配置项、patch 覆盖或真实 profile 解析。因此，产物 lane 通过生产入口消费 base 组合包。

## 影响

- 一次应用运行只有一个可写 home provider 和一个 `HARNESS_HOME` shell 事实；受管理的子进程环境中绝不出现 `DSH_HOME`。
- 原始组合和编程式组合必须向有要求的消费方注入已解析 provider。缺少注入会在 Loader 激活时失败，而不会悄悄选择另一个目录。
- 默认位置采用原生应用数据目录，而不是 `~/.dsh`。这是预发布存储破坏性变更；旧数据复制和冲突策略属于独立导入工作流。
- 仅产物验证具有显式构建前置，并且不会被普通源码测试程序收集。
