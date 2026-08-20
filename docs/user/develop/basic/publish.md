# Internal bundle and profile formats

English | [中文](publish.zh.md)

This page is retained as an internal format reference for composition **bundles** and **profiles**. The public `dsh` product grammar has no plugin installation, profile boot, patch, or config-dump command, so the former workflow is not an executable user tutorial. Complete [plugin configuration](./config.md) for current plugin authoring guidance.

For the supported interactive, run, Web, and Desktop commands, see the [CLI behavior reference](../../../../apps/cli/reference/README.md#source-execution). The manifests below describe internal Runtime composition and test fixtures only.

## Two concepts, two manifests

Installation is built on two concepts. Both are described by a `package.json`, but they carry different kinds of manifest under the `dsh` key, and they answer different questions:

- A **bundle** is an npm package that ships a configuration layer. Its manifest declares `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts or overrides plugin rows.
- A **profile** is an internal directory under `$HARNESS_HOME/profiles/<name>` describing one Runtime composition. Its manifest declares `dsh.profile`, answering "which bundles compose this setup, in what order?".

A bundle is a distributable configuration layer; a profile is an internal composition record. The public CLI boots neither by name.

### The bundle manifest

Create the package directory:

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

Create `hello-plugin/package.json`:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Create `hello-plugin/index.js` with the plugin entry point:

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

Create `hello-plugin/cordis.patch.yml`. The patch is a YAML array whose plugin rows reference the package by name instead of a relative source path so Node resolution finds installed code:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

A package without the `dsh.bundle` declaration is a plain dependency and activates no layer. Use that package format for a library that plugin packages import rather than a composition bundle.

### The profile manifest

A profile directory holds two files:

- `package.json` — the profile's out-of-tree plugin dependencies (managed by pnpm) plus the `dsh.profile` manifest with its ordered `bundles` list.
- `cordis.patch.yml` — the user's own patch layer, applied after every bundle layer.

Internal Runtime provisioning owns profile creation and maintenance. The next section shows the stored format; the public CLI does not create it.

## Internal profile assembly

Profile provisioning is internal. There is no supported public command that installs a bundle into a profile or boots that profile by name:

```sh
# No public CLI command installs or boots profiles.
```

An internal profile record may list `@harness-desktop/dsh-base` first and then the bundle that declares `dsh.bundle`:

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@harness-desktop/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

Composition inspection and profile boot are internal app-boot operations:

```sh
# No public CLI command dumps or boots an internal profile.
```

An internal profile manager must update both the dependency and the bundle list when removing a layer.

## The loading order

The effective configuration composes over an empty root by applying, in order:

1. Each bundle patch named in the profile's `dsh.profile.bundles` list, in list order — `@harness-desktop/dsh-base` first, then each installed bundle in the order it was added.
2. The profile's own `cordis.patch.yml`.
3. The home-level `$HARNESS_HOME/cordis.patch.yml` — machine-local preferences shared by internal profiles.
4. Any app-boot overlay supplied by the internal composition owner.

App arguments are not another patch layer. A surface bundle can resolve them through an ordinary app-owned service, described below.

Later layers win per row, and a patch replaces a row's entire `config` value rather than deep-merging keys. Two consequences for bundle authors:

- Your patch can override rows from earlier layers by `id` — the same way [the `dsh-web-app` bundle](../../../../packages/bundle/web-app/cordis.patch.yml) overrides `dsh-base` rows — but must restate every key the row needs, not just the changed one.
- An internal deployment owner can override rows in the profile's `cordis.patch.yml` without touching the package, so prefer durable configuration defaults and let the schema carry the rest.

In-box bundle names always resolve from the dsh installation itself; pnpm manages only out-of-tree packages, so your bundle can rely on `@harness-desktop/dsh-base` being present and current.

## Give a surface bundle its own command line

A bundle that defines a runnable app mounts an ordinary provider plugin:

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

The plugin exports `inject = ['cmdlineArgs']`, calls `parseCmdline` from [`@harness-desktop/dsh-cmdline`](../../../../packages/boot/cmdline/README.md) with its own commander program, and provides its app-owned service from the program's action. The launcher hands every plugin the same immutable arguments after launcher flags, so app-specific flags need no launcher change and multiple plugins may parse the snapshot. The Loader row needs no launcher marker or special kind.

Rows configured by those arguments inject the provider's service and read it from their own `!!js` options, with the deployment value beside it as the fallback:

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

On `--help`, the provider publishes no service, so those rows never activate. Loader mounts the composition once, waits for each row's ordinary injections, and only then evaluates that row's `!!js` config against its injected context.

## Installing from GitHub: the build-script catch

Internal provisioning may install straight from a git host with pnpm:

```sh
pnpm add github:you/hello-plugin
```

But a git install fetches **sources, not built artifacts**: nothing runs your `build` script, so a TypeScript package arrives without its `lib/` output and fails to load. Two things must happen, one on each side:

- **The author** ships a `prepare` script — pnpm runs it after a git install — that builds the published entry points from source, self-contained: it must not assume dev-only context such as a sibling monorepo checkout. [turtle-ui](https://github.com/deepseek-harness/turtle-ui) is a working example: its `prepare` runs a dedicated tsdown config that transpiles `src/` without project references or type checking.
- **The internal deployment owner** allowlists the build. pnpm ≥10 refuses to run a git dependency's `prepare` script until it is explicitly allowed, so the first `add` fails; copy the exact package key pnpm printed into the internal profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  and re-run the `add`.

Treat that allowance as what it is: **permission to execute the package's code on your machine at install time**, outside any sandbox the agent runs under. Only allow packages whose source you trust, and pin a commit (`github:you/hello-plugin#<sha>`) so a later push cannot silently change what runs.

If you would rather not ask users for the allowance, distribute built artifacts instead — neither form needs any build permission:

- **Publish to npm** with `lib/` built at `pnpm publish` time so internal provisioning receives prebuilt code.
- **Ship a tarball** from `pnpm pack` for the internal package manager.

## Next steps

- [Plugins and lifecycle](../framework/) — the full plugin lifecycle
- [CLI behavior reference](../../../../apps/cli/reference/README.md) — supported interactive, run, Web, and Desktop grammar
