/** Desktop Main-process compatibility exports for the shared signed update policy. */

export {
  EMPTY_UPDATE_TRUST as PRODUCTION_DESKTOP_UPDATE_TRUST,
  canonicalizeSignedUpdateManifest as canonicalizeDesktopUpdateManifest,
  verifySignedUpdateManifest as verifyDesktopUpdateManifest,
} from '@harness-desktop/dsh-update-policy'

export type {
  RedactedUpdateArtifact as RedactedDesktopUpdateArtifact,
  SignedUpdateManifest as SignedDesktopUpdateManifest,
  UpdateArchitecture as DesktopUpdateArchitecture,
  UpdateArtifact as DesktopUpdateArtifact,
  UpdateArtifactFormat as DesktopUpdateArtifactFormat,
  UpdateManifestPayload as DesktopUpdateManifestPayload,
  UpdateManifestPolicy as DesktopUpdateManifestPolicy,
  UpdateManifestRejectionCode as DesktopUpdateManifestRejectionCode,
  UpdateManifestVerification as DesktopUpdateManifestVerification,
  UpdatePlatform as DesktopUpdatePlatform,
  UpdateTrust as DesktopUpdateManifestTrust,
} from '@harness-desktop/dsh-update-policy'
