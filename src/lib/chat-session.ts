import type { ChatMessage, ChatSession } from '../shared/types'

const LEGACY_NOTE_PROMPT = '请把本次会话中有长期价值的知识整理为结构化 Markdown 笔记'

function isInternalMessage(message: ChatMessage): boolean {
  return message.kind === 'command' ||
    message.kind === 'session-compaction' ||
    message.kind === 'note-organization'
}

export function isConversationMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (isInternalMessage(message)) return false
  return Boolean(message.content.trim() || message.attachments?.length)
}

function requestMessage(message: ChatMessage): Pick<ChatMessage, 'role' | 'content' | 'attachments'> {
  return {
    role: message.role,
    content: message.content,
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
    .slice(throughIndex >= 0 ? throughIndex + 1 : 0)
    .filter(isConversationMessage)
    .map(requestMessage)

  if (!compaction || throughIndex < 0) return recent
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
