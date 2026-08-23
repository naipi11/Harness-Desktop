import { describe, expect, it, vi } from 'vitest'
import {
  collectTerminalReadinessFailure,
  requirePackedCliBuild,
  settlePackedCliChild,
} from './support/packed-install-fixture.ts'

const successfulResult = { exitCode: 0, stdout: '', stderr: '' }

function fakeChild(killResult = true) {
  const promise = Promise.resolve(successfulResult)
  return Object.assign(promise, {
    pid: 123,
    stdin: null,
    stdout: null,
    kill: vi.fn(() => killResult),
  })
}

describe('packed CLI build precondition', () => {
  it('runs when built bytes exist and skips only ordinary unbuilt inventory', () => {
    expect(requirePackedCliBuild({ available: true, required: false })).toBe(true)
    expect(requirePackedCliBuild({ available: false, required: false })).toBe(false)
  })

  it('fails closed when formal release verification has no built CLI', () => {
    expect(() => requirePackedCliBuild({ available: false, required: true }))
      .toThrow('packed CLI release verification requires apps/cli/lib/bin.js; run pnpm run build first')
  })
})

describe('packed CLI child settlement', () => {
  it('returns a natural exit without signalling the child', async () => {
    const child = fakeChild()
    const closeInput = vi.fn()
    const waitForExit = vi.fn(async (_child: unknown, _timeoutMs: number) => (
      { kind: 'exit' as const, result: successfulResult }
    ))

    await expect(settlePackedCliChild(child, closeInput, { timeoutMs: 11, postKillTimeoutMs: 12, waitForExit }))
      .resolves.toEqual({ result: successfulResult, forced: false })
    expect(closeInput).toHaveBeenCalledOnce()
    expect(waitForExit).toHaveBeenCalledOnce()
    expect(waitForExit).toHaveBeenCalledWith(child, 11)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('checks SIGKILL and gives the post-kill join its own deadline', async () => {
    const child = fakeChild()
    const outcomes = [
      { kind: 'timeout' as const },
      { kind: 'exit' as const, result: successfulResult },
    ]
    const waitForExit = vi.fn(async (_child: unknown, _timeoutMs: number) => outcomes.shift()!)

    await expect(settlePackedCliChild(child, () => {}, { timeoutMs: 11, postKillTimeoutMs: 12, waitForExit }))
      .resolves.toEqual({ result: successfulResult, forced: true })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(waitForExit.mock.calls.map(call => call[1])).toEqual([11, 12])
  })

  it.each([
    ['rejected signal', false, { kind: 'exit' as const, result: successfulResult }, 'packed CLI fixture child rejected SIGKILL'],
    ['surviving child', true, { kind: 'timeout' as const }, 'packed CLI fixture child remained live after SIGKILL'],
  ] as const)('aggregates a stable cleanup error for a %s', async (_label, killResult, second, diagnostic) => {
    const child = fakeChild(killResult)
    const outcomes = [{ kind: 'timeout' as const }, second]
    const error = await settlePackedCliChild(child, () => {}, {
      waitForExit: async () => outcomes.shift()!,
    }).then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe('packed CLI fixture child cleanup failed')
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: diagnostic }),
    ])
  })
})

describe('terminal readiness failure cleanup', () => {
  it('closes readline and input before returning captured diagnostics', async () => {
    const order: string[] = []
    const child = fakeChild()
    const settle = vi.fn(async (_child: unknown, closeInput: () => void) => {
      order.push('settle')
      closeInput()
      return { result: { ...successfulResult, exitCode: 7, stderr: 'helper failed' }, forced: false }
    })

    const outcome = await collectTerminalReadinessFailure({
      cause: new Error('terminal readiness timed out'),
      child,
      lines: { close() { order.push('readline') } },
      closeInput() { order.push('input') },
      observedStderr: () => '',
      settle,
    })

    expect(order).toEqual(['readline', 'settle', 'input'])
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toBeInstanceOf(AggregateError)
    expect(outcome.error.errors).toEqual([
      expect.objectContaining({ message: 'terminal readiness timed out' }),
      expect.objectContaining({ message: 'installed terminal helper exited 7: helper failed' }),
    ])
  })

  it('returns an unsettled aggregate when bounded helper cleanup fails', async () => {
    const cleanup = new AggregateError([
      new Error('packed CLI fixture child remained live after SIGKILL'),
    ], 'packed CLI fixture child cleanup failed')
    const outcome = await collectTerminalReadinessFailure({
      cause: new Error('terminal readiness timed out'),
      child: fakeChild(),
      lines: { close() {} },
      closeInput() {},
      observedStderr: () => 'partial helper stderr',
      settle: async () => { throw cleanup },
    })

    expect(outcome.settled).toBe(false)
    expect(outcome.error.errors).toEqual([
      expect.objectContaining({ message: 'terminal readiness timed out' }),
      expect.objectContaining({ message: 'installed terminal helper did not settle: partial helper stderr' }),
      cleanup,
    ])
  })
})
