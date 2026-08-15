import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopBridge } from './bridge.ts'

contextBridge.exposeInMainWorld(
  'harnessDesktop',
  createDesktopBridge(channel => ipcRenderer.invoke(channel)),
)
