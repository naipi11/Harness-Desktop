/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @stackstackstack/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@stackstackstack/dsh-client-ui-slots',
  '@stackstackstack/dsh-client-web-react',
  '@stackstackstack/dsh-client-ui-primitives',
  '@stackstackstack/dsh-client-ui-attachment',
  '@stackstackstack/dsh-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
