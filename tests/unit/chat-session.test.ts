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

  it('never restores raw pre-compaction history when the boundary message is unavailable', () => {
    const value = session()
    value.messages = [
      { id: 'old-user', role: 'user', content: '不得恢复的旧问题', createdAt: 1 },
      { id: 'old-assistant', role: 'assistant', content: '不得恢复的旧回答', createdAt: 2 },
      { id: 'new-user', role: 'user', content: '压缩后的问题', createdAt: 5 },
      { id: 'new-assistant', role: 'assistant', content: '压缩后的回答', createdAt: 6 }
    ]
    value.compaction = {
      summary: '旧会话的高保真摘要',
      throughMessageId: 'missing-boundary',
      sourceMessageCount: 2,
      createdAt: 4
    }

    const messages = sessionRequestMessages(value)

    expect(messages.map((message) => message.content)).toEqual([
      expect.stringContaining('旧会话的高保真摘要'),
      '压缩后的问题',
      '压缩后的回答'
    ])
    expect(JSON.stringify(messages)).not.toContain('不得恢复')
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

  it('keeps a completed file write from becoming an unfinished instruction in the next request', () => {
    const value = session()
    value.messages = [
      {
        id: 'memory-request',
        role: 'user',
        content: '请把这条稳定信息整理后加入项目记忆',
        createdAt: 1
      },
      {
        id: 'memory-result',
        role: 'assistant',
        content: '',
        createdAt: 2,
        operation: {
          id: 'operation-1',
          kind: 'replace',
          targetPath: '/projects/example/.coscribe/COSCRIBE.md',
          proposedContent: '# 项目记忆',
          summary: '更新项目记忆',
          status: 'accepted'
        }
      },
      {
        id: 'next-request',
        role: 'user',
        content: '这个项目有哪些核心模块？',
        createdAt: 3
      }
    ]

    const messages = sessionRequestMessages(value)

    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: expect.stringMatching(/文件操作.*已经完成.*不是当前任务/u)
    })
    expect(messages.at(-1)).toEqual({ role: 'user', content: '这个项目有哪些核心模块？' })
  })

  it('compacts the logical conversation without including internal command messages', () => {
    const batch = sessionCompactionBatch(session())
    expect(batch.throughMessageId).toBe('a2')
    expect(batch.sourceMessageCount).toBe(4)
    expect(batch.messages.map((message) => message.content)).toEqual(['旧问题', '旧回答', '新增问题', '新增回答'])
  })
})
