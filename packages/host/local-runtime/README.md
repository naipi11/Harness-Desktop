# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

Resolves the single writable Harness Desktop data root. `HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`.

`resolveHarnessHome()` returns the root and reports `DSH_HOME` only as a legacy import source. It never selects `DSH_HOME` as the writable target. `createLocalRuntimePlugin()` resolves once and provides child paths beneath that root for durable writers.

## Model Experience

None. This package resolves host filesystem paths and does not participate in model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Legacy migration is not performed by this resolver** — it reports a detected `DSH_HOME` source for the dedicated import workflow, which owns copying and collision handling.
