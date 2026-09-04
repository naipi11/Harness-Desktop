# dsh-update-policy

English | [中文](README.zh.md)

`@harness-desktop/dsh-update-policy` verifies a decoded signed update manifest and selects one exact artifact for a source owner. It accepts only exact plain-object records, valid Ed25519 signatures, strict semantic versions, configured HTTPS origins, a supported consumer, platform, architecture, and format, lowercase SHA-256 digests, and safe archive member paths. Rejections return stable codes without the raw manifest, signature, key identifier, or archive payload.

The package parses and selects manifests, validates public release policies, and makes restricted HTTPS reads. It does not install software, restart an application, persist update state, or provide production trust. Consumers supply the application identity, installed version, selected channel, target, allowed origins, and public keys. `EMPTY_UPDATE_TRUST` is the library-level fail-closed empty configuration.

## Public API

Core manifest exports include `UpdateChannel`, `SignedUpdateManifest`, `UpdateManifestPolicy`, `RedactedUpdateArtifact`, `VerifiedUpdateArtifact`, `verifySignedUpdateManifest`, `canonicalizeSignedUpdateManifest`, and `EMPTY_UPDATE_TRUST`; the release-policy and restricted-HTTPS exports appear below. `VerifiedUpdateArtifact` carries the manifest-authenticated HTTPS URL only to the immediate downloader; it is not a durable Runtime outcome or installer request.

`parseReleaseUpdateConfiguration()` validates schema version 3 of a public-only embedded policy. Its five-field candidate key identifies a channel, consumer, platform, architecture, and format; its six-field rollback key adds the exact installed semantic version. `nativeWorkerReadyTimeoutMs` bounds native worker preparation before Main hands off control, while `healthCheckTimeoutMs` bounds waiting for the old process and, after installation, candidate Dashboard health. `fetchAllowedUpdateJson()` / `fetchAllowedUpdateBytes()` enforce allowed HTTPS origins and byte limits. `verifySignedUpdateManifest()` canonicalizes artifacts and members before checking the detached signature. `desktop` accepts a universal macOS ZIP or DMG, Windows NSIS, and Linux AppImage or Deb for a concrete architecture. `cli` accepts ZIP or tar.gz archives. Consumer and exact-format filtering happen before target ambiguity handling, so one installation cannot accept another consumer's artifact.

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
