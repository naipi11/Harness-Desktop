/** Shell-owned bilingual workbench copy follows the shared locale service. */
export const workbenchCopy = {
  en: {
    workspace: 'Workspace', noSession: 'No active session', workbench: 'Engineering workbench',
    files: 'Files', diff: 'Diff', terminal: 'Terminal', artifacts: 'Artifacts', tasks: 'Tasks',
    idle: 'Idle', status: 'Active work status', stop: 'Stop my active work',
    focus: 'Focus', restore: 'Restore Dashboard', enterFocus: 'Enter focus mode', exitFocus: 'Exit focus mode',
    panels: 'Workbench panels', open: 'Open', noFiles: 'This folder is empty',
    noWorkspace: 'Choose a workspace to view its files.', loading: 'Loading…', fileError: 'Could not read this folder. Retry or select another folder.',
    retry: 'Retry', up: 'Parent folder', root: 'Workspace root', collapse: 'Hide tools', show: 'Show tools',
    truncated: 'Some entries are omitted. Open a subfolder to narrow the list.',
    noTerminal: 'Start a local terminal to run commands. No model API key is required.',
    terminalInput: 'Terminal input', send: 'Run command', start: 'Start terminal', close: 'Close terminal', interrupt: 'Interrupt',
    terminalError: 'Terminal operation failed. Restart the terminal and try again.',
    terminalHint: 'Command terminal · runs locally with your permissions, not sent to AI. Full-screen/interactive programs are not supported. Close terminates running commands.',
    terminalExited: 'Terminal exited', noArtifacts: 'No artifacts yet', noTasks: 'No active tasks', complete: 'Complete', noDiff: 'No diff available',
  },
  zh: {
    workspace: '工作区', noSession: '尚未选择会话', workbench: '工程工作台',
    files: '文件', diff: '差异', terminal: '终端', artifacts: '产物', tasks: '任务',
    idle: '空闲', status: '运行状态', stop: '停止我的任务',
    focus: '专注', restore: '恢复对话', enterFocus: '进入专注模式', exitFocus: '退出专注模式',
    panels: '工作台面板', open: '打开', noFiles: '此文件夹为空',
    noWorkspace: '选择工作区后查看文件。', loading: '正在加载…', fileError: '无法读取此文件夹，请重试或选择其他文件夹。',
    retry: '重试', up: '上一级', root: '工作区根目录', collapse: '收起工具面板', show: '展开工具面板',
    truncated: '部分条目未显示，请打开子文件夹缩小范围。',
    noTerminal: '启动本地终端即可运行命令，无需模型 API 密钥。',
    terminalInput: '终端命令', send: '运行命令', start: '启动终端', close: '关闭终端', interrupt: '中断',
    terminalError: '终端操作失败，请重新启动终端后重试。',
    terminalHint: '命令终端 · 以你的权限在本机运行，不发送给 AI。不支持全屏或交互式程序；关闭终端会停止正在运行的命令。',
    terminalExited: '终端已退出', noArtifacts: '暂无产物', noTasks: '暂无任务', complete: '完成', noDiff: '暂无差异',
  },
} as const

/** Localized workbench dictionary. */
export type WorkbenchCopy = { readonly [K in keyof typeof workbenchCopy.en]: string }
