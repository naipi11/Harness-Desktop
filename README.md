# Harness Desktop

English | [中文](README.zh.md)

Harness Desktop (`harness`) is an open-source agent harness.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

Harness Desktop is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then install the CLI globally and run:

```sh
npm install -g @harness-desktop/cli
harness web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

For a background server, use `harness web --daemon` (or `--background`); the parent prints the child PID and its private log path, then exits.

The CLI is published as `@harness-desktop/cli`; `dsh` remains a compatible command name with the same data and profile layout.

`harness update` (or `dsh update`) follows the detected install form. An npm installation prints `npm update -g @harness-desktop/cli` but does not run it. See the [CLI update reference](apps/cli/README.md#update) for standalone verification and rollback behavior.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/naipi11/Harness-Desktop.git
cd Harness-Desktop
pnpm install
pnpm run build
pnpm harness web
```

`pnpm harness web` starts the Web UI in the foreground. Use `pnpm harness web --daemon` (or `--background`) for a background server; the parent prints the child PID and its private log path, then exits.

### Desktop app

The Electron client supports Windows, macOS, and Linux. Installer distribution is signing-ready but approval-gated: Windows signing, macOS notarization, update-manifest signing, npm publication, update upload, and GitHub Release creation each require separate authorization. To run from a repository checkout:

```sh
git clone https://github.com/naipi11/Harness-Desktop.git
cd Harness-Desktop
pnpm install
pnpm run build
pnpm desktop
```

To build an installer for the current platform:

```sh
pnpm --filter @harness-desktop/dsh-desktop run package
```

The release artifact and evidence matrix is:

| Platform | Desktop artifact | Standalone CLI artifact | Native evidence owner |
|---|---|---|---|
| Windows | NSIS | ZIP | Windows CI |
| macOS | Universal DMG | tar.gz | macOS CI, including `lipo` inspection |
| Linux | AppImage and Deb | tar.gz | Linux CI |

CI builds every row with `--publish never`; a local current-platform build does not prove another operating system's artifacts. For an unpacked directory instead of an installer, replace `package` with `package:dir`. Local artifacts land in `apps/desktop/release/`.

Desktop and CLI shipped defaults are fail-closed: they contain no production update public key, configured exact HTTPS origin, or release location, so no live automatic update is configured. Enabling updates requires those prerequisites to be audited separately from every external release approval above.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/naipi11/Harness-Desktop/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
