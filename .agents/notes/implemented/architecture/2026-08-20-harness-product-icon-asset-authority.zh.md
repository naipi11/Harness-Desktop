# Agent Note: Harness 产品图标资源权威

Status: implemented

[English](2026-08-20-harness-product-icon-asset-authority.md) | 中文

## 问题

桌面可执行文件、Linux 启动器、浏览器界面和安装后的 Web 应用需要不同的图标格式与尺寸。若分别维护可编辑输入或手工维护的输入，这些身份会发生漂移，二进制资源的来源也会变得不明确，并且某个平台可以绕过其他产品界面使用的权威图稿而单独替换图标。

原生端小图标也无法保留应用和 Web 尺寸下仍然清晰的全部细节。原生端浅色、深色变体会在没有跨平台选择机制的情况下增加一条身份维度，而浏览器 favicon 已有明确的配色方案机制。

## 决策

[`assets/brand/harness-icon.svg`](../../../../assets/brand/harness-icon.svg) 是唯一可编辑的产品图标权威。它包含仓库自有的原创 B 方向图稿：一只圆润的蓝紫色小鲸鱼，带有柔粉色高光和三星轨迹。产品图标图稿不得复制 DeepSeek 或第三方角色、标志、源图稿及其他可识别资源，也不得由它们衍生。

[`scripts/generate-product-icons.ts`](../../../../scripts/generate-product-icons.ts) 是所有原生端和 Web 端派生资源的唯一写入者。生成的 SVG、PNG、ICO、ICNS 和 favicon 文件一律不得直接编辑。32 px 及以下的渲染选择 `mark-compact`，保留鲸鱼轮廓和一颗星；大于 32 px 的渲染选择 `mark-full`，保留三星轨迹。

`pnpm run generate:icons` 从权威文件替换每一项已声明的派生资源。`pnpm run verify:icons` 在内存中构建相同的预期字节，为每个缺失或 stale 的仓库相对路径报告稳定的修复方式，并且不执行写入。路径从生成器模块所在的仓库根目录解析，而不是从调用目录解析，因此命令执行位置无法改变输出归属。

原生平台使用一套颜色安全的资源。只有 `apps/web/public/favicon.svg` 包含生成的浅色、深色 `prefers-color-scheme` 图稿。[Web 安装 manifest 决策](../feature/2026-08-06-web-install-manifest.md)使用生成的 192 px、512 px 和 maskable 512 px PNG，但不会获得第二份图稿权威。

生成器为不同格式角色使用根目录开发依赖：`sharp` 从 SVG 渲染显式尺寸的 sRGB PNG，`png-to-ico` 组装 Windows 所需帧，`@fiahfy/icns` 组装 macOS 所需表示。在 `package.json` 和 `pnpm-lock.yaml` 中固定这些库，使跨平台生成实现进入仓库依赖图，而不依赖操作者自行安装的图像工具。

## 验证

`scripts/generate-product-icons.spec.ts` 在临时仓库根目录下运行生成流程，并固定权威文件的 ID 和令牌、compact/full 选择、可见且符合声明的 PNG 尺寸、不透明 maskable 输出、Windows 和 macOS 表示端点、生成 SVG 的标记、favicon 媒体查询以及只读漂移诊断。`apps/web/tests/pwa-manifest.e2e.ts` 固定构建后 Web 应用中的生成路径、尺寸、MIME 类型、maskable 用途、源标记和 favicon 的两种主题选择器。

依次运行 `pnpm run generate:icons`、生成器与 Web 的聚焦测试以及 `pnpm run verify:icons`，构成源码层验收路径。`verify:icons` 返回干净结果，证明提交资源与当前权威文件及依赖版本字节一致；它不能替代使用这些文件的平台原生打包检查。

## 曾考虑的替代方案

**手工维护各平台资源。** 不予采纳，因为分散的可编辑二进制文件会掩盖哪份图稿是权威，并允许某个平台在不修改权威 SVG 的情况下发生漂移。

**通过 shell 调用平台图像工具。** 不予采纳，因为工具是否存在及其版本都取决于宿主环境，Windows、macOS 和 Linux 贡献者无法执行同一条依赖已固定的路径。

**在仓库代码中实现 ICO 和 ICNS 容器。** 不予采纳，因为格式库能删除自有的二进制编码代码及其兼容性负担，同时仍由仓库生成器拥有源文件选择和漂移策略。

**发布原生端浅色、深色图标集。** 不予采纳，因为原生打包器只使用一个图标路径，并且没有共享的运行时选择约定。favicon 是唯一感知主题的输出，因为浏览器为该界面定义了 `prefers-color-scheme`。

## 后果

修改一份 SVG 并运行一次生成器即可更新所有产品图标消费方，差异也能区分人工编写的矢量改动和确定性派生资源。直接修改任何生成文件都会使 `verify:icons` 将其报告为 stale。

仓库需要携带生成的二进制文件和三个根目录开发依赖。升级依赖或更换渲染器可能改变已提交字节，因此这类升级需要有意重新生成资源、目视检查 compact 和 full 标记，并检查产生的二进制差异。

compact 标记舍弃两颗星和精细细节，以保留小尺寸下的识别度。原生图标舍弃自动调色板切换；favicon 保留这一行为，同时不会增加原生打包输入。
