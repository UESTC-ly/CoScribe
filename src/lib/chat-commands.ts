export type ChatCommandName =
  | 'help'
  | 'compact'
  | 'fork'
  | 'resume'
  | 'new'
  | 'rename'
  | 'clear'
  | 'note'
  | 'stop'
  | 'quit'

export interface ChatCommandDefinition {
  name: ChatCommandName
  command: `/${ChatCommandName}`
  usage: string
  description: string
  acceptsArgument: boolean
}

export interface ChatCommandInvocation {
  name: ChatCommandName
  argument: string
  raw: string
}

export type ChatCommandParseResult =
  | { kind: 'command'; invocation: ChatCommandInvocation }
  | { kind: 'unknown'; command: string }
  | null

export const CHAT_COMMANDS: readonly ChatCommandDefinition[] = [
  { name: 'help', command: '/help', usage: '/help', description: '查看所有聊天命令', acceptsArgument: false },
  { name: 'compact', command: '/compact', usage: '/compact', description: '用 AI 全量压缩当前会话，原始记录仍保留', acceptsArgument: false },
  { name: 'fork', command: '/fork', usage: '/fork [新标题]', description: '从当前位置分叉为独立会话', acceptsArgument: true },
  { name: 'resume', command: '/resume', usage: '/resume [标题或 ID]', description: '恢复最近或指定的会话', acceptsArgument: true },
  { name: 'new', command: '/new', usage: '/new [标题]', description: '新建空白会话', acceptsArgument: true },
  { name: 'rename', command: '/rename', usage: '/rename <新标题>', description: '重命名当前会话', acceptsArgument: true },
  { name: 'clear', command: '/clear', usage: '/clear', description: '清空当前会话内容', acceptsArgument: false },
  { name: 'note', command: '/note', usage: '/note', description: '只整理上次之后新增的会话内容', acceptsArgument: false },
  { name: 'stop', command: '/stop', usage: '/stop', description: '停止当前 AI 任务', acceptsArgument: false },
  { name: 'quit', command: '/quit', usage: '/quit', description: '收起 AI 侧栏', acceptsArgument: false }
] as const

const COMMAND_BY_NAME = new Map(CHAT_COMMANDS.map((definition) => [definition.name, definition]))

export function parseChatCommand(value: string): ChatCommandParseResult {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u)
  if (!match) return { kind: 'unknown', command: trimmed }
  const name = match[1]?.toLowerCase() ?? ''
  const definition = COMMAND_BY_NAME.get(name as ChatCommandName)
  if (!definition) return { kind: 'unknown', command: `/${name}` }
  return {
    kind: 'command',
    invocation: {
      name: definition.name,
      argument: (match[2] ?? '').trim(),
      raw: trimmed
    }
  }
}

export function chatCommandSuggestions(value: string): ChatCommandDefinition[] {
  const trimmedStart = value.trimStart()
  if (!trimmedStart.startsWith('/') || trimmedStart.includes('\n')) return []
  const token = trimmedStart.slice(1).split(/\s/u, 1)[0]?.toLowerCase() ?? ''
  return CHAT_COMMANDS.filter((definition) => definition.name.startsWith(token))
}
