# @harness-desktop/dsh-host-local-runtime

English | [中文](README.zh.md)

Provides the host foundation for the single local Harness Desktop Runtime. It resolves one writable data root, acquires its exclusive owner lock before stateful services mount, and persists the Runtime's private loopback endpoint.

`HARNESS_HOME` is an absolute-path override after tilde expansion. Without it, Windows uses `%LOCALAPPDATA%\Harness Desktop`, macOS uses `~/Library/Application Support/Harness Desktop`, and Linux uses `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop`. `resolveHarnessHome()` reports `DSH_HOME` only as a legacy import source and never selects it as the writable target.

The owner lock records both PID and operating-system process-start identity. A contender preserves a live or unverifiable owner and recovers a stale record only after the recorded identity is proved absent. Release removes only the acquiring Runtime's unchanged lock.

The endpoint record contains the protocol version, Runtime identity, port, process identity, and private access token. The internal writer protects a same-directory temporary file before its atomic rename; the internal reader verifies owner-only `0600` access on POSIX or a current-user-only Windows DACL before reading. The package root exports only token-free status and ownership types, never the endpoint parser, writer, filename, or token-bearing record.

## Model Experience

### Runtime ownership and endpoint records

#### What the model sees

Nothing. `acquireRuntimeLock()` and the endpoint-record primitives add no prompt text, messages, tool schemas, or tool results.

#### Token effect

None. Runtime access tokens remain in private control-plane files and never enter a model request.

#### KV Cache effect

None. This package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Runtime composition is separate from these primitives** — later host assembly owns service mounting, authenticated routes, client attachment, leases, and idle shutdown.
