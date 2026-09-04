/** Writable secret-store edge for the real platform credential provider process fixture. */

import type { Context } from '@harness-desktop/cordis'
import type { CredentialRef, ResolvedCredential } from '@harness-desktop/dsh-credentials'
import PlatformCredentialProvider, {
  type Config,
  type PlatformCredentialAdapter,
} from '@harness-desktop/dsh-credentials-platform'

const values = new Map<CredentialRef, string>()

const adapter: PlatformCredentialAdapter = {
  writable: true,
  resolve(ref): Promise<ResolvedCredential | undefined> {
    const value = values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'platform' })
  },
  set(ref, value): Promise<void> {
    values.set(ref, value)
    return Promise.resolve()
  },
  unset(ref): Promise<void> {
    values.delete(ref)
    return Promise.resolve()
  },
}

/** Real metadata writer with an in-memory test adapter at the external platform edge. */
export default class WritableFixtureCredentialProvider extends PlatformCredentialProvider {
  /** @param ctx - fixture Runtime context. @param config - real provider config carrying Harness home. */
  constructor(ctx: Context, config: Config) {
    super(ctx, { ...config, adapter })
  }
}
