# dsh-credentials-platform

[English](README.md) | 中文

仅限 Runtime 的 [凭据](../credentials/README.md) 提供方：harness home 只持久化不透明引用，每个机密值都在每次请求时从平台适配器解析。默认适配器读取启动器冻结的进程环境且只读；由 Desktop 宿主提供的可写适配器拥有持久机密存储（钥匙串或平台保险库），本包绝不向其写入值。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `harnessHome` | 必需 | 引用元数据文档所在的绝对 harness home。 |
| `adapter` | 环境适配器 | 解析值的平台适配器；省略时使用只读环境适配器。 |

## 元数据文档

`$HARNESS_HOME/.credential-references.json` 记录哪些引用已配置：

```json
{
  "version": 1,
  "references": [
    "DEEPSEEK_API_KEY"
  ]
}
```

该文档是严格的 version-1 结构：一个 `version` 加上一个已排序的 `references` 数组，没有其他内容。它只持有不透明的引用名称——机密值绝不会出现在其中、命令行、日志或诊断信息里。写入通过 [`dsh-atomic-write`](../../util/atomic-write/README.md) 在仅所有者（`0700`）目录下以 `0600` 模式原子持久化。

## 环境适配器

未注入适配器时，值来自启动器冻结的进程环境（与 [launch-environment](../../util/launch-environment/README.md) 提供的快照相同），空值视为缺失，且适配器只读：`set` 和 `unset` 会拒绝，因为进程环境无法从内部编辑。`describe()` 报告 `source: 'env', writable: false`。

## 安全边界

值绝不进入本包写入的文件，因此引用元数据不是包含机密的文档。适配器是唯一的值持有者：只读环境快照，或模型工具进程无法读取的可写平台存储。通过可写适配器存储引用会把值持久化到该存储，并把引用名加入元数据文档。

## 已知限制与暂缓事项

- **环境变化不可见** — 快照在启动时冻结，因此启动后导出的变量既不会到达解析，也不会到达 `describe`；更改来自环境的凭据需要重启。
- **环境适配器只读** — 它无法存储密钥；Models 页面写入路径需要 Desktop 宿主注入可写平台适配器。
- **无热重载** — 不监听元数据文档的外部更改；读取始终经过适配器，因此值在每次请求时保持最新。
- **OS 钥匙串适配器暂缓** — 平台保险库是预期的可写存储；适配器 seam 已存在，具体提供方属于未来工作。
