# Agent Note: Fail-closed Desktop workflow commands

Status: implemented

English | [中文](2026-09-08-desktop-workflow-fail-closed-commands.zh.md)

## Problem

Equivalent inline commands can drift from the package scripts that define release checks. A multi-architecture loop can hide an earlier failure, and unrestricted diagnostic uploads can disclose installed-app content. The [non-publishing evidence decision](2026-08-25-non-publishing-release-candidate-evidence.md) retains authority over candidate isolation; this note adds command execution and upload restrictions without superseding it.

## Decision

The [Desktop workflow](../../../../.github/workflows/desktop-artifacts.yml) invokes canonical package commands in the required order. Windows-applicable steps use native PowerShell. The three graphical checks use an exact Linux Xvfb command branch with explicit native exit propagation; Desktop updater tests retain `--maxWorkers=1`. Both macOS CLI architectures share one build outcome and one verification outcome, with an immediate exit-code check after each invocation.

The [configuration verifier](../../../../scripts/desktop-release-config.ts) requires the exact command bodies and native PowerShell. Evidence uploads accept only the redacted evidence JSON, ready manifests, and snapshot bindings. Raw installed-app error contexts are not uploaded.

## Alternatives considered

**Accept arbitrary equivalent inline commands.** Rejected because command inventories and execution flags can diverge from their package-owned definitions.

**Retain raw error contexts or broaden the upload list.** Rejected because unredacted diagnostics are outside the reviewed evidence format.

**Use Bash on every runner.** Rejected because Windows jobs require native PowerShell; the exact Linux command branch preserves headless graphical checks without changing Windows execution.

## Consequences

The static checks reject loss of serialization, Xvfb, per-architecture failure propagation, or upload redaction. Workflow edits must preserve these explicit forms. Focused configuration and evidence tests validate the source rules, not actual native packaging or installation. Each operating-system runner still supplies its own execution evidence; no local static result authorizes publication.
