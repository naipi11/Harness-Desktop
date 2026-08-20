# Harness 品牌资源

[English](README.md) | 中文

`harness-icon.svg` 是 Harness 产品图标的可编辑真源。它包含仓库自有的原创图稿，并将 `--whale-primary`、`--whale-shadow`、`--whale-highlight`、`--star` 和 `--background` 定义为颜色令牌。

生成器在 16 px 和 32 px 使用 `mark-compact`，在 64 px 及以上使用 `mark-full`。在仓库内的任意目录运行 `pnpm run generate:icons` 可替换原生端和 Web 端的派生资源，随后运行 `pnpm run verify:icons` 检查漂移。

生成的图标文件只能由 `scripts/generate-product-icons.ts` 替换；请勿直接编辑这些文件。
