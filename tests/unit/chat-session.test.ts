import { describe, expect, it } from 'vitest'

import type { ChatSession } from '../../src/shared/types'
import {
  noteOrganizationBatch,
  sessionCompactionBatch,
  sessionRequestMessages
} from '../../src/lib/chat-session'

function session(): ChatSession {
  return {
    id: 'session-1',
    title: '学习',
    createdAt: 1,
    updatedAt: 6,
    messages: [
      { id: 'u1', role: 'user', content: '旧问题', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '旧回答', createdAt: 2 },
      { id: 'n1', role: 'assistant', content: '已整理', createdAt: 3, kind: 'note-organization' },
      { id: 'u2', role: 'user', content: '新增问题', createdAt: 4 },
      { id: 'a2', role: 'assistant', content: '新增回答', createdAt: 5 },
      { id: 'c1', role: 'system', content: '压缩完成', createdAt: 6, kind: 'session-compaction' }
    ]
  }
}

describe('chat session request boundaries', () => {
  it('uses a durable full-summary plus only messages after its boundary', () => {
    const value = session()
    value.compaction = {
      summary: '旧问题与旧回答的完整语义摘要',
      throughMessageId: 'a1',
      sourceMessageCount: 2,
      createdAt: 3
    }

    expect(sessionRequestMessages(value)).toEqual([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('完整语义摘要') }),
      { role: 'user', content: '新增问题' },
      { role: 'assistant', content: '新增回答' }
    ])
  })

  it('returns only conversation content added after the note checkpoint', () => {
    const value = session()
    value.noteCheckpoint = {
      throughMessageId: 'a1',
      sourceMessageCount: 2,
      organizedAt: 3,
      targetPaths: ['notes/old.md']
    }

    expect(noteOrganizationBatch(value)).toMatchObject({
      messages: [
        { role: 'user', content: '新增问题' },
        { role: 'assistant', content: '新增回答' }
      ],
      throughMessageId: 'a2',
      sourceMessageCount: 2,
      previouslyOrganizedCount: 2
    })
  })

  it('compacts the logical conversation without including internal command messages', () => {
    const batch = sessionCompactionBatch(session())
    expect(batch.throughMessageId).toBe('a2')
    expect(batch.sourceMessageCount).toBe(4)
    expect(batch.messages.map((message) => message.content)).toEqual(['旧问题', '旧回答', '新增问题', '新增回答'])
  })
})
