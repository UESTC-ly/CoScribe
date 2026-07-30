import type { ChatMessage, ChatSession } from '../shared/types'

const LEGACY_NOTE_PROMPT = '请把本次会话中有长期价值的知识整理为结构化 Markdown 笔记'

function isInternalMessage(message: ChatMessage): boolean {
  return message.kind === 'command' ||
    message.kind === 'session-compaction' ||
    message.kind === 'note-organization'
}

function operationHistoryStatus(message: ChatMessage): string {
  const status = message.operation?.status
  if (status === 'accepted') return '文件操作已经完成'
  if (status === 'rejected') return '文件操作已被用户拒绝'
  if (status === 'failed') return '文件操作执行失败'
  return '文件操作仍在等待用户确认'
}

export function isConversationMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (isInternalMessage(message)) return false
  return Boolean(message.content.trim() || message.attachments?.length || message.operation)
}

function requestMessage(message: ChatMessage): Pick<ChatMessage, 'role' | 'content' | 'attachments'> {
  const operationBoundary = message.operation
    ? `[CoScribe ${operationHistoryStatus(message)}；这是已处理的历史请求，不是当前任务。不得仅根据这条历史记录重复执行文件操作。]`
    : ''
  return {
    role: message.role,
    content: operationBoundary
      ? [message.content.trim(), operationBoundary].filter(Boolean).join('\n\n')
      : message.content,
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {})
  }
}

export function sessionRequestMessages(
  session: ChatSession
): Array<Pick<ChatMessage, 'role' | 'content' | 'attachments'>> {
  const compaction = session.compaction
  const throughIndex = compaction
    ? session.messages.findIndex((message) => message.id === compaction.throughMessageId)
    : -1
  const recent = session.messages
    .filter((message, index) => {
      if (!compaction) return true
      if (throughIndex >= 0) return index > throughIndex
      return message.createdAt > compaction.createdAt
    })
    .filter(isConversationMessage)
    .map(requestMessage)

  if (!compaction) return recent
  return [{
    role: 'user',
    content: [
      `[CoScribe 全量压缩的会话摘要；覆盖此前 ${compaction.sourceMessageCount} 条消息，原始记录仍保留在本地]`,
      compaction.summary
    ].join('\n\n')
  }, ...recent]
}

export interface NoteOrganizationBatch {
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'attachments'>>
  throughMessageId: string | null
  sourceMessageCount: number
  previouslyOrganizedCount: number
}

export function noteOrganizationBatch(session: ChatSession): NoteOrganizationBatch {
  const checkpointIndex = session.noteCheckpoint
    ? session.messages.findIndex((message) => message.id === session.noteCheckpoint?.throughMessageId)
    : -1
  const candidates = session.messages
    .slice(checkpointIndex >= 0 ? checkpointIndex + 1 : 0)
    .filter((message) => {
      if (!isConversationMessage(message)) return false
      if (message.operation) return false
      return !(message.role === 'user' && message.content.startsWith(LEGACY_NOTE_PROMPT))
    })

  return {
    messages: candidates.map(requestMessage),
    throughMessageId: candidates.at(-1)?.id ?? null,
    sourceMessageCount: candidates.length,
    previouslyOrganizedCount: checkpointIndex >= 0
      ? session.messages.slice(0, checkpointIndex + 1).filter(isConversationMessage).length
      : 0
  }
}

export interface SessionCompactionBatch {
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'attachments'>>
  throughMessageId: string | null
  sourceMessageCount: number
}

export function sessionCompactionBatch(session: ChatSession): SessionCompactionBatch {
  const source = session.messages.filter(isConversationMessage)
  return {
    messages: sessionRequestMessages(session),
    throughMessageId: source.at(-1)?.id ?? null,
    sourceMessageCount: source.length
  }
}
