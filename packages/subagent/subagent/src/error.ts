/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @harness-desktop/dsh-subagent
 */

import { HarnessError } from '@harness-desktop/dsh-llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
