# `harness` CLI behavior reference

English | [中文](README.zh.md)

This reference defines the public product grammar shared by `harness` and `dsh`. [`src/args.ts`](../src/args.ts) parses argv once, and [`src/main.ts`](../src/main.ts) dispatches the resulting mode to explicit Runtime, browser, and terminal dependencies.

## Grammar

| Mode | Syntax | Result |
|---|---|---|
| Interactive | `harness [task]` | Open a terminal, optionally admitting one initial task. |
| Run | `harness run <task> [--json]` | Execute exactly one task through the terminal protocol. |
| Web | `harness web [options]` | Open, retain, inspect, or release the Runtime Dashboard. |
| Desktop | `harness desktop` | Select Desktop mode with no arguments. |

`dsh` accepts the same syntax and reports its own command name in help and corrections. `-h`/`--help` and `-V`/`--version` are product options. Unknown options and arguments from another mode are usage errors.

The public parser has no profile, plugin-management, headless-profile, patch, or config-dump mode. In particular, any `--profile` form is rejected before dispatch. The former profile-era commands are not compatibility syntax.

### Interactive

No arguments opens an interactive terminal. One positional argument is admitted as the initial task. More than one positional argument or any product option not owned by this mode is rejected. The invoking directory is the workspace sent to the shared Runtime.

### Run

`run` requires exactly one task. `--json` may appear once and selects newline-delimited protocol output; without it, the CLI renders the terminal event stream. The CLI closes its terminal and base Runtime attachments after the operation settles.

### Web

```sh
harness web
harness web --open
harness web --no-open
harness web --background --no-open
harness web --status
harness web --stop
```

An open operation starts or attaches to the shared local Runtime. Browser dispatch is enabled by default; `--open` states that default and `--no-open` suppresses it. `--daemon` and `--background` are equivalent requests for the Runtime-owned named `web` lease and may be combined with either browser choice. They do not create a detached per-command Web child, PID record, or child log.

For a browser open, the Runtime mints a one-time handoff and returns a clean loopback Dashboard origin plus its expiry. The CLI writes the handoff only into the POST body of an owner-only temporary HTML document. The dispatched local file URL contains neither the handoff nor the Runtime access token.

The Runtime client API exposes no handoff-exchange settlement to the CLI. While the CLI remains alive, dispatch failure removes the document immediately and handoff expiry removes it through the same memoized operation. On natural CLI exit before expiry, ownership transfers to a detached helper launched through plain Node with only the document path and expiry. The parent detaches only after an exact IPC ready message confirms validation and a referenced expiry timer; pre-ready error, exit, disconnect, or timeout re-refs the parent timer. The helper receives no inherited Node loader/eval arguments, handoff, access token, or inherited environment, and removes the document at the original expiry.

`--status` connects only to an existing Runtime and prints its Runtime identity, Dashboard origin, and named Web lease state. A missing Runtime produces a nonzero result without creating `$HARNESS_HOME`. `--stop` also requires an existing Runtime and idempotently releases only the named Web lease. It does not terminate the Runtime, close other clients, or cancel active work. `--status` and `--stop` cannot be combined with a background-lease option and never open a browser.

### Desktop

`desktop` accepts no arguments and selects the Desktop product mode. It does not create terminal or Web Runtime attachments.

## Runtime behavior

The CLI resolves the local Runtime through `HARNESS_HOME`. Interactive, run, and Web invocations attach as clients; the Runtime owns its endpoint, sessions, background lease, and active operations. Releasing one CLI attachment never grants it ownership over unrelated clients or work.

Product-grammar failures exit 2 with a corrective syntax line. A Web operation that cannot find or reach its required Runtime uses the Runtime-unavailable exit path; other local Web failures use the generic local-failure path. Diagnostics are normalized and never reflect a handoff, endpoint token, or raw private cause.

## Source execution

The repository scripts launch source through `node --import tsx/esm` and preserve that launcher for Runtime process starts. Installed commands run the built bins under plain Node. The detached browser-cleanup helper is a standalone `.mjs` file and deliberately inherits neither source loader arguments nor eval code.

```sh
pnpm run build
pnpm harness run "check the workspace" --json
node apps/cli/lib/bin.js run "check the workspace" --json
```
