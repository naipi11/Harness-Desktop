import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import productMetadata from '../../packages/boot/app-boot/product.json' with { type: 'json' }
import { parseReleaseUpdateConfiguration } from '@harness-desktop/dsh-update-policy'

const updatePolicyPath = process.env.DSH_DESKTOP_UPDATE_POLICY
const signingMode = resolveSigningMode(process.env.DSH_DESKTOP_SIGNING_MODE)
const extraResources = [
  { from: 'resources/update/windows-native-rollback-worker.ps1', to: 'windows-native-rollback-worker.ps1' },
  { from: 'out/main/native-rollback-worker.js', to: 'native-rollback-worker.js' },
  // The detached Electron-as-Node worker imports Rollup's shared Main chunks from
  // this sibling directory after the installed application starts replacing itself.
  { from: 'out/main/chunks', to: 'chunks' },
  ...updatePolicyResources(updatePolicyPath, signingMode),
]

/** Installer matrix for Harness Desktop; every target stays non-publishing. */
export default {
  appId: productMetadata.appId,
  productName: productMetadata.productName,
  executableName: 'harness-desktop',
  directories: { output: 'release' },
  files: ['out/**', 'package.json', 'resources/icons/**'],
  extraResources,
  asar: true,
  // Windows keeps pnpm's target-native payload because electron-builder's rebuild
  // of the patched node-pty dependency mutates the shared linked-worktree store;
  // macOS/Linux retain builder rebuilds for their target and universal payloads.
  npmRebuild: process.platform !== 'win32',
  // A release must never silently fall back to an unsigned installer when its
  // approved signing material is absent or unusable. Development evidence
  // remains deliberately unsigned.
  forceCodeSigning: signingMode === 'release',
  publish: null,
  nsis: {
    include: 'build/installer.nsh',
  },
  win: {
    target: ['nsis'],
    icon: 'resources/icons/win/harness-desktop.ico',
    extraResources: [{
      from: 'out/native/win32-x64',
      to: '.',
      filter: ['windows-native-update-supervisor.exe'],
    }],
    ...(signingMode === 'release' ? {} : { signExecutable: false }),
  },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    icon: 'resources/icons/mac/harness-desktop.icns',
    category: 'public.app-category.developer-tools',
    ...(signingMode === 'release' ? {} : { identity: null }),
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'resources/icons/linux/harness-desktop-512.png',
    category: 'Development',
  },
  deb: {
    artifactName: 'harness-desktop_${version}_${arch}.${ext}',
  },
}

function verifiedUpdatePolicyPath(path) {
  const absolute = resolve(path)
  let policy
  try {
    policy = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error('Harness Desktop: DSH_DESKTOP_UPDATE_POLICY must name readable JSON', { cause: error })
  }
  try {
    parseReleaseUpdateConfiguration(policy, productMetadata.appId)
  } catch (error) {
    throw new Error('Harness Desktop: DSH_DESKTOP_UPDATE_POLICY is not a public release update policy', { cause: error })
  }
  return absolute
}

/**
 * Require a verified public update policy for a release that may be signed.
 * Unsigned development builds may intentionally omit it, while CI supplies an
 * ephemeral public policy so its artifacts exercise the installed update path.
 */
function updatePolicyResources(path, mode) {
  if (path === undefined || path === '') {
    if (mode === 'release') {
      throw new Error('Harness Desktop: DSH_DESKTOP_UPDATE_POLICY is required when DSH_DESKTOP_SIGNING_MODE=release')
    }
    return [{ from: 'resources/update/update-policy-state-absent', to: 'update-policy-state' }]
  }
  return [
    { from: verifiedUpdatePolicyPath(path), to: 'update-policy.json' },
    { from: 'resources/update/update-policy-state-present', to: 'update-policy-state' },
  ]
}

/** Require an explicit release-only opt-in before Electron Builder may discover a signing identity. */
function resolveSigningMode(value) {
  if (value === undefined || value === '' || value === 'disabled') return 'disabled'
  if (value === 'release') return 'release'
  throw new Error('Harness Desktop: DSH_DESKTOP_SIGNING_MODE must be disabled or release')
}
