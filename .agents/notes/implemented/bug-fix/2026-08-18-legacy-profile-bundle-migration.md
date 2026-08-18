# Agent Note: Migrate legacy profile bundles after the Harness Desktop rename

Status: implemented

English | [中文](2026-08-18-legacy-profile-bundle-migration.zh.md)

## Problem

The Harness Desktop rename changed every published package from `@deepseek-ai/*` to `@harness-desktop/*`.
Profiles created by the pre-rename `dsh` still list `@deepseek-ai/dsh-*` bundles, so the renamed CLI cannot resolve them and fails with `cannot resolve profile bundle ... run 'dsh plugin --profile <name> install'` instead of upgrading the profile.

## Decision

`dsh-app-boot` treats the legacy tuples as installation-owned and normalizes them to the current shipped templates on load: the pre-rename `web` template (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) and both pre-rename `headless` variants (with and without `@deepseek-ai/dsh-web-app`) rewrite to the current `@harness-desktop/*` templates.
`INSTALLATION_OWNED_PROFILE_TUPLES` now maps each profile name to the set of exact tuples the installation may own; the renamed installation's own headless triple remains in the set, and any other bundle list stays user-owned and untouched.

## Alternatives considered

**A one-time setup command.**
Rejected because every existing install would need a manual step and the failure mode would keep appearing before the user runs it.

**Rewrite any list containing `@deepseek-ai/dsh-base`.**
Rejected because user-customized lists must remain user-owned; only exact tuples the installation ever shipped are normalized.

## Consequences

Existing profiles migrate in place on first load with no manual step, preserving every other manifest field.
Because normalization requires the exact tuple, a user who deliberately kept a legacy-name bundle list still gets a loud resolution failure rather than silent rewriting.

## Testing

The app-boot profile spec covers the legacy `web` tuple, both legacy `headless` variants, the renamed headless triple, and an untouched user-modified list.
