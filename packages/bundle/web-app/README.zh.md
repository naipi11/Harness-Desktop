# `@harness-desktop/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：设置 coding persona，插入 Web 宿主行（webserver、API 网关、workspace、投影缓存、存储）与浏览器插件名录，挂载始终启用的客户端插件重载链（[`dsh-client-hmr`](../../client/hmr/README.md)），并挂载本包的 `web-runtime` 粘合插件（配置为 `{printUrl, surfaceContext, trustedHosts}`）。该插件解析已构建的前端 dist，提供内部 Web 运行时状态，挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退所有者，并按配置注册 Web 提示词与 `DSH_WEB_URL` 贡献。`web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）仍通过 [`dsh-cmdline`](../../boot/cmdline/README.md) 为内部 app-boot 组装与测试解析 host、port、trusted-host 和 help 参数。公开产品解析器不会转发这些选项：`dsh web` 连接共享 Runtime，且只接受已记录的 open、lease、status 与 stop 选项。[`dsh-headless`](../headless/README.md) 是同一 base 之上的内部同级表层，不挂载本组合包。

CLI 会先消费仅用于 Web 的 `--daemon` 和 `--background` 别名，再向本组合包提供清理后的参数。因此 `web-startup` 仍拥有 host、port、trusted-host 和 help 的解析；其 `--help` 路径不会启动服务器。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。
