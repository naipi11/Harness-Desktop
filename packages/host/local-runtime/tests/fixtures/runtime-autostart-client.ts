import { createRuntimeConnector } from '../../src/runtime-client.ts'

const connector = createRuntimeConnector({
  input: { env: process.env, homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '' },
})
const client = await connector.connect({ start: true })
const status = await client.status()
await client.close()
process.stdout.write(JSON.stringify({ runtimeId: status.runtimeId }))
