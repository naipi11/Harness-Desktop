# Agent Note: Electron-native directory picker child mode and IPC lifetime

Status: implemented

English | [中文](2026-09-08-electron-native-directory-picker.zh.md)

## Problem

The local Runtime consumes its `ELECTRON_RUN_AS_NODE` marker before starting application subprocesses. The Windows directory picker reuses `process.execPath`; inside a packaged Electron Runtime, launching its JavaScript worker without an explicit Node-mode environment starts another application instead. Unit tests under plain Node and source-backed Dashboard tests do not exercise this packaged handoff. A separate worker defect closes IPC when its nonterminal `showing` notification flushes, although a selected directory or cancellation still needs to cross that channel.

## Decision

The native picker derives child execution mode from `process.versions.electron` and sets `ELECTRON_RUN_AS_NODE=1` only in that child's copied environment. It leaves the Runtime environment unchanged. The worker sends `showing` without disconnecting; only a terminal result or error closes IPC after delivery. Parent disconnect retains its child-termination behavior.

The COM result is decoded with Koffi's NUL-terminated `decode.string16` API before releasing its allocation. `koffi.view` exposes an external ArrayBuffer and aborts under Electron when selection reaches that path. Copying the string also avoids treating a zero low byte in a nonzero UTF-16 code unit as the string terminator.

The canonical Runtime supplies the same shipped roster as the CLI. Its source launch addresses the authoritative CLI directory, while its built package carries a copy beside the Runtime modules and declares every preset plugin dependency. This fixes the next step after successful directory adoption: creating a session otherwise rejects because `standard` cannot be found. System presets retain precedence over the user root; the fix does not create or overwrite user presets.

## Alternatives considered

**Keep Node mode in the Runtime environment.** Rejected because unrelated subprocesses must not inherit an Electron-specific execution override. The picker owns this child launch.

**Use the browse backend to hide the failure.** Rejected because the local Windows composition explicitly offers a native chooser. A different interface would leave the packaged worker defect and its missing acceptance coverage unresolved.

## Consequences

Packaged manual-preview acceptance opens the actual Windows dialog through the Dashboard and prints the test-owned non-ASCII directory for an operator or a desktop-control agent to select. Playwright then verifies that the workspace appears and remains selected after reload; this is an interactive acceptance test, not unattended native-input automation. The temporary Windows profile contains standard shell folders so the native dialog can initialize. Source tests separately pin Node-mode selection, IPC send-callback ordering, cancellation, and UTF-16 decoding without external memory views. These checks do not certify model-provider requests or automatic updating.
