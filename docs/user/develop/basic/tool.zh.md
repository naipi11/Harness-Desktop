# 内部工具格式参考

[English](tool.md) | 中文

这是内部工具格式参考，不是可运行的公开 Web 教程。它扩展[内部插件格式参考](./)中的 scratch 插件；产品 CLI 无法加载该 overlay。

## 创建工具插件

将 `scratch-plugin/src/my-plugin.ts` 替换为：

```ts
import type { Context } from '@harness-desktop/cordis'
import { defineTool } from '@harness-desktop/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

`inject` 让 Cordis 等待工具注册表就绪。`defineTool` 根据 `parameters` 推导并校验 `args`；`execute` 返回 `output.schema` 声明的规范值，`output.render` 再将该值转换为面向模型的内容。

## 运行并调用工具

公开 CLI 无法重新启动这个 scratch overlay。请通过内部 app-boot 测试组装运行它：

```sh
pnpm exec vitest run packages/core/tools/tests/tools.spec.ts -t "registers tools"
```

该验收测试会验证工具注册、schema 与面向模型的提示词组装。它不会加载这个 scratch `greet` 实现，也不承诺公开 Web endpoint。

## 下一步

- [插件配置](./config.md) — 让问候语可配置。
- [工具编写参考](../../../cookbook/adding-a-tool.md) — 查阅嵌套 schema、规范值、后台工作、策略钩子、Code Mode 和 UI 卡片。
- [能力分层](../practice/) — 将可替换能力拆分为 Service Definition、Service Provider 和 Consumer 三类包。
