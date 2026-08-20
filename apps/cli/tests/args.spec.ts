import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseProductArgs, ProductArgumentError } from '../src/args.ts'

const parse = (argv: string[]) => parseProductArgs(argv, 'harness', '1.2.3')

/** Capture the product correction for invalid public syntax. */
function correction(argv: string[]): string {
  try {
    parse(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(ProductArgumentError)
    return (error as ProductArgumentError).correction
  }
  throw new Error(`expected ${JSON.stringify(argv)} to reject`)
}

/** Capture the launcher-owned help without allowing Commander to terminate the test process. */
function helpOutput(commandName: 'harness' | 'dsh'): string {
  let output = ''
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
  try {
    parseProductArgs(['--help'], commandName, '1.2.3')
  } catch {
    expect(exit).toHaveBeenCalledWith(0)
  } finally {
    vi.restoreAllMocks()
  }
  return output
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseProductArgs', () => {
  it('resolves the interactive command with an optional initial task', () => {
    expect(parse([])).toEqual({ mode: 'interactive', initialTask: undefined })
    expect(parse(['task'])).toEqual({ mode: 'interactive', initialTask: 'task' })
  })

  it('resolves a non-interactive task with JSON output', () => {
    expect(parse(['run', 'task', '--json'])).toEqual({ mode: 'run', task: 'task', json: true })
  })

  it.each([
    ['--daemon'],
    ['--background'],
  ])('maps web %s to a background lease', (leaseFlag) => {
    expect(parse(['web', leaseFlag])).toEqual({
      mode: 'web',
      open: true,
      lease: 'background',
      operation: 'open',
    })
  })

  it('maps status and stop to lease-free web operations', () => {
    expect(parse(['web', '--status'])).toEqual({
      mode: 'web',
      open: false,
      lease: 'none',
      operation: 'status',
    })
    expect(parse(['web', '--stop'])).toEqual({
      mode: 'web',
      open: false,
      lease: 'none',
      operation: 'stop',
    })
  })

  it.each([
    ['--status', '--open', 'status'],
    ['--open', '--status', 'status'],
    ['--stop', '--open', 'stop'],
    ['--open', '--stop', 'stop'],
  ])('keeps web %s %s browser-free', (firstFlag, secondFlag, operation) => {
    expect(parse(['web', firstFlag, secondFlag])).toEqual({
      mode: 'web',
      open: false,
      lease: 'none',
      operation,
    })
  })

  it('accepts no-open without treating it as a positional task', () => {
    expect(parse(['web', '--no-open'])).toEqual({
      mode: 'web',
      open: false,
      lease: 'none',
      operation: 'open',
    })
  })

  it.each([
    ['web', '--status', '--daemon'],
    ['run', '--json'],
    ['run', 'first', 'second'],
    ['--profile', 'tui'],
    ['--profile=tui'],
    ['web', '--profile', 'tui'],
    ['run', 'task', '--profile', 'tui'],
  ])('rejects %j with a correction', (...argv) => {
    expect(correction(argv)).not.toBe('')
  })

  it('uses the invoking command name in the shared product help', () => {
    const harnessHelp = helpOutput('harness')
    expect(harnessHelp).toContain('harness run "fix the tests" --json')
    expect(harnessHelp).not.toContain('dsh run "fix the tests" --json')
    expect(helpOutput('dsh')).toContain('dsh run "fix the tests" --json')
  })
})
