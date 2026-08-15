import { expect, it } from 'vitest'
import { productMetadata } from '../src/product-metadata.ts'

it('exports frozen Harness Desktop product metadata', () => {
  expect(productMetadata).toEqual({
    productName: 'Harness Desktop',
    commandName: 'harness',
    legacyCommandName: 'dsh',
    repository: 'naipi11/Harness-Desktop',
    repositoryUrl: 'https://github.com/naipi11/Harness-Desktop',
    appId: 'io.github.naipi11.harness-desktop',
    npmPackage: '@harness-desktop/cli',
    dataNamespace: 'dsh',
  })
  expect(Object.isFrozen(productMetadata)).toBe(true)
})
