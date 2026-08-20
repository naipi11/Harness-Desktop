import productMetadata from '../../packages/boot/app-boot/product.json' with { type: 'json' }

/** Installer matrix for Harness Desktop; every target stays non-publishing. */
export default {
  appId: productMetadata.appId,
  productName: productMetadata.productName,
  executableName: 'harness-desktop',
  directories: { output: 'release' },
  files: ['out/**', 'package.json', 'resources/icons/**'],
  asar: true,
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
