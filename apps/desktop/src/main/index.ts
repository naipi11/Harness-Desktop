import { join } from 'node:path'
import { productMetadata } from '@deepseek-ai/dsh-app-boot/product-metadata'
import { app, BrowserWindow, ipcMain } from 'electron'
import { desktopChannels } from '../shared/desktop-api.ts'
import { createWindowOptions } from './window-options.ts'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createWindowOptions(join(__dirname, '../preload/index.mjs')),
  )

  window.once('ready-to-show', () => {
    window.show()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl !== undefined) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.setAppUserModelId(productMetadata.appId)
ipcMain.handle(desktopChannels.productMetadata, () => productMetadata)

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
