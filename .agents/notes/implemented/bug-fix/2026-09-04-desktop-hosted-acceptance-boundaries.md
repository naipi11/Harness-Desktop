# Agent Note: Desktop hosted acceptance boundaries

Status: implemented

English | [中文](2026-09-04-desktop-hosted-acceptance-boundaries.zh.md)

## Problem

The canonical local Runtime can select the browse directory-picker interaction for an SSH or remotely reachable host. The adaptive chooser mounts the host backend and browser surface as dynamic Loader entries, while ClientModuleRegistry resolves client metadata from the config-tree package anchor. The local Runtime dependency closure included the native picker options but not the browse options, so active browse entries could be absent from the browser graph and the Dashboard hid its Add workspace action.

Windows cancellation cleanup rechecked the exact supervisor image before every private-input removal. Removing the supervisor image made the next proof attempt resolve an intentionally absent path, so cleanup stopped with an inspection error and retained the remaining private inputs. Windows source acceptance also passed a drive path to Node's `--import` option, which requires a file URL on Windows.

## Decision

`packages/host/local-runtime/package.json` and the workspace lockfile declare both dynamic browse-picker packages: `@harness-desktop/dsh-host-directory-picker-browse` and `@harness-desktop/dsh-client-ui-directory-picker-browse`. The native options remain direct dependencies. This gives ClientModuleRegistry's local-runtime config anchor a complete set of packages that `directory-picker-auto` may mount; the source Runtime still resolves patch entries explicitly through `import.meta.resolve()` as recorded in [Linux AppImage health handoff](2026-09-03-linux-appimage-health-handoff.md).

`apps/desktop/tests/support/runtime-fixture.ts` keeps the hook as a filesystem path internally and converts it with `pathToFileURL()` at the `--import` argument. The test launches therefore use a valid ESM URL on every runner without changing packaged application behavior.

`assertWindowsCancellationProof()` verifies the retained drained acknowledgement on every cleanup step. Readiness, initial cancellation proof, and cleanup before image deletion require an inspectable regular, non-link private supervisor image. Cleanup records successful strict unlink of that image; only a subsequent `ENOENT` can skip image inspection, while reappearance requires inspection. An already absent image at unlink is an error, not owned deletion. The launch bridge's verified supervisor PID is passed to readiness and cancellation probes; stale-supervisor retirement without a PID uses a supervisor-filename filter. The PID probe preserves query errors and accepts only the explicit `Get-Process` process-ID-not-found error as absence. Both paths compare canonical or normalized full paths, keep bounded output, and fail closed on other query and target-path errors. Error causes remain attached to the bounded diagnostic.

Exact-image probes use the remaining policy deadline, capped at 15 seconds, during readiness and cancellation polling. Without a deadline, the final cancellation observation and cleanup revalidation use a five-second timeout; the public inspector and stale-supervisor retirement also default to five seconds. The 15-second limit is a maximum, not the default, and does not extend those five-second observations.

The focused real-process tests use bounded waits for process identity, process absence, and command-line probes. File absence uses non-following metadata inspection: only `ENOENT` proves absence, transient `EPERM`/`EBUSY` retries remain bounded, and other errors reject. Exact-process absence queries preserve CIM errors, reject same-name rows without an inspectable executable path, reject stderr or ambiguous output, and bound each child invocation by the remaining wait deadline. The primary worker and cancellation wait windows remain policy-selected; a valid drained acknowledgement can add only the bounded final exact-image observation.

## Alternatives considered

**Add every browser package to local-runtime.** Rejected. Only the host-selected dynamic picker options belong in this dependency closure; the static browser roster remains owned by its Web bundle and source patch resolution.

**Treat a missing supervisor image as an absent process in every exact-image check.** Rejected. A missing target during readiness or the first cancellation proof cannot establish ownership and must fail closed. Only cleanup after an established proof may skip the already-removed image.

**Increase the exact-image subprocess buffer until noisy WMI output fits.** Rejected. The probe filters by the unique supervisor filename and retains the existing bounded output policy instead of accepting unbounded diagnostic volume.

**Remove the supervisor image last or drop repeated proof checks.** Rejected. Cleanup keeps proof checks for each private-input removal; the proof helper distinguishes an image already removed by that same cleanup from an image that was never proven stopped.

## Consequences

Remote/SSH source Runtime acceptance includes the browse client row in `window.__DSH_BOOT__`, so the workspace directory flow remains available without opening a native chooser on the host display. The source Dashboard journey exercises the authenticated handoff, workbench, workspace picker, history, settings, and live approval path with the same dynamic selection used by installed acceptance.

Windows exact-image cleanup remains fail-closed for uncertain process ownership while completing the private-input teardown after a valid cancellation acknowledgement. The focused launcher and real worker suite covers canonical image matching, WMI-created supervisors, cancellation, and private-file cleanup; the valid-ack final observation uses five seconds and cannot create an unbounded wait.
