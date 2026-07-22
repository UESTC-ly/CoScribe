import { describe, expect, it } from 'vitest'

import { buildReviewMatrix, matrixRowFor, parseReviewMatrix, syncMatrixRows } from '../../src/plugins/review-matrix/matrix-utils'
import { normalizeReference } from '../../src/plugins/references/reference-utils'

describe('literature review matrix utilities', () => {
  it('round-trips escaped table cells and status through portable Markdown', () => {
    const reference = normalizeReference({ id: 'ref-1', citeKey: 'smith2024', title: 'A | B', authors: ['Ada Smith'], year: 2024, tags: ['RAG'] }, 1)
    const row = { ...matrixRowFor(reference), method: '混合方法 | 访谈', findings: '第一行\n第二行', status: 'reviewed' as const }
    const markdown = buildReviewMatrix([row])
    expect(markdown).toContain('<!-- coscribe:literature-matrix:start -->')
    expect(parseReviewMatrix(markdown)).toEqual([row])
  })

  it('syncs renamed references without discarding researcher annotations', () => {
    const original = normalizeReference({ id: 'ref-1', citeKey: 'old', title: 'Old', authors: [], tags: [] }, 1)
    const row = { ...matrixRowFor(original), findings: '保留结论' }
    const renamed = normalizeReference({ ...original, citeKey: 'new', title: 'New', tags: ['重要'] }, 2)
    expect(syncMatrixRows([row], [renamed])).toEqual([{ ...row, citeKey: 'new', title: 'New', tags: ['重要'] }])
  })
})
