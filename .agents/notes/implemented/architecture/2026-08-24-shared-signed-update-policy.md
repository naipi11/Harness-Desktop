# Agent Note: Shared signed-update policy ownership

Status: implemented

English | [中文](2026-08-24-shared-signed-update-policy.zh.md)

## Problem

Desktop Main owned signed update manifest parsing while Runtime preferences and standalone clients need the same release-channel and verification rules. Separate parsers could accept different targets, origins, or archive paths, and any consumer returning an untrusted manifest could expose implementation-sensitive values.

## Decision

`@harness-desktop/dsh-update-policy` owns exact-record parsing, canonical serialization, Ed25519 verification, semantic-version comparison, target selection, origin checks, digest checks, archive-member checks, and redacted outcomes. `EMPTY_UPDATE_TRUST` contains no origin or public key, so it rejects every candidate. The package does not download, extract, install, restart, or configure trust.

Runtime settings, client control requests, and its public `DesktopUpdateChannel` compatibility name use the shared `UpdateChannel` type while retaining the `stable`, `beta`, and `nightly` wire values. Desktop Main keeps only compatibility re-exports. Tests create each signed candidate and origin at runtime from a fresh identifier, so Git contains no raw signed-manifest or release-location fixture.

## Alternatives considered

- **Keep a parser in each consumer** — it would make release-specific behavior convenient locally, but duplicated signature and archive rules can diverge.
- **Put trust configuration in the policy package** — it would centralize configuration with validation, but would turn a pure verifier into a source of deployment-specific authority.

## Consequences

- Consumers provide their own audited application identity, installed version, selected channel, target, origins, and public keys.
- A later downloader or installer consumes only a redacted accepted artifact and retains its own I/O and rollback responsibilities.
- The verifier's package tests use a real ephemeral Ed25519 key pair and generated candidates to pin rejection behavior without committing source data.
