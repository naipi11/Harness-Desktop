# Agent Note: Writable Windows credentials and direct workbench commands

Status: implemented

English | [中文](2026-09-09-desktop-workbench-and-credentials.zh.md)

## Problem

A desktop credential form cannot accept edits when its production provider only reads environment variables. A workspace file panel cannot reuse a directory-picker API that native-picker compositions intentionally reject. A terminal control that sends its input to `session.prompt` is not a local command console, and hardcoded shell copy ignores the selected language.

## Decision

Windows uses Credential Manager through the existing Koffi dependency with explicit local-machine persistence and namespaced generic entries. Manual values override the frozen launch environment, and removing an override may reveal that fallback. The renderer receives only value-free credential metadata. Provider errors and observer diagnostics do not forward arbitrary error content. The [provider README](../../../../packages/credentials/credentials-platform/README.md) owns storage limitations.

The Runtime owns cookie-authenticated workbench operations: bounded reads of registered workspace descendants and owner-scoped persistent command shells. Commands go directly to a credential-scrubbed subprocess, never through a model turn. Windows uses piped PowerShell because the existing PTY process inspector has no Windows implementation. The line-oriented console explicitly excludes full-screen and interactive programs; closing it terminates its process tree. The [Runtime README](../../../../packages/host/local-runtime/README.md) owns lifecycle details.

The shell follows the shared locale service, retains the conversation when utility panels collapse, and exposes file and terminal failures instead of empty success states. It rejects stale terminal-open results when the selected workspace changes.

## Alternatives considered

**Enable the password input without changing its provider.** Rejected because every write would still fail.

**Save API keys in a plaintext application file.** Rejected because the existing adapter permits OS storage without expanding the secret-bearing file set.

**Reuse the PTY service unchanged.** Rejected for this Windows repair because its process inspector rejects Windows. A full ConPTY implementation remains a separate change; the command console states its limits rather than advertising unsupported interactivity.

**Treat terminal input as a model prompt.** Rejected because users expect deterministic local execution independent of API credentials and model interpretation.

## Consequences

The application retains one persistence owner per Harness home. Windows credentials survive application restart but are accessible to other same-user processes; they are not a sandbox against that user. Console output is bounded and memory-only, and does not become a model-visible transcript. Native storage round-trips, real shell commands, cookie authorization, and a built Dashboard browser walkthrough provide distinct evidence; none certifies a model provider or production updater.
