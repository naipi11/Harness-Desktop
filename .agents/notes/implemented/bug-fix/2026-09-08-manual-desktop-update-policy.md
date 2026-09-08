# Agent Note: Policy-less Desktop previews start without an update error

Status: implemented

English | [中文](2026-09-08-manual-desktop-update-policy.zh.md)

## Problem

An unsigned manual-install preview deliberately omits production update trust. Treating that absence as a damaged policy displays a blocking native error before the Dashboard can start, even though the package intentionally disables automatic updates.

## Decision

`loadDesktopUpdateSource()` returns no source only when reading the installed policy reports `ENOENT`. Main then continues normal startup without constructing a native update adapter or fetching manifests. Malformed JSON, invalid policy fields, unsupported targets, and other read failures still reject; Main retains its fixed update error guidance. Existing native recovery records are not treated as evidence of a configured update source.

## Alternatives considered

Embedding a placeholder public key or live source creates misleading trust and unnecessary network behavior. Suppressing all policy errors would hide damaged or unreadable installations. Retaining the error for an intentionally absent policy prevents unattended preview startup without making update validation safer.

## Consequences

The Windows preview remains a manual installation with no automatic update channel. Tests cover absent policy without fetches, malformed and unreadable policy rejection, and cold boot of an explicitly supplied packaged executable into the Dashboard and settings without a source Runtime. Production signature and native update acceptance remain separate requirements.
