# @harness-desktop/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(el, seams?).run()` mounts the whole client through the two-stage boot (web2). Stage one (module face): build the client module system (`@harness-desktop/dsh-client-modules`) over the host-pushed entry graph (`window.__DSH_BOOT__`) and prefetch the `immediately` tier in parallel — bundle execution registers factories only. Stage two (plugin face): mount the vendored cordis Loader with the module system injected through its `internal` contract, create one loader entry per graph row plus the shell-own app-shell assembly entry (tree.import materializes each module), and gate AppRoot on the settle (loader quiesced + every entry fiber ACTIVE → full UI in one switch). `run()` resolves `true` only after that settle; a plugin-boot failure renders the owned failure report and resolves `false`, while a missing or malformed manifest rejects. Composition is entirely the host graph's: the roster and the immediately tier live in the composing app; the shell makes zero composition decisions.

Shell self-sufficiency (web2 hard rule): the kernel value-imports no plugin package — the boot status store and signals are hand-rolled here (`loader-status.ts`), so the loading page works while (and especially when) plugins fail. The app-shell assembly (`@harness-desktop/dsh-client-app-shell`, a shell-owned pseudo entry with no npm package behind it) is the only module registered through `registerStatic`; it inject-waits on slots, sessions, workspaces, and layout like any plugin.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shared modules: seed-table keys, tsdown client externals, and the Vite alias set are its projections.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

The shell owns browser-title projection. With a selected session carrying a durable title, it renders `<session title> — <existing HTML title>` and reacts to later title revisions; no selection or a selected untitled session preserves the existing title, and shell unmount restores it. The existing HTML title remains the configurable product suffix.

The settled Dashboard mounts an engineering workbench around the ordinary root slot. Its five stable panels are Files, Diff, Terminal, Artifacts, and Tasks. Files and file actions use the authenticated Workspace service; Diff and Terminal read the selected Session snapshot; Artifacts reads the deliverables plugin's completed-Turn projection at each closing Assistant boundary; Tasks reads the `todos` Session projection. Focus mode removes only the surrounding root-slot chrome and retains the selected Session and connection.

Runtime active-work controls use the same HttpOnly-cookie authentication as the Dashboard API. The authenticated unary carrier reserves ownership before `session.prompt`, correlates the published user message by `rpcId`, and releases rejected and command-only admissions immediately. Accepted turns remain owner-scoped until their exact `turn/end`; the workbench refreshes after prompt actions and polls active ownership for at most 30 seconds. Neither the workbench nor its ready marker reads or exposes the cookie, handoff, endpoint token, Runtime home, or Electron bridge.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for the boot settle; a single entry failure keeps the loading page with a loud per-entry report, no partial availability (progressive rendering returns with its own project).
- **Narrow-window shell behavior lacks an assembled walkthrough** — ui-layout implements the concession chain, but this package has no shell-level narrow-viewport acceptance case.
- **The in-process Web e2e scaffold has no native Runtime client** — it uses a same-origin Dashboard-control shim to boot the real built `AppWebEntry`/Loader graph. `dashboard-ready.e2e.ts` separately proves the production handoff and HttpOnly-cookie sequence, and the real Runtime process suite proves cookie-owner prompt admission and stop.
