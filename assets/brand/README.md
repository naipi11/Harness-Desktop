# Harness brand assets

English | [中文](README.zh.md)

`harness-icon.svg` is the editable authority for the Harness product icon. It contains original repository-owned artwork and defines `--whale-primary`, `--whale-shadow`, `--whale-highlight`, `--star`, and `--background` as its color tokens.

The generator uses `mark-compact` at 16 px and 32 px, and `mark-full` at 64 px and larger. Run `pnpm run generate:icons` from any directory in the repository to replace the native and Web derivatives, then run `pnpm run verify:icons` to check for drift.

Generated icon files are replaced only by `scripts/generate-product-icons.ts`; do not edit them directly.
