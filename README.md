# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Native CLI artifacts

Release CI produces standalone CLI archives for Linux x64/arm64, macOS x64/arm64, and Windows x64. POSIX archives are named `dsh-<version>-<platform>-<arch>.tar.gz`; Windows uses `.zip`. Each archive has a matching `.sha256` file and contains the native `node-pty` assets for its target.

On Linux or macOS, download the matching archive and checksum, verify, then extract it:

```sh
sha256sum -c dsh-<version>-linux-x64.tar.gz.sha256
tar -xzf dsh-<version>-linux-x64.tar.gz
./dsh-<version>-linux-x64 --help
```

On Windows PowerShell, verify and extract the Windows archive:

```powershell
$sum = Get-Content .\dsh-<version>-win-x64.zip.sha256 -Raw
$parts = $sum.Trim() -split '\s+', 2
if ((Get-FileHash .\dsh-<version>-win-x64.zip -Algorithm SHA256).Hash.ToLower() -ne $parts[0].ToLower()) { throw 'checksum mismatch' }
Expand-Archive .\dsh-<version>-win-x64.zip -DestinationPath .
dsh-<version>-win-x64.exe --help
```

These are CLI-only archives. They do not claim Electron, DMG, MSI, AppImage, or Python-wheel support. Build a native target locally with `DSH_CLI_TARGET=node24-linux-x64 pnpm run build:cli-exe`.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
