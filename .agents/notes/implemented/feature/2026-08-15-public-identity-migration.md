# Agent Note: Harness Desktop public identity

Status: implemented

English | [中文](2026-08-15-public-identity-migration.zh.md)

## Problem

The repository and its outward surfaces still identify as DeepSeek Harness after the project became its own product. Model-visible identity, installation prose, the Web title and manifest, the website lockup, and badge output each carry the old name and repository URL in separate owning sources, so drift is easy and a shared verifier is needed.

## Decision

The repository is the `naipi11/Harness-Desktop` fork, with Harness Desktop as the product name and `harness` as the primary command. The transition package remains published as `@deepseek-ai/dsh`; `dsh` stays a compatible command name with the same data and profile layout. `scripts/product-identity.ts` collects exact owner/value pairs (root README, CLI manifest, Web HTML and manifest, website config, agent preset), and `verify:product-identity` fails on drift. Installation, reference, Web, website, badge, attribution, and snapshot sources render Harness Desktop and the renamed repository URL; `$DSH_HOME`, `dsh.profile`, internal `@deepseek-ai/dsh-*` package identifiers, and storage names remain unchanged.

## Alternatives considered

**A new npm scope with a full package rename.** Rejected. No `@harness-desktop/cli` is published in this workstream; keeping `@deepseek-ai/dsh` as the transition package preserves existing installs and data layout while the product name changes.

**A final logo asset.** Rejected. The website replaces the DeepSeek wordmark lockup with a text Harness Desktop lockup; inventing a logo would be a design decision outside this migration.

## Consequences

Public and model-visible surfaces use Harness Desktop, `harness`, and `naipi11/Harness-Desktop`; the verifier pins them so future changes need an intentional update of the owning sources. Compatibility prose documents `npx --package @deepseek-ai/dsh harness web` and the retained `dsh` alias. Keyless snapshots for badge, web-daemon, Web UI, and translation prompts were refreshed only where the outward product name or primary command renders.