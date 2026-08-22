import productMetadata from '../../packages/boot/app-boot/product.json' with { type: 'json' }

/** Installer matrix for Harness Desktop; every target stays non-publishing. */
export default {
  appId: productMetadata.appId,
  productName: productMetadata.productName,
  executableName: 'harness-desktop',
  directories: { output: 'release' },
  files: ['out/**', 'package.json', 'resources/icons/**'],
  asar: true,
  // Windows keeps pnpm's target-native payload because electron-builder's rebuild
  // of the patched node-pty dependency mutates the shared linked-worktree store;
  // macOS/Linux retain builder rebuilds for their target and universal payloads.
  npmRebuild: process.platform !== 'win32',
  publish: null,
  win: { target: ['nsis'], icon: 'resources/icons/win/harness-desktop.ico' },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    icon: 'resources/icons/mac/harness-desktop.icns',
    category: 'public.app-category.developer-tools',
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'resources/icons/linux/harness-desktop-512.png',
    category: 'Development',
  },
}
