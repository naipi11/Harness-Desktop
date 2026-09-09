/** Native menu translation independent of renderer availability. */
import type { MenuItemConstructorOptions } from 'electron'

/**
 * Build the standard native menu in the operating-system language.
 * @param locale - Electron's resolved application locale.
 * @returns native menu entries preserving standard editing and window roles.
 */
export function desktopMenuTemplate(locale: string): MenuItemConstructorOptions[] {
  const zh = locale.toLowerCase().startsWith('zh')
  const label = (english: string, chinese: string): string => zh ? chinese : english
  return [
    { label: label('File', '文件'), submenu: [{ role: 'close', label: label('Close window', '关闭窗口') }] },
    { label: label('Edit', '编辑'), submenu: [
      { role: 'undo', label: label('Undo', '撤销') }, { role: 'redo', label: label('Redo', '重做') },
      { type: 'separator' },
      { role: 'cut', label: label('Cut', '剪切') }, { role: 'copy', label: label('Copy', '复制') },
      { role: 'paste', label: label('Paste', '粘贴') }, { role: 'selectAll', label: label('Select all', '全选') },
    ] },
    { label: label('View', '视图'), submenu: [
      { role: 'reload', label: label('Reload', '刷新') },
      { role: 'resetZoom', label: label('Actual size', '实际大小') },
      { role: 'zoomIn', label: label('Zoom in', '放大') }, { role: 'zoomOut', label: label('Zoom out', '缩小') },
      { role: 'togglefullscreen', label: label('Toggle full screen', '切换全屏') },
    ] },
    { label: label('Window', '窗口'), submenu: [{ role: 'minimize', label: label('Minimize', '最小化') }] },
  ]
}
