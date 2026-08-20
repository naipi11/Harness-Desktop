# Agent Note: Harness Desktop product topology

Status: implemented

English | [中文](2026-08-15-harness-desktop-product-topology.zh.md)

## Problem

DeepSeek Harness provides a plugin-based agent runtime, browser application, CLI launcher, persistence, and SDK process protocol. Giving each product client its own runtime would duplicate plugin composition, settings, permissions, session semantics, and model-visible behavior. Hosting privileged agent work inside an Electron process would also couple that work to a window and updater lifecycle.

Desktop, Web, and terminal presentation plans need one local data owner without permitting concurrent writers to split a session. The ownership layer also needs independent process recovery and a private browser-authentication path that does not expose a native endpoint credential to browser code.

## Decision

[`@harness-desktop/dsh-host-local-runtime`](../../../../packages/host/local-runtime/README.md) implements one on-demand local Runtime for each `HARNESS_HOME`. That Runtime owns the canonical Cordis composition, persistence providers, credential references, authenticated local API, session-writer admission, endpoint record, and idle lifetime. It is the only process that writes Harness-owned state under the selected home.

The Runtime binds an operating-system-assigned port on `127.0.0.1`. Its owner lock records both PID and process-start identity, and stale recovery replaces a record only after proving the exact recorded identity absent. Its private endpoint record is readable only by the current operating-system user and carries the token used by native control.

The public `RuntimeConnector` retains endpoint discovery and the token inside authenticated request closures. A Dashboard attachment converts native authority into a 60-second single-use form-body handoff and then a cookie-only exact-origin browser session. Endpoint tokens, handoffs, session credentials, the selected Harness home, credential values, and raw filesystem errors remain outside public values and browser script storage.

The public `RuntimeClient`, `TerminalConnection`, and `DashboardAttachment` APIs provide independent attachments over the same process. Per-session writer admission, owner-scoped cancellation, active-work accounting, migration transactions, and the stable `web` background lease all retain the Runtime through their exact operation. Ordered shutdown settles control work and durable flushes before endpoint retirement, lock release, and Cordis disposal.

The foundation boots the same complete base-and-Web composition from its declared built binary and direct source entry. Terminal, Web, and Desktop presentation work consumes this public API as separate product layers; foundation acceptance does not represent those presentation clients or cross-client product acceptance as shipped.

The complete current Runtime contract lives in the [package README](../../../../packages/host/local-runtime/README.md). The broader product and release constraints remain in the [Harness Desktop product architecture design](../../../../docs/superpowers/specs/2026-08-15-harness-desktop-design.md), while the [unified local Runtime design](../../../../docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md) maps this decision to the current foundation.

## Alternatives considered

**Tauri with a Node.js sidecar.** This reduces part of the shell footprint but adds a Rust application, sidecar lifecycle, two dependency toolchains, and more native signing and packaging interactions. The runtime still depends on Node.js, `node-pty`, and native loaders, so Tauri does not remove the Node distribution.

**A desktop-owned Host child with a standalone CLI runtime.** This gives the desktop shell a private child but makes browser and terminal clients discover and mutate separate runtime instances. It cannot provide all clients one writer, one token-protected API, or one session view.

**Run Harness inside Electron main.** This removes one process connection but lets agent crashes, native module failures, plugin disposal, and terminal teardown affect the window and updater owner. A separate Runtime gives privileged work an independent lifecycle.

**Build a separate desktop runtime and CLI runtime.** Client-specific engines can optimize each interface independently, but they create divergent session, permission, tool, and model behavior. One shared Runtime keeps those semantics in one owner.

## Consequences

- One `HARNESS_HOME`, one process identity lock, and one injected home provider define the persistence ownership unit. Clients cannot bypass the Runtime without violating the product topology.
- The loopback endpoint and body-only handoff add private-file, origin, cookie, cleanup, and response-validation obligations, but browser code never receives native authority.
- Attachments and leases make client exit independent from active work, while idle shutdown requires explicit accounting and ordered quiescence.
- [Package-owned evidence tiers](../../../../packages/host/local-runtime/README.md#source-and-built-entry-points) separately pin the built full-product composition and public connector/control, the declared source bin's Loader/module/endpoint lifecycle with required generated artifacts, and source connector/control through an explicit backend fixture. CLI, Web, Desktop, packaging, and cross-client presentation acceptance remain downstream work.
- User-skill admission still has a cross-package interval between API catalog admission and pre-step definition loading. The foundation records that follow-up rather than claiming a universal fail-closed guarantee.
