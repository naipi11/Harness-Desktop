# Agent Note: Harness Desktop product topology

Status: proposed

English | [中文](2026-08-15-harness-desktop-product-topology.zh.md)

## Problem

DeepSeek Harness provides a plugin-based agent runtime, browser application, CLI launcher, persistence, and SDK process protocol, but it does not provide one independently branded desktop and terminal product with native distribution across Windows, macOS, and Linux. Adding separate client runtimes would duplicate plugin composition, settings, permissions, session semantics, and model-visible behavior. Running the agent inside the Electron renderer or main process would also couple privileged work to the window lifecycle.

The product needs a desktop application and an interactive CLI that share durable local data without permitting concurrent writers to corrupt one session. It also needs an outward brand and release system that can move away from upstream names without requiring an unsafe one-step migration of installed data.

## Proposal

Harness Desktop uses Electron for the desktop shell and reuses the existing React/Vite client packages. Electron main supervises a complete Harness Host child and communicates through the existing stdio JSON-RPC protocol. Renderer code receives only a versioned preload API and never gains Node.js or credential access.

The `harness` CLI composes the same Harness runtime in its own Node.js process and provides interactive, non-interactive, and JSONL modes. Desktop and CLI share settings, credential references, and session storage. A SQLite-backed session lease service permits concurrent readers, one writer, cooperative takeover, and stale-owner recovery only after proving that the recorded process identity is dead.

The outward product uses Harness Desktop, repository `Harness-Desktop`, command `harness`, application identifier `io.github.naipi11.harness-desktop`, and npm package `@harness-desktop/cli`. The first stable release retains `dsh` as an alias and keeps the existing data layout. Internal upstream-scoped package names remain private during the initial migration, while public artifacts bundle their runtime dependencies.

Desktop releases use Electron Builder, signed native artifacts, GitHub Releases, automatic updates, and rollback metadata. The complete product behavior, platform matrix, security rules, workstreams, and verification requirements are defined in the [Harness Desktop product architecture design](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md).

## Alternatives considered

**Tauri with a Node.js sidecar.** This reduces part of the shell footprint but adds a Rust application, sidecar lifecycle, two dependency toolchains, and additional native signing and packaging interactions. The existing runtime already depends on Node.js, `node-pty`, and native loaders, so Tauri does not remove the Node distribution and increases first-release risk.

**A permanent local service with a thin desktop shell.** A shared daemon makes live multi-client attachment direct, but it requires service installation, port or socket discovery, authentication, version negotiation, idle policy, and upgrade coordination before the local product loop exists. The child-process protocol preserves a later broker path without making a system service a first-release prerequisite.

**Run Harness inside Electron main.** This avoids a child process but lets agent crashes, native module failures, plugin disposal, and terminal teardown affect the window and updater owner. A supervised Host child gives the privileged runtime an explicit protocol and failure boundary while reusing the existing SDK transport.

**Build a separate desktop runtime and CLI runtime.** Client-specific engines could optimize each interface independently, but they would create divergent session, permission, tool, and model behavior. One shared runtime is a product invariant.

## Acceptance criteria

- `apps/desktop` runs a sandboxed renderer through a typed preload API and a supervised Harness Host child.
- `harness` runs interactively in the current directory, while `run --json` provides stdout-pure machine output and stable exit codes.
- Desktop and CLI read the same settings and sessions, reject a second writer, and complete cooperative session takeover without a split brain.
- Source mode supports the installed command graph, including `harness web --background`.
- Windows, macOS, and Linux release jobs install and exercise real desktop and CLI artifacts.
- Stable desktop artifacts are signed, update manifests are verified, and rollback is exercised before release.
- Compatibility names share one implementation and cannot create a second data layout.

## Risks

- Electron produces larger artifacts than a system-WebView shell and requires disciplined renderer isolation.
- A dual-name compatibility period can let old branding persist unless all user-visible strings come from centralized product metadata.
- Cross-process session leases require process-start identity and transaction ordering to avoid PID reuse and split-brain recovery.
- Native credential stores and signing identities differ by platform; missing secure integration must fail rather than fall back to plaintext.
- Bundled standalone CLI archives increase release size but avoid untested system Node.js and native-module combinations.
