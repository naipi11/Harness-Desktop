# Agent Note: Runtime-owned Desktop update preferences

Status: implemented

English | [中文](2026-08-24-runtime-owned-update-preferences.zh.md)

## Problem

Harness Desktop clients need one selected update channel and a durable outcome record without introducing a client-private persistence writer or leaking update locations, manifests, credentials, paths, or raw errors into shared state.

## Decision

`@harness-desktop/dsh-host-local-runtime` registers the `desktop-update` namespace through the composed settings provider. The section contains one `stable`, `beta`, or `nightly` channel and, when present, one fixed-format outcome: semantic versions, a fixed outcome kind, a fixed redacted code, and an optional last-known-good version.

Authenticated Dashboard control reads and changes only the selected channel. Authenticated native control also records the redacted outcome. The HTTP route rejects extra fields and invalid channel, version, kind, or code values before they reach the control service; the settings owner repeats the same fixed-field admission for stored data.

The Runtime does not fetch a manifest, hold a production trust root, download an artifact, stage an install, request a restart, or roll back a version. Those operations require separately configured production trust and platform-specific installation ownership.

## Alternatives considered

**Electron user data and CLI-local files.** Rejected because independently writable client stores can diverge from the shared `HARNESS_HOME` state and bypass the Runtime's serialized settings provider.

**Expose the entire result to Dashboard control.** Rejected because the Dashboard needs a user preference, while native launchers alone own the non-UI installer state and must not project even a redacted installation history into arbitrary browser controls.

**Arbitrary diagnostic text or manifest fields.** Rejected because a failed update commonly contains URLs, paths, signatures, and transport errors; a closed record prevents those values from entering settings, control responses, or diagnostics.

## Consequences

All channel and outcome writes use the existing settings write queue and survive client restarts with the rest of `HARNESS_HOME`. The selected channel is visible consistently to native and Dashboard clients, while an outcome cannot be read or written by Dashboard control.

Update controls fail through the existing redacted Runtime failure path when a reduced composition has no settings provider. A product without a configured production trust root still has no network or installer mutation path.

The `update-preferences`, control-service, public Runtime client, private route, and source/built process compatibility tests pin the fixed record, ownership split, hostile-request rejection, and shared Runtime behavior.
