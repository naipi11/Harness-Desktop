# Agent Note: One Harness home provider

Status: implemented

English | [中文](2026-07-24-single-harness-home-resolver.zh.md)

## Problem

Host-local consumers once interpreted the writable user-data root independently. A plugin could read `$DSH_HOME`, use `~/.dsh`, or receive a configured path, while application launchers and Loader expressions resolved the same fact again. Equal-looking defaults therefore did not prove that settings, credentials, sessions, attachments, skills, instructions, profiles, and shell children used one directory.

A writable-root policy also needs platform defaults and a migration distinction. Treating an old `$DSH_HOME` value as a write fallback would keep two active roots indefinitely and let a compatibility source redirect new data.

## Decision

`@harness-desktop/dsh-host-local-runtime` owns the writable-root policy. `resolveHarnessHome()` accepts a nonblank `HARNESS_HOME` override; otherwise it selects `%LOCALAPPDATA%\Harness Desktop` on Windows, `~/Library/Application Support/Harness Desktop` on macOS, and `$XDG_DATA_HOME/harness-desktop` or `~/.local/share/harness-desktop` on Linux. It returns an absolute branded `HarnessHome`. `$DSH_HOME` is reported only as a legacy-import candidate and never selects a write target.

Each application creates one immutable `HarnessHomeProvider` before its Loader tree mounts. `dsh-app-boot` publishes that provider plus the derived `harnessHome` and `harnessHomePath(...)` Loader expression values. Compositions pass those resolved values into every host-local consumer; a consumer does not reread the environment, construct a second provider, or add a `$DSH_HOME` write path. Launchers that need isolation supply `HARNESS_HOME` before provider creation, while a no-env launch keeps the platform default.

`@harness-desktop/dsh-home-paths` retains dependency-free path primitives such as tilde expansion and watch-path canonicalization, but owns no data-root policy. Durable writers receive the resolved provider or a child path: settings, credentials, session persistence, attachments, and anonymous identity write beneath the same home. Profiles, agent instructions, presets, skill discovery, and the managed shell environment consume that same resolution.

The assembled verification runs built artifacts through a real profile manifest whose bundle list contains `@harness-desktop/dsh-base`. Its artifact-only Vitest lane writes each durable artifact and observes the read-side consumers outside the process. Source-test inventory excludes that lane, and the standalone artifact command builds the required host artifacts first.

## Alternatives considered

**Let each plugin resolve the environment.** Identical helper calls still resolve at different times and allow config to bypass the application-owned value. Injection makes one already-resolved provider the only write authority.

**Keep `$DSH_HOME` as a writable compatibility fallback.** A legacy value can identify data for an explicit import workflow, but writing through it would preserve the split-root behavior this decision removes. New writes use only `HARNESS_HOME` or the platform default.

**Split configuration, data, and cache into separate roots.** Platform data-directory conventions supply the default location, but every Harness-owned durable child remains beneath one root. A multi-root classification would recreate the coordination problem without a current consumer requirement.

**Verify providers with a hand-built miniature composition.** Such a tree can prove individual constructors while omitting a shipped row, patch override, or real profile resolution. The artifact lane therefore consumes the base bundle through the production entry path.

## Consequences

- One application run has one writable home provider and one `HARNESS_HOME` shell fact; `DSH_HOME` never appears in managed child environments.
- Raw and programmatic compositions must inject the resolved provider into consumers that require it. Missing injection fails during Loader activation instead of silently selecting another directory.
- Default locations are native application-data directories rather than `~/.dsh`. This is a pre-release storage break; legacy copying and collision policy belong to a separate import workflow.
- Built-only verification has an explicit build prerequisite and cannot be collected by the ordinary source test program.
