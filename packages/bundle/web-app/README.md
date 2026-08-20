# `@harness-desktop/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and browser plugin roster, mounts the always-on client-plugin reload chain ([`dsh-client-hmr`](../../client/hmr/README.md)), and mounts this package's `web-runtime` glue plugin (config `{printUrl, surfaceContext, trustedHosts}`). That plugin resolves the built frontend dist, provides internal Web runtime state, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, and registers the Web prompt and `DSH_WEB_URL` contributions selected by its config. The `web-startup` provider ([`src/startup.ts`](src/startup.ts)) still parses host, port, trusted-host, and help arguments for internal app-boot compositions and tests through [`dsh-cmdline`](../../boot/cmdline/README.md). The public product parser does not forward those options: `dsh web` attaches to the shared Runtime and accepts only its documented open, lease, status, and stop options. [`dsh-headless`](../headless/README.md) is an internal sibling surface over the same base and does not mount this bundle.

The CLI consumes the Web-only `--daemon` and `--background` aliases before it provides this bundle's cleaned arguments. `web-startup` therefore retains ownership of host, port, trusted-host, and help parsing; its `--help` path does not start the server.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
