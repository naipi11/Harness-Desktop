# Web Daemon Launch Implementation Plan

English | [涓枃](2026-08-14-web-daemon.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-platform `dsh web --daemon` and `dsh web --background` aliases that run the existing Web profile outside the invoking terminal.

**Architecture:** A CLI helper detects aliases only after the Web profile is selected, removes them before re-executing the CLI, and starts a detached Node child with private file-backed output. The child follows the existing Web profile boot path; after the operating system confirms the spawn, the parent prints the PID and log path then exits.

**Tech Stack:** Node.js 22 child-process and filesystem APIs, TypeScript, Commander, Vitest, existing built-CLI smoke infrastructure, and paired Markdown.

## Global Constraints

- Support `--daemon` and `--background` as equivalent Web-only aliases; both in one invocation create one child.
- Keep the foreground Web boot, host, port, trust, readiness, and shutdown paths unchanged in the child.
- Give `--help` precedence: remove detached aliases, print help, and create no child.
- Use a detached child with ignored stdin, private output under `$DSH_HOME/logs/`, `windowsHide: true`, and `unref()` after its `spawn` event.
- Parent success means child creation only; ordinary server-start failures remain in the private log.
- Add no dependencies, remote bind, readiness polling, service-manager commands, or login-start behavior.
- Keep Node support at `^22.19.0 || >=24.0.0`, strict ESM TypeScript, paired docs, an implemented Agent Note, focused unit coverage, a built-CLI smoke, and a keyless snapshot.

---

### Task 1: Add a testable detached-launch helper

**Files:**

- Create: `apps/cli/src/web-daemon.ts`
- Create: `apps/cli/tests/web-daemon.spec.ts`

**Interfaces:**

- Produces: `resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean }`.
- Produces: `launchWebDaemon(input: { runtimeArgs: readonly string[]; entry: string; patches: readonly string[]; args: readonly string[] }): Promise<{ pid: number; logPath: string }>`.
- Produces: injectable filesystem and child-process adapters; production resolves the home with `resolveDshHome()`.
- Consumed by Task 2: only the `profile === 'web'` branch in `apps/cli/src/bin.ts`.

- [ ] **Step 1: Write the failing unit tests**

```ts
expect(resolveWebDaemonInvocation(['--port', '0', '--daemon', '--background']))
  .toEqual({ args: ['--port', '0'], detached: true })
expect(resolveWebDaemonInvocation(['--daemon', '--help']))
  .toEqual({ args: ['--help'], detached: false })

const launched = launchWebDaemon({ runtimeArgs: ['--import', 'tsx/esm'], entry: '/dsh/bin.js', patches: ['overlay.yml'], args: ['--port', '0'] }, adapters)
child.emit('spawn')
await expect(launched).resolves.toMatchObject({ pid: 417 })
expect(adapters.spawn).toHaveBeenCalledWith(process.execPath, ['--import', 'tsx/esm', '/dsh/bin.js', '--profile', 'web', '--patch', 'overlay.yml', '--port', '0'], expect.objectContaining({ detached: true, windowsHide: true, stdio: ['ignore', 9, 9] }))
```

- [ ] **Step 2: Confirm the test fails before implementation**

Run: `pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts`

Expected: FAIL because `../src/web-daemon.ts` does not exist.

- [ ] **Step 3: Implement the helper**

```ts
export function resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean } {
  const requested = args.some(arg => arg === '--daemon' || arg === '--background')
  const cleaned = args.filter(arg => arg !== '--daemon' && arg !== '--background')
  return { args: cleaned, detached: requested && !cleaned.some(arg => arg === '-h' || arg === '--help') }
}
```

Create `$DSH_HOME/logs/` with owner-only permissions, create a unique subdirectory through `mkdtempSync`, open `server.log` exclusively with owner-only mode, and give the same descriptor to child stdout and stderr. Rebuild child argv as `[...runtimeArgs, entry, '--profile', 'web', ...patches.flatMap(path => ['--patch', path]), ...args]`. The CLI passes `process.execArgv` so source launches retain `--import tsx/esm`. Await `spawn` or `error`, close the parent descriptor on either path, call `unref()` only after `spawn`, and throw an error that names the failed log or spawn operation.

- [ ] **Step 4: Run focused verification**

Run: `pnpm exec vitest run apps/cli/tests/web-daemon.spec.ts && pnpm exec tsc -p apps/cli/tsconfig.json --noEmit`

Expected: PASS; alias normalization, help precedence, reconstructed argv, detached options, descriptor ownership, and startup errors are covered.

- [ ] **Step 5: Commit Task 1**

```sh
git add apps/cli/src/web-daemon.ts apps/cli/tests/web-daemon.spec.ts
git commit -m "feat(cli): launch web server in background"
```

### Task 2: Dispatch Web aliases and test visible behavior

**Files:**

- Modify: `apps/cli/src/bin.ts`
- Modify: `packages/bundle/web-app/src/startup.ts`
- Modify: `packages/bundle/web-app/tests/startup.spec.ts`
- Create: `apps/cli/tests/web-daemon.compat.spec.ts`
- Create: `apps/cli/tests/web-daemon.snapshot.ts`

**Interfaces:**

- Consumes: Task 1's `resolveWebDaemonInvocation()` and `launchWebDaemon()`.
- Produces: foreground `runProfile()` with cleaned args or parent stdout `dsh web: started detached process <pid>; log: <path>`.
- Produces: help text naming both aliases without adding them to `WebStartupValues`.
- Consumes: `DSH_REQUIRE_BUILT_CLI_SMOKE` and the child URL line `dsh web: http://127.0.0.1:<port>`.

- [ ] **Step 1: Write failing real-process and help tests**

```ts
const parent = await runBuiltBin(['web', '--daemon', '--port', '0'], { DSH_HOME: home })
expect(parent.code).toBe(0)
const [, pid, logPath] = parent.stdout.match(/^dsh web: started detached process (\d+); log: (.+)\n$/u) ?? []
await waitForLogLine(logPath, /dsh web: http:\/\/127\.0\.0\.1:\d+/u)
await expect(fetch(urlFromLog(logPath))).resolves.toMatchObject({ ok: true })
await stopDetachedProcess(Number(pid))
```

Make the compatibility test skip unless `DSH_REQUIRE_BUILT_CLI_SMOKE === '1'` and require `apps/cli/lib/bin.js` plus `apps/web/dist/index.html`. It uses an isolated temporary `DSH_HOME`, polls the child log, removes that home after cleanup, uses `taskkill /PID <pid> /T /F` on Windows, and sends `SIGTERM` then waits on other platforms.

Make the snapshot invoke the source or built CLI from `DSH_EXAMPLE_MODE` with `web --daemon --help` and snapshot `{ code: 0, stderr: '', stdout }`. It asserts both aliases are present and the PID/log line is absent.

- [ ] **Step 2: Confirm failures**

Run: `pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because the CLI does not dispatch the helper, help lacks both aliases, and there is no PID/log line.

- [ ] **Step 3: Wire dispatch and help**

```ts
const web = invocation.profile === 'web' ? resolveWebDaemonInvocation(invocation.args) : undefined
if (web?.detached) {
  const launched = await launchWebDaemon({ runtimeArgs: process.execArgv, entry: fileURLToPath(import.meta.url), patches: invocation.patches, args: web.args })
  process.stdout.write(`dsh web: started detached process \${String(launched.pid)}; log: \${launched.logPath}\n`)
  break
}
await runProfile({ environment: loadLayeredEnv('dsh'), profile: invocation.profile, patchFiles: invocation.patches, args: web?.args ?? invocation.args })
```

Add both aliases to the Web help examples. Keep them out of `WebStartupValues`, because they change the launcher process lifetime before Web rows exist.

- [ ] **Step 4: Build and run behavior coverage**

Run: `pnpm run build && pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.spec.ts && DSH_REQUIRE_BUILT_CLI_SMOKE=1 pnpm exec vitest run apps/cli/tests/web-daemon.compat.spec.ts && DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts apps/cli/tests/web-daemon.snapshot.ts`

Expected: PASS; the parent exits after spawning, the child serves the built Web UI, help shows both aliases, and the user-visible help transcript is stable.

- [ ] **Step 5: Commit Task 2**

```sh
git add apps/cli/src/bin.ts packages/bundle/web-app/src/startup.ts packages/bundle/web-app/tests/startup.spec.ts apps/cli/tests/web-daemon.compat.spec.ts apps/cli/tests/web-daemon.snapshot.ts
git commit -m "feat(cli): support detached web launch"
```

### Task 3: Record user operation and the shipped decision

**Files:**

- Modify: `apps/cli/README.md`, `apps/cli/README.zh.md`, and `apps/cli/README.i18n.yaml`
- Modify: `apps/cli/reference/README.md`, `apps/cli/reference/README.zh.md`, and `apps/cli/reference/README.i18n.yaml`
- Modify: `packages/bundle/web-app/README.md`, `packages/bundle/web-app/README.zh.md`, and `packages/bundle/web-app/README.i18n.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`, `.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md`, and `.agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml`

**Interfaces:**

- Documents: aliases, parent-success semantics, PID/log output, private logs, foreground compatibility, and child signal disposal.
- Documents: `web-startup` still owns host, port, trusted-host, and help after the CLI removes aliases.
- Records: an implemented feature Agent Note with Problem, Decision, Alternatives considered, and Consequences.

- [ ] **Step 1: Confirm the new decision record is absent**

Run: `pnpm run verify-translation-pairing .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md`

Expected: FAIL because the Agent Note pair does not exist.

- [ ] **Step 2: Write paired operation documentation and the note**

Document `dsh web --daemon` and `dsh web --background` in the CLI entry and Web-alias references. State that parent success reports child creation rather than readiness, the child URL and startup failures are in the private log, `--help` creates no child, and the returned PID uses existing child disposal. Describe the aliases as the one Web process-lifetime control consumed by the CLI before the Web provider receives cleaned args.

Create the implemented Agent Note with this exact section sequence:

```markdown
# Agent Note: Web daemon launch stays in the CLI

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences
```

Record rejection of terminal detachment without re-exec and rejection of a `status`/`stop` manager. State that the private log is required to diagnose a child startup failure.

- [ ] **Step 3: Re-record pairs and run documentation checks**

Run: `pnpm run verify-translation-pairing --write apps/cli/README.md apps/cli/reference/README.md packages/bundle/web-app/README.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md && pnpm run doc-sync && git diff --check`

Expected: PASS; all updated pairs have matching structure and current hashes, the Agent Note format is valid, and Markdown checks pass.

- [ ] **Step 4: Commit Task 3**

```sh
git add apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/cli/reference/README.md apps/cli/reference/README.zh.md apps/cli/reference/README.i18n.yaml packages/bundle/web-app/README.md packages/bundle/web-app/README.zh.md packages/bundle/web-app/README.i18n.yaml .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.zh.md .agents/notes/implemented/feature/2026-08-14-web-daemon-launch.i18n.yaml
git commit -m "docs: document detached web launch"
```

## Plan self-review

- Spec coverage: Task 1 covers normalization, detached spawn, private logs, child argv, and immediate setup failure. Task 2 covers Web-only dispatch, help precedence, unchanged child boot, real built-server continuity, and a keyless visible-output snapshot. Task 3 covers operation docs, pairing records, and the required feature decision.
- Placeholder scan: each task names its files, interfaces, tests, expected result, implementation behavior, and commit.
- Type consistency: Task 1 defines `resolveWebDaemonInvocation()` and `launchWebDaemon()`; Task 2 consumes the same names and fields.
