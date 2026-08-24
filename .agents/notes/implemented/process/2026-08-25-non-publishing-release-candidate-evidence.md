# Agent Note: Non-publishing release-candidate evidence

Status: implemented

English | [中文](2026-08-25-non-publishing-release-candidate-evidence.zh.md)

## Problem

The [Desktop artifact matrix](../feature/2026-08-16-desktop-release-config.md) packages without publication, and the [shared signed-update policy](../architecture/2026-08-24-shared-signed-update-policy.md) verifies one consumer target without choosing between compatible formats. Release readiness still needs deterministic signed metadata, proof against the exact local artifact bytes, native-format ownership, and updater rollback checks. Giving pull-request jobs release credentials or dormant publication commands would make evidence collection capable of changing external release state.

## Decision

`scripts/release/build-update-manifest.ts` accepts caller-named local artifacts and an Ed25519 private-key file. It derives the SHA-256 digest and archive members locally, emits one manifest for each channel, consumer, platform, architecture, and format, and places exactly one selectable artifact in each manifest. Every manifest uses `io.github.naipi11.harness-desktop`; Linux AppImage and Deb endpoints remain separate instead of adding a format preference to the shared policy. The builder signs only after every input is available in memory and verifies the result through `verifySignedUpdateManifest()`. It exclusively writes the complete set to a randomly named sibling directory, rejects a pre-existing output directory, and publishes with one directory rename; a staged write failure leaves no final or staged set.

`scripts/release/verify-update-manifests.ts` reads a caller-supplied Ed25519 public-key file and invokes the shared parser and signature verifier before enforcing the release layout: the signed manifest must contain exactly one artifact matching the expected channel, consumer, platform, architecture, and format. It reads the named artifact once and rejects a SHA-256 mismatch before archive parsing or native execution. Path-based inspectors receive a private file containing that exact snapshot, while ZIP inspection consumes the bytes in memory. AppImage inspection receives a minimal environment. ZIP and tar inspection is portable; NSIS, DMG, AppImage, and Deb inspection uses the matching native runner. The scripts neither download artifacts nor retain a release location, key, signature, or manifest fixture in the repository.

`.github/workflows/desktop-artifacts.yml` remains credential-free and runs Builder with `--publish never`. Windows owns NSIS and CLI ZIP evidence, macOS owns universal DMG and CLI tar evidence with `lipo` inspection, and Linux owns AppImage, Deb, and CLI tar evidence. Each runner invokes the tested `verify-node-runtime-archive.ts` command to check the repository-pinned filename and SHA-256 before the standalone builder may extract it, then runs Desktop and CLI updater or rollback checks after packaging. The workflow audit requires that exact command in the required order, so an echoed marker is not evidence. The Windows host does not stand in for the macOS or Linux jobs.

`.github/workflows/release-candidates.yml` is manual-dispatch-only. Its `sign-windows`, `notarize-macos`, `sign-update-manifests`, `publish-npm`, and `create-github-release` inputs default to false. The sole job checks out source without persisted credentials, then runs the tested `select-release-candidate-operation.mjs` command, which rejects any count other than one and reports the selected future operation without performing it. The workflow has no permission, release environment, credential, signing, notarization, publication, upload, or GitHub Release step, and its audit requires the exact validator command and input mapping.

## Alternatives considered

**Put every compatible format in one consumer manifest.** Rejected. The shared policy deliberately has no format preference, so two compatible artifacts are ambiguous. Separate target-format manifests keep selection explicit at the configured endpoint.

**Trust a checksum downloaded beside the Node archive.** Rejected. Files from one runtime source share the same trust path. The workflow reads the pinned SHA-256 from the repository and compares it before extraction or use.

**Commit fixture keys or make candidate jobs dormant behind false inputs.** Rejected. Committed signing material is reusable secret state, while dormant external commands still enlarge the workflow's authority. Tests generate temporary keys and artifacts; the candidate workflow validates isolation only.

## Consequences

Release evidence is reproducible and non-publishing: the exact local artifact, target identity, signature, digest, members, rollback version, and native smoke checks must agree before a candidate can advance. A future release implementation must add external operations under a separately reviewed authorization change; this workflow cannot sign, notarize, publish, upload updates, or create a GitHub Release. Native verification still depends on each operating-system runner and does not turn one host's result into cross-platform proof.
