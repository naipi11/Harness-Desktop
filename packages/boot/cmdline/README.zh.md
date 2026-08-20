# `@harness-desktop/dsh-cmdline`

[English](README.md) | 中文

内部 app-boot 组装交给所启动应用的命令快照。内部组装所有者可以提供应用专属参数，让应用持有自身帮助与解析错误。公开 `dsh` 产品解析器不提供任意参数透传、profile flag、overlay 或配置 dump。

## 启动器提供的值

启动器在任何配置树条目挂载之前调用 `provideCmdline(ctx, host)`，它提供：

- `ctx.cmdlineArgs`：内部组装的应用参数。`get()` 是完整接口并返回不可变快照；该服务不表示公开产品解析器会接受任意应用 flag。
- `ctx.appExit`：一个有边界的进程退出请求，接到启动器的关停控制器上。

没有命令行的嵌入宿主提供空列表；这是诚实的答案，而不是缺失的值。

## 普通提供方与注入配置

任何应用插件都可以注入 `cmdlineArgs`、解析它，再发布一个普通的应用自有服务。`parseCmdline(ctx, program)` 只适配 commander；校验与发布的服务都归 program 自己的 action 持有：

```ts ignore
export const name = 'web-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => ctx.provide('webStartup', webValuesFrom(program)))
  parseCmdline(ctx, program)
}
```

它的 Loader 行不携带启动器标记，也没有特殊类型：

```yaml
- id: web-startup
  name: '@harness-desktop/dsh-web-app/startup'
```

所有由这些取值配置的行都使用普通服务注入，并在惰性配置中直接访问该服务：

```yaml
- id: webserver
  name: '@harness-desktop/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

`parseCmdline` 在加载时拒绝整棵命令树中没有任何命令声明 action 的 program，把每个命令的退出与输出都接到启动器上（commander 只在注册时把这些设置复制进子命令），再解析不可变参数；解析成功时 commander 运行被调用命令的同步 action。action 用 `program.error(...)` 拒绝无效调用——必须先拒绝后发布，因为写在拒绝之前的语句已经执行。遇到 `--help`、`--version`、解析错误或这种拒绝时，该适配器输出 commander 文本并请求退出；提供方什么也不发布，因此依赖行不会激活。

### 注入如何排列配置求值

Loader 会把一行的 `!!js` 插值推迟到该行声明的注入全部激活之后，再基于该行的插件上下文求值。所以上例可以直接读取 `ctx.webStartup`：Loader 索取 `webserver` 的配置之前，Cordis 已经填入了这个注入服务。Include 树会保留嵌套表达式节点，直到各个目标行到达这一时点。提供方替换与活动 patch 重载都会针对当前注入服务重新插值，因此启动 flag 不会被悄悄重置。

### 共享不可变参数

`get()` 不会消费或修改 argv。多个插件可以解析同一份内部快照，并分别提供服务。app-boot 不会检查内部组装中的命令行所有者；没有读取方的组装只会忽略自己的应用参数。

树外插件会带来自己的一份 commander 副本，因此 commander 的控制流错误按结构识别，而不是按类身份识别；按身份判断会把已经打印出来的 help 重新抛成致命的加载失败。

## 模型体验

无。本包在任何会话存在之前解析进程自身的命令行。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **内部组装所有者在启动前提供完整快照**：产品调用方使用已记录的交互、run、Web 或 Desktop 语法；未知公开 flag 会被拒绝，而不是转发到这里。
- **应用自有服务没有静态声明的提供方**：消费行通过普通注入点名它；缺少提供方的组合包会在结算时失败，由待处理条目点名该服务，而不是在加载时失败。
- **用户 patch 若整体替换某行的 `config`，会连同其中的表达式一起丢掉**：flag 胜过的是表达式旁写着的那个值，而不是用户用字面量替换掉表达式之后的结果；保留表达式才能保留 flag 的优先级。
