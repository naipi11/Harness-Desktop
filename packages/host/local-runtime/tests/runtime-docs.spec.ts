/** Runtime documentation ownership and topology-record acceptance. */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const runtimeReadmePath = 'packages/host/local-runtime/README.md'
const topologyNotePath = '.agents/notes/implemented/architecture/2026-08-15-harness-desktop-product-topology.md'
const formerTopologyNotePath = [
  '.agents', 'notes', 'proposed', 'architecture', '2026-08-15-harness-desktop-product-topology.md',
].join('/')
const runtimeDesignPath = 'docs/superpowers/specs/2026-08-18-harness-unified-local-runtime-design.md'
const ownershipMaps = [
  'docs/architecture.md',
  'docs/subsystems/README.md',
  'docs/subsystems/persistence.md',
] as const

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8')
}

function expectLocalLink(from: string, markdown: string, target: string): void {
  const hrefs = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]!)
  const resolvedTarget = resolve(repositoryRoot, target)
  const matchingHref = hrefs.find((href) => {
    if (/^[a-z]+:/i.test(href)) return false
    const hrefPath = href.split('#', 1)[0]!
    return resolve(repositoryRoot, dirname(from), hrefPath) === resolvedTarget
  })
  expect(matchingHref, `${from} must link to ${target}`).toBeDefined()
  expect(existsSync(resolvedTarget), `${target} must exist`).toBe(true)
}

describe('local Runtime documentation ownership', () => {
  it('publishes one implemented topology record with the implemented-note structure', () => {
    expect(existsSync(resolve(repositoryRoot, topologyNotePath))).toBe(true)
    expect(existsSync(resolve(repositoryRoot, formerTopologyNotePath))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, topologyNotePath.replace(/\.md$/, '.zh.md')))).toBe(true)
    expect(existsSync(resolve(repositoryRoot, topologyNotePath.replace(/\.md$/, '.i18n.yaml')))).toBe(true)

    const note = readRepositoryFile(topologyNotePath)
    expect(note).toContain('Status: implemented')
    expect(note.match(/^## (Problem|Decision|Alternatives considered|Consequences)$/gm)).toEqual([
      '## Problem',
      '## Decision',
      '## Alternatives considered',
      '## Consequences',
    ])
    expect(note).not.toMatch(/^## (Proposal|Plan|Migration plan|Acceptance criteria|Risks)$/m)
    expectLocalLink(topologyNotePath, note, runtimeReadmePath)
  })

  it('makes the package README the sole-owner and non-disclosure contract', () => {
    const readme = readRepositoryFile(runtimeReadmePath)
    expect(readme).toMatch(/Runtime is the sole persistence owner for one `HARNESS_HOME`\./)
    expect(readme).toContain('## Non-disclosure guarantees')
    expect(readme).toContain('body-only handoff')
    expect(readme).toContain('cookie-only Dashboard authentication')
    expect(readme).toContain('selected Harness home')
    expectLocalLink(runtimeReadmePath, readme, runtimeDesignPath)
  })

  it('links architecture and persistence maps to the owning package and decision', () => {
    for (const mapPath of ownershipMaps) {
      const map = readRepositoryFile(mapPath)
      expectLocalLink(mapPath, map, runtimeReadmePath)
      expectLocalLink(mapPath, map, topologyNotePath)
    }
  })

  it('keeps rejected topology rationale only in the topology Agent Note', () => {
    const currentTopologyPath = existsSync(resolve(repositoryRoot, topologyNotePath))
      ? topologyNotePath
      : formerTopologyNotePath
    const documents = [
      currentTopologyPath,
      runtimeReadmePath,
      runtimeDesignPath,
      ...ownershipMaps,
    ].map(path => readRepositoryFile(path))
    expect(documents.filter(document => document.includes('A desktop-owned Host child with a standalone CLI runtime'))).toHaveLength(1)
  })
})
