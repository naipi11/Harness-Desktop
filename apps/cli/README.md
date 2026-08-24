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
harness update
```

## Product commands

| Command | Purpose |
|---|---|
| `harness [task]` | Open an interactive terminal, optionally with one initial task. |
| `harness run <task> [--json]` | Run exactly one task; `--json` emits JSONL protocol records. |
| `harness web [options]` | Open, retain, inspect, or release the shared Runtime Dashboard. |
| `harness desktop` | Select Desktop mode; no arguments are accepted. |
| `harness update` | Print the npm update command for npm installs, or verify and atomically switch a configured standalone archive. It does not create a Runtime or Web lease. |
| `dsh <args...>` | Use the same product grammar through the compatible command name. |

The former public profile, plugin-management, headless-profile, patch, and config-dump commands are not part of this product grammar. `--profile` is rejected explicitly. Use `run` for a one-shot task and `web` for the Dashboard.

## Update

`harness update` and `dsh update` accept no arguments and choose behavior only from the resolved installation layout:

| Installed form | Behavior |
|---|---|
| npm | Only a resolved `node_modules/@harness-desktop/cli` layout qualifies. The command prints `npm update -g @harness-desktop/cli` and exits successfully without running npm or loading a candidate. |
| Standalone ZIP or tar.gz | A resolved entry at `cli/package/<entry>` under a standalone bundle root qualifies; `<entry>` need not be under a `lib` directory. A separately configured distribution may supply audited trust and one candidate source. |
| Source or another layout | The installation is unsupported; the command prints `CLI update failed.` to stderr and exits `1`. |

Current standalone builds supply neither production trust nor a release source. With no configured public key or allowed origin, `update` returns `up-to-date` with code `unconfigured-trust-root`, prints `No update available.`, and exits `0` before candidate I/O or filesystem mutation. A verified candidate whose version is not newer produces the same visible result with code `version-not-newer`.

When a standalone distribution is separately configured, `update` uses the shared signed-manifest policy to select a newer stable CLI target for the current platform and architecture. It verifies the signature, configured exact HTTPS origin, archive digest, exact member set, and executable paths before publishing a random sibling candidate. The transaction retains the current bundle in another random sibling, then runs the candidate's bundled Node executable with `cli/package/lib/bin.js --help`; it never uses Node from `PATH`.

A healthy candidate becomes the live bundle and the retained sibling is removed. A failed health check moves the candidate aside, restores the retained bundle, and reports `rolled-back` only after cleanup succeeds. A failed restore reports `transaction-failed` instead of claiming rollback. The transaction never reads, creates, or modifies `HARNESS_HOME`, and never creates a Runtime or Web lease.

The current standalone settlements are:

| Settlement | Visible output | Exit code |
|---|---|---|
| `up-to-date` (`unconfigured-trust-root` or `version-not-newer`) | `No update available.` on stdout | `0` |
| `applied` | `CLI update applied.` on stdout | `0` |
| `rolled-back` | `CLI update rolled back.` on stderr | `1` |
| `failed` (`candidate-rejected`, `transaction-failed`, or `unsupported-installation`) | `CLI update failed.` on stderr | `1` |

The root [release artifact matrix](../../README.md#desktop-app) owns the packaged platform and native-CI evidence boundary. Passing local checks does not configure production update trust or authorize signing, notarization, publication, upload, or GitHub Release creation.

## Profiles

Profile records remain a legacy/internal app-boot format used by embedders and test fixtures. The shared product Runtime does not load them. This heading preserves existing documentation links; it does not restore a public profile command.

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
