# 内部组合包与 profile 格式

[English](publish.md) | 中文

本页作为组合**包**与 **profile** 的内部格式参考保留。公开 `dsh` 产品语法没有插件安装、profile 启动、patch 或配置 dump 命令，因此原工作流不再是可执行的用户教程。当前插件编写指引见[插件配置](./config.md)。

受支持的交互、run、Web 与 Desktop 命令见 [CLI（命令行界面）行为参考](../../../../apps/cli/reference/README.md#source-execution)。下列 manifest（元数据清单）仅描述内部 Runtime 组装与测试 fixture（测试前置数据）。

## 两个概念，两种 manifest

安装机制建立在两个概念之上。二者都由一份 `package.json` 描述，但它们在 `dsh` 键下携带的 manifest（元数据清单）种类不同，回答的问题也不同：

- **组合包**是附带一个配置层的 npm 包。它的 manifest 声明 `dsh.bundle`，回答的是"这个包贡献什么？"：一个插入或覆盖插件行的 patch 文件。
- **profile** 是位于 `$HARNESS_HOME/profiles/<name>` 下、描述一份内部 Runtime 组装的目录。它的 manifest 声明 `dsh.profile`，回答的是"这套配置由哪些组合包按什么顺序组成？"。

组合包是可分发配置层；profile 是内部组装记录。公开 CLI 不按名称启动二者。

### 组合包 manifest

创建包目录：

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

创建 `hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

创建 `hello-plugin/index.js`，写入插件入口：

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

创建 `hello-plugin/cordis.patch.yml`。这个 patch 是一个 YAML 数组，插件行按包名而不是相对源码路径引用这个包，这样 Node 的模块解析才能找到已安装的代码：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

没有 `dsh.bundle` 声明的包是普通依赖，不会激活任何层。如果一个库供插件包 import，而不是作为组装包使用，就使用这种包格式。

### profile manifest

profile 目录包含两个文件：

- `package.json` — profile 的树外插件依赖（由 pnpm 管理），加上 `dsh.profile` manifest 及其有序的 `bundles` 列表。
- `cordis.patch.yml` — 用户自己的 patch 层，在每个组合包层之后应用。

内部 Runtime 配置流程持有 profile 的创建与维护。下一节展示存储格式；公开 CLI 不会创建它。

## 内部 profile 组装

profile 配置属于内部流程。没有受支持的公开命令把组合包安装进 profile 或按名称启动该 profile：

```sh
# No public CLI command installs or boots profiles.
```

内部 profile 记录可以先列出 `@harness-desktop/dsh-base`，再列出声明了 `dsh.bundle` 的组合包：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@harness-desktop/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

组装检查与 profile 启动是内部 app-boot 操作：

```sh
# No public CLI command dumps or boots an internal profile.
```

内部 profile 管理器移除配置层时，必须同时更新依赖与组合包列表。

## 加载顺序

生效配置在空根之上按以下顺序逐层组合：

1. profile 的 `dsh.profile.bundles` 列表所列的各个组合包 patch，按列表顺序——先是 `@harness-desktop/dsh-base`，然后是每个已安装组合包，按其加入顺序。
2. profile 自己的 `cordis.patch.yml`。
3. home 级的 `$HARNESS_HOME/cordis.patch.yml`——内部 profile 共享的机器本地偏好。
4. 内部组装所有者提供的任意 app-boot overlay。

应用参数不是另一层 patch。表层组合包可以通过下文所述的普通应用自有服务解析它们。

后应用的层按行胜出，且 patch 会替换目标行的整个 `config` 值，而不是深度合并各键。这给组合包作者带来两个推论：

- 你的 patch 可以按 `id` 覆盖前面各层的行——就像 [`dsh-web-app` 组合包](../../../../packages/bundle/web-app/cordis.patch.yml)覆盖 `dsh-base` 的行那样——但必须重述该行需要的每一个键，而不是只写改动的那个。
- 内部部署所有者可以在 profile 的 `cordis.patch.yml` 中覆盖这些行，无需改动包，所以应优先给出耐久的配置默认值，其余交给 schema 承担。

内置组合包名称始终从 dsh 安装目录本身解析；pnpm 只管理树外的包，所以你的组合包可以放心依赖 `@harness-desktop/dsh-base` 存在且与安装保持一致。

## 让表层组合包持有自己的命令行

定义了可运行应用的组合包挂载一个普通提供方插件：

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

该插件导出 `inject = ['cmdlineArgs']`，使用自己的 commander program 调用 [`@harness-desktop/dsh-cmdline`](../../../../packages/boot/cmdline/README.md) 中的 `parseCmdline`，再在 program 自己的 action 中把应用自有服务提供出去。启动器把自身 flag 之后的同一份不可变参数交给每个插件，因此添加应用专属 flag 无需修改启动器，多个插件也可以解析该快照。Loader 行不需要启动器标记或特殊类型。

受这些参数配置的行会注入提供方服务，并在自己的 `!!js` 选项中读取它，同时把部署取值写在旁边作为回退：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

遇到 `--help` 时，提供方不会发布该服务，所以这些行不会激活。Loader 只挂载一次组合，等待每一行的普通注入，再基于其已注入的上下文求值该行的 `!!js` 配置。

## 从 GitHub 安装：构建脚本这道坎

内部配置流程可以通过 pnpm 直接从 git 托管安装：

```sh
pnpm add github:you/hello-plugin
```

但 git 安装拉取的是**源码，不是构建产物**：没有任何环节运行你的 `build` 脚本，因此 TypeScript 包到手时没有 `lib/` 输出，加载会失败。必须两边各做一件事：

- **作者**提供一个 `prepare` 脚本——pnpm 在 git 安装后运行它——从源码构建出发布入口，且必须自包含：不能假设仅开发环境才有的上下文，例如旁边有一份 monorepo checkout。[turtle-ui](https://github.com/deepseek-harness/turtle-ui) 是一个可用的例子：它的 `prepare` 运行一份专用的 tsdown 配置，直接转译 `src/`，不用项目引用，也不做类型检查。
- **内部部署所有者**为构建授权。pnpm ≥10 在得到显式允许之前拒绝运行 git 依赖的 `prepare` 脚本，所以第一次 `add` 会失败；请把 pnpm 打印的确切包键复制进内部 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  然后重新执行 `add`。

请如实看待这项授权：**允许该包的代码在安装时于你的机器上执行**，且不在 agent 运行的任何沙箱之内。只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`），让后续推送无法悄悄改变实际运行的内容。

如果不想让用户做这项授权，就改为分发构建产物——以下两种形式都不需要任何构建权限：

- **发布到 npm**，在 `pnpm publish` 时构建好 `lib/`，让内部配置流程获得预构建代码。
- **交付 tarball**：用 `pnpm pack` 为内部包管理器打包。

## 下一步

- [插件与生命周期](../framework/) — 插件的完整生命周期
- [CLI（命令行界面）行为参考](../../../../apps/cli/reference/README.md) — 受支持的交互、run、Web 与 Desktop 语法
