import productMetadata from '../../packages/boot/app-boot/product.json' with { type: 'json' }

/** Installer matrix for Harness Desktop; every target stays non-publishing. */
export default {
  appId: productMetadata.appId,
  productName: productMetadata.productName,
  executableName: 'harness-desktop',
  directories: { output: 'release' },
  files: ['out/**', 'package.json'],
  asar: true,
  publish: null,
  win: { target: ['nsis'] },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    category: 'public.app-category.developer-tools',
  },
  linux: { target: ['AppImage', 'deb'], category: 'Development' },
}
