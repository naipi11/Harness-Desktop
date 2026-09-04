/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @harness-desktop/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@harness-desktop/cordis',
  '@harness-desktop/dsh-client-ui-slots',
  '@harness-desktop/dsh-client-web-react',
  '@harness-desktop/dsh-client-ui-primitives',
  '@harness-desktop/dsh-client-ui-attachment',
  '@harness-desktop/dsh-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
