# `@harness-desktop/cli`

English | [中文](README.zh.md)

`harness` is the Harness Desktop product client. `dsh` is a compatible command name with the same grammar and data. [`src/args.ts`](src/args.ts) owns the public command grammar, and [`src/main.ts`](src/main.ts) dispatches both names to the shared local Runtime.

## Quick start

```sh
harness
harness "fix the tests"
harness run "fix the tests" --json
harness web
harness web --background --no-open
harness web --status
harness web --stop
harness desktop
```

## Product commands

| Command | Purpose |
|---|---|
| `harness [task]` | Open an interactive terminal, optionally with one initial task. |
| `harness run <task> [--json]` | Run exactly one task; `--json` emits JSONL protocol records. |
| `harness web [options]` | Open, retain, inspect, or release the shared Runtime Dashboard. |
| `harness desktop` | Select Desktop mode; no arguments are accepted. |
| `dsh <args...>` | Use the same product grammar through the compatible command name. |

The former public profile, plugin-management, headless-profile, patch, and config-dump commands are not part of this product grammar. `--profile` is rejected explicitly. Use `run` for a one-shot task and `web` for the Dashboard.

## Shared Runtime and Web

Interactive, run, and Web modes attach to one local Runtime selected through `HARNESS_HOME`; the invoking directory is the terminal workspace. Closing a CLI attachment does not terminate unrelated clients or active work.

`harness web` starts or attaches to the Runtime and opens the Dashboard by default. `--no-open` suppresses browser dispatch. `--daemon` and `--background` are equivalent requests for the Runtime-owned named `web` lease, not detached per-command Web-child launches. `--status` inspects an existing Runtime without starting one. `--stop` idempotently releases only the named Web lease and preserves the Runtime, other clients, and active work.

Browser opening uses an owner-only temporary HTML document whose POST body contains a one-time handoff; the dispatched local file URL contains neither that handoff nor the Runtime access token. The Runtime client API does not report exchange settlement to the CLI, so a live parent removes the document on dispatch failure or handoff expiry. If the CLI exits first, it transfers the path and existing expiry—not credentials—to a detached plain-Node cleanup helper. The [CLI behavior reference](reference/README.md) owns the complete command and lifecycle details.

## Development

Source execution preserves the `node --import tsx/esm` launcher used by `pnpm harness`; built execution uses `apps/cli/lib/bin.js`. Build package, Web, and Desktop artifacts before testing the installed path:

```sh
pnpm run build
pnpm harness web --status
node apps/cli/lib/bin.js web --status
```
