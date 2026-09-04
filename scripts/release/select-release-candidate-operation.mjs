/** Validate one manual release-candidate selection without performing it. */

const operations = [
  ['sign-windows', 'SIGN_WINDOWS'],
  ['notarize-macos', 'NOTARIZE_MACOS'],
  ['sign-update-manifests', 'SIGN_UPDATE_MANIFESTS'],
  ['publish-npm', 'PUBLISH_NPM'],
  ['create-github-release', 'CREATE_GITHUB_RELEASE'],
]

const selected = []
for (const [operation, environmentName] of operations) {
  const value = process.env[environmentName]
  if (value !== 'true' && value !== 'false') {
    throw new Error(`release candidate: ${environmentName} must be true or false`)
  }
  if (value === 'true') selected.push(operation)
}
if (selected.length !== 1) throw new Error('release candidate: select exactly one operation')

process.stdout.write(`Validated ${selected[0]}; this workflow performs no release action.\n`)
