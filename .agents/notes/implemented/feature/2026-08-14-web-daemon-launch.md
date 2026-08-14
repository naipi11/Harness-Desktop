# Agent Note: Web daemon launch stays in the CLI

Status: implemented

English | [中文](2026-08-14-web-daemon-launch.zh.md)

## Problem

Web sessions need to continue after an interactive launcher returns, while their app arguments, startup behavior, process ownership, and diagnostic output remain consistent with a foreground `dsh web` launch. A parent process that exits cannot report whether its detached child later bound HTTP, so startup failures need an owned diagnostic location.

## Decision

The CLI owns the Web-only `--daemon` and `--background` aliases. It consumes either alias before it passes cleaned arguments to the Web profile, re-execs the child with the same source-launch runtime arguments when applicable, prints the child PID and private `$DSH_HOME/logs/.../server.log` path, and exits after child creation. The returned PID uses the existing child-disposal cleanup.

`web-startup` continues to own `--host`, `--port`, repeatable `--trusted-host`, and `--help`. The child writes its URL and startup failures to the private log. Parent success only reports child creation; it does not report HTTP readiness, and `--help` creates no child.

## Alternatives considered

**Terminal detachment without re-exec.** Rejected. A detached continuation needs the same executable and source-launch runtime context as the original invocation; re-exec preserves that context while letting the parent return after it has recorded the child identity and log location.

**A `status` or `stop` service manager.** Rejected. It would introduce persistent service state and a second lifecycle API without making child creation prove readiness. The PID and private log retain direct ownership and diagnosis; no readiness polling, remote bind, or login autostart is added.

## Consequences

Foreground `dsh web` behavior remains unchanged. Background callers receive a PID that existing disposal cleans up, but must read the private log to obtain the child URL or diagnose startup failure. The process has no readiness guarantee or lifecycle-management commands beyond normal child disposal.
