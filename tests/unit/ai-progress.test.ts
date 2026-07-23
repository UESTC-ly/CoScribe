import { describe, expect, it } from 'vitest'

import { mergeAiProgress } from '../../src/lib/ai-progress'

describe('AI progress timeline', () => {
  it('completes the previous active stage as real work advances', () => {
    const preparing = mergeAiProgress(undefined, {
      kind: 'note-organization',
      stage: 'preparing',
      label: '筛选新增会话',
      updatedAt: 1
    })
    const context = mergeAiProgress(preparing, {
      kind: 'note-organization',
      stage: 'context',
      label: '读取项目资料',
      updatedAt: 2
    })

    expect(context.steps).toEqual([
      expect.objectContaining({ stage: 'preparing', status: 'complete' }),
      expect.objectContaining({ stage: 'context', status: 'active' })
    ])
  })

  it('records a terminal completion state', () => {
    const completed = mergeAiProgress(undefined, {
      kind: 'session-compaction',
      stage: 'complete',
      label: '全量压缩完成',
      status: 'complete',
      updatedAt: 3
    })
    expect(completed.status).toBe('complete')
  })
})
