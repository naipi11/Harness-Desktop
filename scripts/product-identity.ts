/** Verify that public identity owners carry the product metadata values. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productMetadata } from '../packages/boot/app-boot/src/product-metadata.ts'

const root = resolve(import.meta.dirname, '..')

/** Contents of the six files that own the public product identity. */
export interface ProductIdentityFiles {
  readonly rootReadme: string
  readonly cliManifest: string
  readonly webHtml: string
  readonly webManifest: string
  readonly websiteConfig: string
  readonly agentPreset: string
}

interface ProductIdentityRequirement {
  readonly owner: keyof ProductIdentityFiles
  readonly value: string
}

const requirements: readonly ProductIdentityRequirement[] = [
  { owner: 'rootReadme', value: productMetadata.productName },
  { owner: 'rootReadme', value: productMetadata.repositoryUrl },
  { owner: 'rootReadme', value: '`harness`' },
  { owner: 'cliManifest', value: '"harness"' },
  { owner: 'webHtml', value: `<title>${productMetadata.productName}</title>` },
  { owner: 'webManifest', value: `"name": "${productMetadata.productName}"` },
  { owner: 'websiteConfig', value: `title: '${productMetadata.productName}'` },
  { owner: 'agentPreset', value: productMetadata.productName },
]

/**
 * Return one diagnostic for each exact identity value missing from its owner.
 * @param files - Contents keyed by the six public identity owners.
 * @returns Missing owner and value diagnostics in the stable requirement order.
 */
export function collectProductIdentityViolations(files: ProductIdentityFiles): string[] {
  return requirements
    .filter(requirement => !files[requirement.owner].includes(requirement.value))
    .map(requirement => (
      `${requirement.owner}: missing exact product identity value ${JSON.stringify(requirement.value)}`
    ))
}

function readProductIdentityFiles(): ProductIdentityFiles {
  return {
    rootReadme: readFileSync(resolve(root, 'README.md'), 'utf8'),
    cliManifest: readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8'),
    webHtml: readFileSync(resolve(root, 'apps/web/index.html'), 'utf8'),
    webManifest: readFileSync(resolve(root, 'apps/web/public/manifest.webmanifest'), 'utf8'),
    websiteConfig: readFileSync(resolve(root, 'website/.vitepress/config.ts'), 'utf8'),
    agentPreset: readFileSync(resolve(root, 'apps/cli/config/agent-presets/cordis/agent.cordis.yml'), 'utf8'),
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const violations = collectProductIdentityViolations(readProductIdentityFiles())
  if (violations.length === 0) {
    process.stdout.write('verify:product-identity: public identity owners match product metadata.\n')
  } else {
    process.stderr.write('verify:product-identity: public identity owner violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exitCode = 1
  }
}
