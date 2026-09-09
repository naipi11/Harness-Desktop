# dsh-credentials-platform

English | [中文](README.zh.md)

Runtime-only [credentials](../credentials/README.md) provider: the harness home persists only opaque references. Windows defaults to Credential Manager with local-machine persistence; manual values override the launcher's frozen environment. Other platforms use a read-only environment adapter unless the host supplies one.

## Config

| Field | Default | Meaning |
|---|---|---|
| `harnessHome` | required | Absolute harness home beneath which the reference metadata document lives. |
| `adapter` | OS-selected adapter | Optional replacement for Windows Credential Manager or the read-only environment fallback. |

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

The provider loads and validates this strict version-1 document before becoming ready; an absent document means no recorded references. The only fields are `version` and a sorted, unique `references` array. It holds opaque reference names only — a secret value never appears in it, in command lines, in logs, or in diagnostics. Writes persist the document atomically with mode `0600` under an owner-only (`0700`) directory via [`dsh-atomic-write`](../../util/atomic-write/README.md).

## Platform and environment adapters

Windows stores UTF-8 values in generic credentials namespaced by the canonical Harness home and reference, with `CRED_PERSIST_LOCAL_MACHINE`. Values survive application restart but do not roam to another computer. The Windows API limits each value to 2,560 bytes. `unset` removes the OS override and may reactivate an environment value. Only a genuinely absent OS entry permits fallback; access failures reject with a value-free error. `describe()` reports storage capability independently of the current source, so an environment-backed value remains editable on Windows.

The environment fallback reads the launcher's frozen process layer through [launch-environment](../../util/launch-environment/README.md). Empty values are absent. On platforms without an OS adapter, `set` and `unset` reject and `describe()` reports `writable: false`.

## Security boundary

Values never enter files this package writes. Windows protects the vault under the signed-in user's account; other processes running as that user may access it, so the vault is not a sandbox against same-user code. Mutable buffers are cleared after use; JavaScript strings cannot be reliably zeroized. The browser receives only configured/source/writable metadata, never the stored value.

Mutations issued to one provider instance are serialized. The provider atomically persists candidate reference metadata before calling the adapter, so a metadata-write failure leaves the adapter untouched. An adapter mutation must reject without changing its durable value; when it rejects, the provider restores the previous metadata and reports the adapter failure, including a metadata-rollback failure if both occur. After both commits succeed, the provider publishes the update. Concurrently mounting multiple provider instances or processes against the same `HARNESS_HOME` is unsupported because their independently loaded metadata snapshots can lose a reference update.

## Model Experience

Indirectly, through provider adapters that resolve credential references for their own model calls.

#### KV Cache effect

None; this provider neither assembles nor changes model-visible request content.

## Known Limitations and Deferred Work

- **Environment changes are invisible** — the snapshot is frozen at launch; Windows users can override it without restarting by saving a manual value.
- **Non-Windows defaults remain read-only** — those hosts need a writable adapter.
- **No hot reload** — an external change to the metadata document is not watched; reads always go through the adapter, so values are current per request.
