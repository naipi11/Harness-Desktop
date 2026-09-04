import { contextBridge, ipcRenderer } from 'electron'
import {
  desktopChannels,
  type DesktopInvoke,
  type DesktopNotification,
} from '../shared/desktop-api.ts'
import { createDesktopBridge } from './bridge.ts'

type DesktopChannel = (typeof desktopChannels)[keyof typeof desktopChannels]

const invoke = ((channel: DesktopChannel, payload?: DesktopNotification | string) => payload === undefined
  ? ipcRenderer.invoke(channel)
  : ipcRenderer.invoke(channel, payload)) as DesktopInvoke

contextBridge.exposeInMainWorld(
  'harnessDesktop',
  createDesktopBridge(invoke),
)
