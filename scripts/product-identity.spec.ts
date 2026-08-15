import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productMetadata } from '../packages/boot/app-boot/src/product-metadata.ts'
import {
  collectProductIdentityViolations,
  type ProductIdentityFiles,
} from './product-identity.ts'

const root = resolve(import.meta.dirname, '..')

function conformingFiles(): ProductIdentityFiles {
  return {
    rootReadme: [
      productMetadata.productName,
      productMetadata.repositoryUrl,
      '`harness`',
    ].join('\n'),
    cliManifest: '{ "bin": { "harness": "lib/harness-bin.js" } }',
    webHtml: `<title>${productMetadata.productName}</title>`,
    webManifest: `{ "name": "${productMetadata.productName}" }`,
    websiteConfig: `title: '${productMetadata.productName}'`,
    agentPreset: productMetadata.productName,
  }
}

describe('product identity gate', () => {
  it('accepts every exact owner and value pair', () => {
    expect(collectProductIdentityViolations(conformingFiles())).toEqual([])
  })

  it('reports one diagnostic for each missing owner and value pair', () => {
    expect(collectProductIdentityViolations({
      rootReadme: '',
      cliManifest: '',
      webHtml: '',
      webManifest: '',
      websiteConfig: '',
      agentPreset: '',
    })).toEqual([
      `rootReadme: missing exact product identity value ${JSON.stringify(productMetadata.productName)}`,
      `rootReadme: missing exact product identity value ${JSON.stringify(productMetadata.repositoryUrl)}`,
      'rootReadme: missing exact product identity value "`harness`"',
      'cliManifest: missing exact product identity value "\\"harness\\""',
      `webHtml: missing exact product identity value ${JSON.stringify(`<title>${productMetadata.productName}</title>`)}`,
      `webManifest: missing exact product identity value ${JSON.stringify(`"name": "${productMetadata.productName}"`)}`,
      `websiteConfig: missing exact product identity value ${JSON.stringify(`title: '${productMetadata.productName}'`)}`,
      `agentPreset: missing exact product identity value ${JSON.stringify(productMetadata.productName)}`,
    ])
  })

  it('accepts the repository identity owners', () => {
    const files: ProductIdentityFiles = {
      rootReadme: readFileSync(resolve(root, 'README.md'), 'utf8'),
      cliManifest: readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8'),
      webHtml: readFileSync(resolve(root, 'apps/web/index.html'), 'utf8'),
      webManifest: readFileSync(resolve(root, 'apps/web/public/manifest.webmanifest'), 'utf8'),
      websiteConfig: readFileSync(resolve(root, 'website/.vitepress/config.ts'), 'utf8'),
      agentPreset: readFileSync(resolve(root, 'apps/cli/config/agent-presets/cordis/agent.cordis.yml'), 'utf8'),
    }

    expect(collectProductIdentityViolations(files)).toEqual([])
  })
})
