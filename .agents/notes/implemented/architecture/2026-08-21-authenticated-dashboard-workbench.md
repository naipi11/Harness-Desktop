# Agent Note: Authenticated Dashboard workbench ownership

Status: implemented

English | [中文](2026-08-21-authenticated-dashboard-workbench.zh.md)

## Problem

The Dashboard needs one engineering workbench over the existing browser application without creating a Desktop-only data path. Focus mode must preserve the selected Session and connection, produced files must come from the registered deliverables projection, and a stop action must cancel only work admitted by the same authenticated browser session.

The local Runtime mounts the Host half of client connection dynamically because it needs the Runtime's cookie validator. Its configured Loader row therefore stays disabled, but the browser half must still enter `window.__DSH_BOOT__`. A cookie hash used only by a control route is not work ownership because ordinary `session.prompt` admission otherwise never reaches Runtime accounting.

## Decision

The app-shell injects `workspaces` before it builds the Dashboard. `EngineeringWorkbench` wraps the ordinary root slot and owns focus state plus exactly five panels: Files, Diff, Terminal, Artifacts, and Tasks. It reads Workspace and Session services already supplied by the browser graph. The deliverables plugin provides a root reader that folds completed-Turn `deliverables` data through `producedForClosing` at each closing Assistant sequence; the workbench never reclassifies tool calls to infer artifacts.

The client-module declaration supports `includeWhenDisabled` for a browser half whose Host half has another lifecycle owner. Client connection uses that declaration: its Loader row remains disabled in the local Runtime, while the Runtime mounts the authenticated Host routes and the browser bundle still joins the boot graph. Ordinary Web compositions enable the Host row directly.

The authenticated connection wraps schema-validated unary dispatch. For `session.prompt`, the Runtime derives a one-way owner from the HttpOnly cookie, reserves the Session writer before ApiProxy admission, and records the request `rpcId`. The existing inbox events correlate the published user message and claimed Turn. Rejected requests, command-only results, handler failures, and accepted requests that publish no correlated message release the reservation; correlation waits for a bounded event interval. Stop or Runtime close before correlation aborts the invocation and retains a correlation tombstone until the carrier settles or a raced message is removed from the inbox. The exact `turn/end` releases accepted work. `observe-active-work` and `stop-own-ui-work` use the same cookie-derived owner, so another Dashboard cookie observes and stops none of it.

The workbench refreshes active work after Terminal and Task prompt actions. While work remains active it polls the authenticated operation at a fixed interval for at most 30 attempts; settlement or focus changes do not reconnect the browser client. The non-secret ready marker remains owned by successful authenticated `AppWebEntry` settlement as described by [Desktop Runtime Dashboard ownership](2026-08-21-desktop-runtime-dashboard-ownership.md).

## Alternatives considered

**Read files, artifacts, todos, or terminal state from Electron preload or local storage.** That creates a second authority and exposes data outside the authenticated client graph. The workbench consumes the same projections and actions as the browser application.

**Treat the cookie hash as ownership only when a control request arrives.** This lets the UI claim status but does not connect the owner to prompt admission. Wrapping the validated `session.prompt` call establishes ownership before the message can enter the Agent inbox.

**Poll forever or only once at mount.** A mount-only observation becomes stale immediately after a prompt; unbounded polling retains background traffic after a lost settlement. Action-triggered refresh plus a bounded active interval covers the observable operation without a permanent subscription.

**Enable the connection Host Loader row inside the local Runtime.** It would mount an unauthenticated `/api` route before the Runtime cookie validator and collide with the dynamically owned routes. `includeWhenDisabled` keeps only the browser half while the authenticated Host owner remains singular.

## Consequences

The browser connection and local Runtime share a validated-unary interceptor contract, and Dashboard prompt admission adds one short correlation wait before it is committed. A real source Runtime process with two cookies proves owner-isolated prompt observation and stop. Client tests prove action refresh, focus preservation, and projection selection.

The in-process Web e2e scaffold can mount the real `LocalDashboardAuth` handoff, cookie validator, authenticated Connection routes, and Dashboard controls around the shipped built `AppWebEntry` and Loader graph. Its browser coverage seeds one real Session and proves all five projections and actions, ready-marker timing, focus without reconnection, unauthenticated recovery, and the AppWebEntry-owned plugin failure report.
