/** Native application menu uses the operating-system language. */
import { expect, it } from 'vitest'
import { desktopMenuTemplate } from '../src/main/desktop-menu.ts'

it('provides Chinese native menu labels on a Chinese Windows desktop', () => {
  const menu = desktopMenuTemplate('zh-CN')
  expect(menu.map(item => item.label)).toEqual(['文件', '编辑', '视图', '窗口'])
  expect(desktopMenuTemplate('en-US').map(item => item.label)).toEqual(['File', 'Edit', 'View', 'Window'])
})
