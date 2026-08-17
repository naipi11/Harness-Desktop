# Agent Note: CLI publishes as @harness-desktop/cli

Status: implemented

English | [中文](2026-08-17-harness-desktop-cli-npm-package.zh.md)

## Problem

The installable CLI still shipped as `@deepseek-ai/dsh`, so users were told to run `npx --package @deepseek-ai/dsh harness web` or `dsh web`. After the product became its own project, the primary `harness` command had no first-class npm package, and the transition identity recorded in the [public-identity note](2026-08-15-public-identity-migration.md) could not survive the product split.

## Decision

The CLI package name is `@harness-desktop/cli`, published publicly and installed globally with `npm install -g @harness-desktop/cli`; both `harness` and `dsh` bin names stay available with the same profile and data layout. `apps/cli/package.json` owns the name and bins; release tooling (`scripts/release/families.ts`, `scripts/check-workspace-constraints.ts`, `scripts/publish-npm-baseline.ts`, `scripts/verify-dsh-package-licenses.ts`) accepts the `@harness-desktop/` scope for the CLI entry package while the internal `@deepseek-ai/dsh-*` library identifiers remain unchanged. Root and CLI READMEs install from the new package and document `harness` as the primary command. This supersedes the public-identity note's rejected alternative, which declined a new npm scope at that time.

## Alternatives considered

**Keep publishing `@deepseek-ai/dsh` as the transition package.** Rejected. It contradicts the product split and forces users to keep the upstream name and `npx` indirection; data and profile layout compatibility is preserved through the retained `dsh` bin alias instead.

**Rename every `@deepseek-ai/dsh-*` library package to `@harness-desktop/*`.** Rejected. The CLI entry package is the only user-installed artifact; renaming the full workspace would churn every import, lockfile, and vendored reference with no user-facing benefit.

## Consequences

New users install `@harness-desktop/cli` and run `harness` (or `dsh`); existing `$DSH_HOME` profiles and `dsh` invocations keep working. The npm publish family must publish the CLI alongside the `@deepseek-ai/dsh-*` packages it depends on, so a publish is an all-family release rather than a single package. Publishing `@harness-desktop/cli` requires the `@harness-desktop` npm scope to exist and the registry token to have access to it.