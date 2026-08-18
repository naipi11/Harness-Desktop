# Agent Note: Harness Desktop product topology

Status: proposed

English | [中文](2026-08-15-harness-desktop-product-topology.zh.md)

## Problem

DeepSeek Harness provides a plugin-based agent runtime, browser application, CLI launcher, persistence, and SDK process protocol, but it does not provide one independently branded desktop, browser, and terminal product with native distribution across Windows, macOS, and Linux. Letting each client own its own runtime would duplicate plugin composition, settings, permissions, session semantics, and model-visible behavior. Running the agent inside the Electron renderer or main process would also couple privileged work to the window lifecycle.

The product needs desktop, Web, and terminal clients that share one local data root without permitting concurrent writers to corrupt one session. It also needs an outward brand and release system that can move away from upstream names without requiring an unsafe one-step migration of installed data.

## Proposal

Harness Desktop uses an on-demand per-user local Runtime for every `HARNESS_HOME`. The Runtime owns the Harness plugin composition, persistence, credential references, local API, session writer ordering, endpoint record, and idle lifetime. It binds only a random `127.0.0.1` port. Native CLI launchers and Electron main use its endpoint token; a browser Dashboard exchanges a one-time 60-second fragment handoff for an `HttpOnly; SameSite=Strict; Path=/` cookie, while the renderer receives neither secret. An atomic lock with process-start identity protects stale-state recovery.

Electron provides the desktop shell and reuses the existing React/Vite Dashboard. Its main process starts or attaches to the Runtime, while the sandboxed renderer receives only a versioned preload API for native operations and recovery diagnostics. The renderer never gains Node.js, credential, data-root, token, or child-process access.

The `harness` terminal client, `harness web` Dashboard launcher, and `harness desktop` application launcher each start or attach to the same Runtime. They provide interactive, non-interactive, JSONL, browser, and desktop flows without directly writing state. The session writer service permits concurrent reads, one writer, cooperative takeover, and stale-owner recovery only after proving that the recorded process identity is dead.

`harness web --daemon` and `harness web --background` create the same explicit Runtime lease. `harness web --status` reports the redacted state of an existing Runtime without starting one, and `harness web --stop` releases only that lease without cancelling work or disconnecting other clients.

The outward product uses Harness Desktop, repository `Harness-Desktop`, command `harness`, application identifier `io.github.naipi11.harness-desktop`, and npm package `@harness-desktop/cli`. The first stable release retains `dsh` as an alias and offers a copy-only legacy `DSH_HOME` import. Internal upstream-scoped package names remain private during the initial migration, while public artifacts bundle their runtime dependencies.

Desktop releases use Electron Builder, signed native artifacts, GitHub Releases, automatic updates, and rollback metadata. The complete Runtime behavior, public commands, security rules, and verification requirements are defined in the [Harness unified local Runtime design](../../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md); the broader product and release constraints remain in the [Harness Desktop product architecture design](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md).

## Alternatives considered

**Tauri with a Node.js sidecar.** This reduces part of the shell footprint but adds a Rust application, sidecar lifecycle, two dependency toolchains, and additional native signing and packaging interactions. The existing runtime already depends on Node.js, `node-pty`, and native loaders, so Tauri does not remove the Node distribution and increases first-release risk.

**A desktop-owned Host child with a standalone CLI runtime.** This simplifies the first desktop shell but makes the Browser and terminal clients discover and mutate separate runtime instances. It cannot give all three clients one writer, one token-protected API, or one session view, so an on-demand local Runtime replaces it.

**Run Harness inside Electron main.** This avoids a Runtime connection but lets agent crashes, native module failures, plugin disposal, and terminal teardown affect the window and updater owner. A separate Runtime gives privileged work an explicit lifecycle while the desktop client can recover or exit independently.

**Build a separate desktop runtime and CLI runtime.** Client-specific engines could optimize each interface independently, but they would create divergent session, permission, tool, and model behavior. One shared runtime is a product invariant.

## Acceptance criteria

- The local Runtime owns one `HARNESS_HOME`, binds loopback only, limits its endpoint token to native launchers, gives the browser Dashboard a one-time handoff and cookie session, and removes stale ownership only after process-identity verification.
- `apps/desktop` runs the real Dashboard in a sandboxed renderer through a typed preload API and attaches to the Runtime.
- `harness` runs interactively in the current directory, while `run --json` provides stdout-pure machine output and stable exit codes.
- Desktop, Web, and CLI read the same settings and sessions, reject a second writer, and complete cooperative session takeover without a split brain.
- Source mode supports the installed command graph, including `harness web --background`, `harness web --status`, `harness web --stop`, and `harness desktop`.
- Windows, macOS, and Linux release jobs install and exercise real desktop and CLI artifacts.
- Compatibility names share one implementation and cannot create a second data layout.

## Risks

- Electron produces larger artifacts than a system-WebView shell and requires disciplined renderer isolation.
- A dual-name compatibility period can let old branding persist unless all user-visible strings come from centralized product metadata.
- Runtime endpoint and session ownership recovery require process-start identity and transaction ordering to avoid PID reuse and split-brain recovery.
- Native credential stores and signing identities differ by platform; missing secure integration must fail rather than fall back to plaintext.
- Bundled standalone CLI archives increase release size but avoid untested system Node.js and native-module combinations.
