# dsh-update-policy

English | [中文](README.zh.md)

`@harness-desktop/dsh-update-policy` verifies a decoded signed update manifest and selects one redacted artifact. It accepts only exact plain-object records, valid Ed25519 signatures, strict semantic versions, configured HTTPS origins, a supported consumer and target, lowercase SHA-256 digests, and safe archive member paths. Rejections return stable codes without returning a URL, signature, key identifier, or archive payload.

The package is a parser and policy only. It does not download artifacts, install software, restart an application, or provide a trust configuration. Consumers supply the application identity, installed version, selected channel, target, allowed origins, and public keys. `EMPTY_UPDATE_TRUST` is the shipped fail-closed default.

## Public API

The package entry exports `UpdateChannel`, `SignedUpdateManifest`, `UpdateManifestPolicy`, `RedactedUpdateArtifact`, `verifySignedUpdateManifest`, `canonicalizeSignedUpdateManifest`, and `EMPTY_UPDATE_TRUST`.

`verifySignedUpdateManifest()` canonicalizes artifacts and members before checking the detached signature. `desktop` accepts a universal macOS DMG, Windows NSIS, and Linux AppImage or Deb for a concrete architecture. `cli` accepts ZIP or tar.gz standalone archives. Consumer filtering happens before target ambiguity handling, so one installation cannot accept another consumer's artifact.

## Model Experience

### Update manifest policy

#### What the model sees

No model request includes this package's parsed manifest, trust values, or verification result.

#### Token effect

`0` direct tokens: the package does not register a prompt, tool schema, or model result.

#### KV Cache effect

No model request changes, so this package does not invalidate a reusable model prefix.

## Known Limitations and Deferred Work

- **Production trust configuration** — `EMPTY_UPDATE_TRUST` intentionally contains no release origin or public key, so a consumer must supply audited production trust before any candidate can be accepted.
