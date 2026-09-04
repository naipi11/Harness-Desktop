/** Fail-closed build and child-lifecycle helpers for packed CLI acceptance. */

interface PackedCliChildResult {
  readonly exitCode?: number
  readonly stdout: string
  readonly stderr: string
}

interface PackedCliChild extends PromiseLike<PackedCliChildResult> {
  kill(signal: NodeJS.Signals): boolean
}

type ChildWaitOutcome =
  | { readonly kind: 'exit'; readonly result: PackedCliChildResult }
  | { readonly kind: 'timeout' }

type WaitForChildExit = (child: PackedCliChild, timeoutMs: number) => Promise<ChildWaitOutcome>

interface ChildSettlementOptions {
  readonly timeoutMs?: number
  readonly postKillTimeoutMs?: number
  readonly waitForExit?: WaitForChildExit
}

interface TerminalReadinessFailureInput {
  readonly cause: unknown
  readonly child: PackedCliChild
  readonly lines: { close(): void }
  readonly closeInput: () => void
  readonly observedStderr: () => string
  readonly settle?: typeof settlePackedCliChild
}

/**
 * Select built acceptance for formal release use and ordinary test inventory.
 * @param input - observed built entry and explicit formal-release requirement.
 * @returns whether the packed acceptance suite must run.
 * @throws when formal release verification has no built CLI entry.
 */
export function requirePackedCliBuild(input: {
  readonly available: boolean
  readonly required: boolean
}): boolean {
  if (input.available) return true
  if (input.required) {
    throw new Error('packed CLI release verification requires apps/cli/lib/bin.js; run pnpm run build first')
  }
  return false
}

/**
 * Close one test-owned child, then bound both its graceful and forced joins.
 * @param child - thenable child result and checked native kill operation.
 * @param closeInput - graceful lifetime release owned by the caller.
 * @param options - independent graceful/post-kill deadlines and deterministic wait seam.
 * @returns settled child result and whether SIGKILL was required.
 */
export async function settlePackedCliChild(
  child: PackedCliChild,
  closeInput: () => void,
  options: ChildSettlementOptions = {},
): Promise<{ readonly result: PackedCliChildResult; readonly forced: boolean }> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const postKillTimeoutMs = options.postKillTimeoutMs ?? 10_000
  const waitForExit = options.waitForExit ?? waitForChildExit
  const cleanupErrors: unknown[] = []
  try {
    closeInput()
  } catch (error) {
    cleanupErrors.push(new Error('packed CLI fixture child input close failed', { cause: error }))
  }

  const initial = await waitForExit(child, timeoutMs)
  if (initial.kind === 'exit') {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'packed CLI fixture child cleanup failed')
    }
    return { result: initial.result, forced: false }
  }

  try {
    if (!child.kill('SIGKILL')) cleanupErrors.push(new Error('packed CLI fixture child rejected SIGKILL'))
  } catch (error) {
    cleanupErrors.push(new Error('packed CLI fixture child SIGKILL failed', { cause: error }))
  }
  const forced = await waitForExit(child, postKillTimeoutMs)
  if (forced.kind === 'timeout') {
    cleanupErrors.push(new Error('packed CLI fixture child remained live after SIGKILL'))
    throw new AggregateError(cleanupErrors, 'packed CLI fixture child cleanup failed')
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'packed CLI fixture child cleanup failed')
  }
  return { result: forced.result, forced: true }
}

/**
 * Settle a helper that failed readiness before constructing its diagnostic.
 * @param input - readiness cause, owned streams, child, and optional deterministic settlement seam.
 * @returns an aggregate plus whether the helper reached process quiescence.
 */
export async function collectTerminalReadinessFailure(
  input: TerminalReadinessFailureInput,
): Promise<{ readonly error: AggregateError; readonly settled: boolean }> {
  input.lines.close()
  const settle = input.settle ?? settlePackedCliChild
  try {
    const outcome = await settle(input.child, input.closeInput, { timeoutMs: 10_000, postKillTimeoutMs: 10_000 })
    return {
      settled: true,
      error: new AggregateError([
        input.cause,
        new Error(`installed terminal helper exited ${String(outcome.result.exitCode)}: ${outcome.result.stderr}`),
      ], 'installed terminal helper failed before attachment'),
    }
  } catch (cleanupError) {
    return {
      settled: false,
      error: new AggregateError([
        input.cause,
        new Error(`installed terminal helper did not settle: ${input.observedStderr()}`),
        cleanupError,
      ], 'installed terminal helper readiness and cleanup both failed'),
    }
  }
}

async function waitForChildExit(child: PackedCliChild, timeoutMs: number): Promise<ChildWaitOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.then(result => ({ kind: 'exit' as const, result })),
    new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => { resolve({ kind: 'timeout' }) }, timeoutMs)
      timeout.unref()
    }),
  ])
  if (timeout !== undefined) clearTimeout(timeout)
  return outcome
}
