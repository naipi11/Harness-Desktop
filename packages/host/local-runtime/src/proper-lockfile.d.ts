/** Narrow type declaration for the recovery guard's proper-lockfile usage. */
declare module 'proper-lockfile' {
  export default function lock(path: string, options: {
    lockfilePath: string
    realpath: false
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number }
    stale: number
    update: number
  }): Promise<() => Promise<void>>
}
