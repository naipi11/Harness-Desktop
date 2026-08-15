import { expect, it } from 'vitest'
import { createWindowOptions } from '../src/main/window-options.ts'

it('keeps the desktop window sandboxed behind the supplied preload', () => {
  const options = createWindowOptions('C:\\app\\preload.js')

  expect(options.webPreferences).toEqual({
    preload: 'C:\\app\\preload.js',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  })
})
