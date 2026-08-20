/** Production-private Runtime control assembly and bootstrap ownership. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@harness-desktop/cordis'
import { mountAuthenticatedConnection } from '@harness-desktop/dsh-client-connection'
import type { ApiProxy } from '@harness-desktop/dsh-host-apiproxy/api'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { mountPrivateRuntimeControl, type PrivateRuntimeControl } from '../src/runtime-control.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface TimerCapture {
  readonly callbacks: Array<() => void>
  setTimer(callback: () => void): ReturnType<typeof setTimeout>
}

async function start(
  openBootstrap: (url: string) => Promise<void>,
  clock: { now: number } = { now: 0 },
): Promise<{ control: PrivateRuntimeControl; timers: TimerCapture; origin: string }> {
  root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-'))
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  context.provide('apiProxy', {} as ApiProxy)
  const origin = `http://127.0.0.1:${String(context.webServer.port)}`
  const callbacks: Array<() => void> = []
  const timers: TimerCapture = {
    callbacks,
    setTimer(callback) {
      callbacks.push(callback)
      return {} as ReturnType<typeof setTimeout>
    },
  }
  let control!: PrivateRuntimeControl
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext) {
      control = mountPrivateRuntimeControl(routeContext, {
        accessToken: 'private-endpoint-token',
        origin,
        bootstrapParent: root!,
        openBootstrap,
        now: () => clock.now,
        cleanup: {
          now: () => clock.now,
          setTimer: timers.setTimer,
          clearTimer() {},
        },
        mountAuthenticatedDashboard(auth) {
          mountAuthenticatedConnection(routeContext, { authorize: request => auth.authorizeDashboard(request) })
        },
      })
    },
  }).await()
  return { control, timers, origin }
}

async function expectRemoved(fileUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await readFile(fileURLToPath(fileUrl), 'utf8').then(
      () => undefined,
      error => error as NodeJS.ErrnoException,
    )
    if (result?.code === 'ENOENT') return
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  await expect(readFile(fileURLToPath(fileUrl), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('private Runtime control assembly', () => {
  it('owns an undispatched bootstrap document until its handoff expiry cleanup', async () => {
    const opened: string[] = []
    const { control, timers } = await start(async (url) => { opened.push(url) })

    await control.openDashboard()

    expect(opened).toHaveLength(1)
    expect(opened[0]).not.toContain('handoff')
    expect(await readFile(fileURLToPath(opened[0]!), 'utf8')).toContain('name="handoff"')
    expect(timers.callbacks).toHaveLength(1)
    timers.callbacks[0]!()
    await expectRemoved(opened[0]!)
  })

  it('cleans the owned bootstrap document when native dispatch fails', async () => {
    let attempted!: string
    const { control } = await start(async (url) => {
      attempted = url
      throw new Error('browser dispatch failed')
    })

    await expect(control.openDashboard()).rejects.toThrow('browser dispatch failed')
    await expectRemoved(attempted)
  })

  it('cleans the owned bootstrap document after accepted and rejected form exchanges', async () => {
    const opened: string[] = []
    const clock = { now: 0 }
    const { control, origin } = await start(async (url) => { opened.push(url) }, clock)

    await control.openDashboard()
    const acceptedUrl = opened[0]!
    const acceptedHandoff = /name="handoff" value="([^"]+)"/.exec(await readFile(fileURLToPath(acceptedUrl), 'utf8'))?.[1]
    expect(acceptedHandoff).toBeDefined()
    const accepted = await fetch(`${origin}/_harness/handoff`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: acceptedHandoff! }),
    })
    expect(accepted.status).toBe(303)
    expect((await fetch(`${origin}/api/session.list`, {
      method: 'POST',
      headers: { cookie: accepted.headers.get('set-cookie')!, origin },
    })).status).not.toBe(403)
    await expectRemoved(acceptedUrl)

    await control.openDashboard()
    const rejectedUrl = opened[1]!
    const rejectedHandoff = /name="handoff" value="([^"]+)"/.exec(await readFile(fileURLToPath(rejectedUrl), 'utf8'))?.[1]
    clock.now = 60_000
    const rejected = await fetch(`${origin}/_harness/handoff`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: rejectedHandoff! }),
    })
    expect(rejected.status).toBe(403)
    await expectRemoved(rejectedUrl)
  })
})
