# Agent Note: Desktop staged update transaction

Status: implemented

English | [中文](2026-08-24-desktop-staged-update-transaction.zh.md)

## Problem

A signed update candidate remains unsafe until its downloaded bytes, extracted members, and post-switch authenticated Dashboard boot all prove that it matches the selected release. A failed candidate must not replace the working Desktop installation or delete Runtime-owned `HARNESS_HOME` data.

## Decision

`DesktopUpdateService` verifies a manifest through `@harness-desktop/dsh-update-policy`, then sends only its redacted artifact declaration to a Main-owned `StageAdapter`. The adapter downloads, inspects, stages, launches, restores, and cleans up inside its private staging roots. Candidate bytes and actual members must match the signed declaration before staging, and the candidate is accepted only when it returns the existing exact `desktop-dashboard-ready` acknowledgement after authenticated Dashboard boot.

`applyStagedUpdate()` launches a candidate once. Missing, malformed, or failed readiness restores the retained installation before it records `rolled-back` through the Runtime client. Desktop-local results use fixed redacted codes such as `candidate-staged` and `desktop-health-check-failed`; Runtime persistence maps them to its established outcome-code union. The transaction never writes a second update settings store and does not alter `HARNESS_HOME`.

Desktop Main constructs the service with `EMPTY_UPDATE_TRUST` and an unconfigured adapter. That path returns before manifest loading, downloading, archive inspection, process launch, or filesystem mutation until separately audited production trust and a source are supplied.

## Alternatives considered

- **Apply immediately after signature verification** — rejected because a signed archive can still have different bytes, members, or startup behavior than the accepted candidate.
- **Treat any child-process success as readiness** — rejected because only the authenticated Dashboard acknowledgement proves the user-facing Desktop path has booted.
- **Persist Desktop-local transaction details in a second store** — rejected because channel selection and durable redacted outcomes already belong to the Runtime settings owner.

## Consequences

- Platform-specific installers implement `StageAdapter` without exposing their paths, URLs, or raw errors through `DesktopUpdateResult`.
- The isolated transaction tests generate their manifest, trust, archive, and temporary install root at runtime, and use child processes for candidate acknowledgement cases.
- Focused tests cover empty-trust short-circuiting, byte and member inspection, exactly-once successful acknowledgement, failed acknowledgement rollback, Runtime outcome mapping, and `HARNESS_HOME` preservation.
