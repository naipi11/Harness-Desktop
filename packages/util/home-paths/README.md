# dsh-home-paths

English | [中文](README.zh.md)

Shared dependency-free filesystem path helpers. The Harness Desktop data-root policy belongs to [`dsh-host-local-runtime`](../../host/local-runtime/README.md).

`expandHomePath()` expands `~`, `~/...`, and Windows-style `~\...` prefixes against the operating-system home directory. It leaves non-tilde paths and `~user/...` untouched.

## Watch paths

`canonicalizeWatchPath()` gives a native filesystem watcher one stable spelling of its target. It resolves the deepest existing ancestor through `fs.realpath()` and restores any missing suffix, so a file or directory may still be watched before it is created. In particular, Windows 8.3 aliases cannot be mixed with the long paths emitted by the native watcher backend.

This package is intentionally small and harness-dep-free so product packages can share filesystem primitives without importing a host policy.

## Known Limitations and Deferred Work

- **Expansion is deliberately narrow** — only bare `~`, `~/...`, and `~\...` use the current operating-system home; named-user forms such as `~alice/...`, environment variables, and shell expressions remain unchanged.
- **Canonicalization reads but never mutates** — `canonicalizeWatchPath()` performs `realpath` probes and propagates errors other than absence; callers still own directory creation, permissions, and trust policy for the resulting path.
