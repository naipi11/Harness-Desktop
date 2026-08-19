# dsh-credentials-platform

English | [中文](README.zh.md)

Runtime-only [credentials](../credentials/README.md) provider: the harness home persists only opaque references, and every secret value resolves per request from a platform adapter. The default adapter reads the launcher's frozen process environment and is read-only; a writable adapter supplied by the Desktop host owns the durable secret store (keychain or platform vault), which this package never writes values into.

## Config

| Field | Default | Meaning |
|---|---|---|
| `harnessHome` | required | Absolute harness home beneath which the reference metadata document lives. |
| `adapter` | environment adapter | Platform adapter resolving values; omit for the read-only environment adapter. |

## The metadata document

`$HARNESS_HOME/.credential-references.json` records which references are configured:

```json
{
  "version": 1,
  "references": [
    "DEEPSEEK_API_KEY"
  ]
}
```

The document is a strict version-1 shape: a `version` plus a sorted `references` array, and nothing else. It holds opaque reference names only — a secret value never appears in it, in command lines, in logs, or in diagnostics. Writes persist the document atomically with mode `0600` under an owner-only (`0700`) directory via [`dsh-atomic-write`](../../util/atomic-write/README.md).

## Environment adapter

With no injected adapter, values come from the launcher's frozen process environment (the same snapshot [launch-environment](../../util/launch-environment/README.md) provides), empty values count as absent, and the adapter is read-only: `set` and `unset` reject because the process environment cannot be edited from inside. `describe()` reports `source: 'env', writable: false`.

## Security boundary

Values never enter files this package writes, so the reference metadata is not a secret-bearing document. The adapter is the only value holder: the read-only environment snapshot, or a writable platform store the model's tool processes cannot read. Storing a reference through a writable adapter persists the value there and adds the reference name to the metadata document.

## Known Limitations and Deferred Work

- **Environment changes are invisible** — the snapshot is frozen at launch, so a variable exported after startup reaches neither resolution nor `describe`; changing an environment-sourced credential takes a restart.
- **The environment adapter is read-only** — it cannot store a key; the Models-page write path needs a writable platform adapter injected by the Desktop host.
- **No hot reload** — an external change to the metadata document is not watched; reads always go through the adapter, so values are current per request.
- **OS-keychain adapter is deferred** — a platform vault is the intended writable store; the adapter seam exists, the concrete provider is future work.
