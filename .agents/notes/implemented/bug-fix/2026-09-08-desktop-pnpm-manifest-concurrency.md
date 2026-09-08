# Agent Note: Desktop dependency collection uses bounded manifest reads

Status: implemented

English | [中文](2026-09-08-desktop-pnpm-manifest-concurrency.zh.md)

## Problem

Electron Builder collects production dependencies with `pnpm list --prod --json --depth Infinity --silent --loglevel=error`. In this Windows workspace, pnpm 11.7.0 exhausts file handles while reading unsaved dependency manifests and fails with `EMFILE`. Its tree builder starts those reads with an unbounded `Promise.all` across workspace projects.

## Decision

The root package-manager pin is pnpm 11.25.0, whose tree builder limits unsaved dependency reads to four concurrent operations. The exact collector command succeeds with this version against the same installed workspace, without reducing dependency depth or changing the dependency graph. The package-manager regression test requires this exact validated pin; changing it requires deliberate revalidation.

## Alternatives considered

A custom collector or a patched Electron Builder adds maintenance without correcting the failing pnpm operation. Reducing collection depth risks missing transitive runtime dependencies. Raising operating-system limits does not bound the workload and is not a portable Windows packaging fix.

## Consequences

Contributor and CI tooling use the newer pinned package manager; package resolution and the lockfile remain unchanged. Revalidating the actual collector and an isolated unsigned Windows installer remains necessary when changing this pin. The version assertion guards the known baseline but does not replace artifact validation or prove future pnpm releases correct.
