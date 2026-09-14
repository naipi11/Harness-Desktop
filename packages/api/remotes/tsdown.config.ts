import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@stackstackstack/dsh-api-remotes',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
