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
| Standalone archive | A resolved entry at `payload/current/cli/package/lib/<entry>` under the fixed launcher root qualifies. Windows releases use ZIP; macOS and Linux releases use tar.gz to preserve executable modes. Every release bundle embeds audited public trust, an exact candidate source, and a rollback source keyed to its current version. |
| Source or another layout | The installation is unsupported; the command prints `CLI update failed.` to stderr and exits `1`. |

The source tree does not supply production trust or a release source. A standalone bundle whose embedded public policy is absent or invalid reports `unconfigured-update-source`, performs no candidate I/O or filesystem mutation, and exits `1`. A verified candidate whose version is not newer prints `No update available.` and exits `0` with code `version-not-newer`.

With an embedded public policy, `update` uses the shared signed-manifest policy to select the newer stable archive for its host—ZIP on Windows and tar.gz on macOS and Linux—and verify a rollback manifest for the exact installed version, platform, and architecture. It verifies both manifests and the configured exact HTTPS origin, then downloads the candidate and checks its archive digest, exact member set, and executable paths before extracting a private `.harness-candidate-<uuid>` directory. The fixed launcher, its recovery entry, public policy, lock, and phase journal remain outside the replaceable `payload/current` tree. Before each payload rename, the updater synchronizes a private temporary journal file, atomically publishes it, and synchronizes its parent directory where the platform supports that operation. The current payload moves only to deterministic `payload/retained`; a later launcher conservatively restores it after any incomplete phase and rejects malformed, escaping, linked, or ambiguous recovery paths.

A healthy candidate becomes `payload/current`. The retained payload is removed only after successful cleanup; a cleanup failure leaves the candidate live, retains the deterministic rollback payload, and reports `applied-with-cleanup-failure`. A failed health check moves the candidate aside, restores the retained payload, and reports `rolled-back` only after cleanup succeeds. The candidate's bundled Node and `cli/package/lib/bin.js --help` process tree is the health lifecycle unit: success requires leader exit with no surviving descendants, while failure terminates and waits for the tree before rollback. On Windows, an external system PowerShell worker assumes the exact lock identity, waits for the update command to exit, performs the journaled payload switch, and applies the same captured-tree rule; `restart-scheduled` does not launch a new interactive CLI. A dead exact lock owner or bounded expiry permits validated recovery, while a malformed lock fails closed. A failed restore reports `transaction-failed` instead of claiming rollback. The transaction never reads, creates, or modifies `HARNESS_HOME`, and never creates a Runtime or Web lease.

The current standalone settlements are:

| Settlement | Visible output | Exit code |
|---|---|---|
| `up-to-date` (`version-not-newer`) | `No update available.` on stdout | `0` |
| `applied` | `CLI update applied.` on stdout | `0` |
| `applied-with-cleanup-failure` | `CLI update applied, but cleanup failed.` on stderr | `1` |
| `restart-scheduled` | `CLI update scheduled; it completes after this command exits.` on stdout | `0` |
| `rolled-back` | `CLI update rolled back.` on stderr | `1` |
| `failed` (`candidate-rejected`, `transaction-failed`, `unconfigured-update-source`, or `unsupported-installation`) | `CLI update unavailable [unconfigured-update-source]. Install a current standalone release.` for an absent policy; otherwise `CLI update failed.` on stderr | `1` |

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
