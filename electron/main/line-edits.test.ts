import { describe, it, expect } from 'vitest'
import { applyLineEdits, normalizeLineEdits, validateEditOperation } from './line-edits'
import type { LineEdit } from '../../src/shared/types'

describe('applyLineEdits', () => {
  it('returns original content when edits array is empty', () => {
    const original = 'line1\nline2\nline3'
    const result = applyLineEdits(original, [])
    expect(result).toBe(original)
  })

  it('replaces a single line', () => {
    const original = 'line1\nline2\nline3'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 2, newContent: 'modified' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('line1\nmodified\nline3')
  })

  it('deletes lines with empty newContent', () => {
    const original = 'line1\nline2\nline3\nline4'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 3, newContent: '' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('line1\nline4')
  })

  it('replaces multiple lines with single line', () => {
    const original = 'line1\nline2\nline3\nline4\nline5'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 4, newContent: 'replacement' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('line1\nreplacement\nline5')
  })

  it('replaces single line with multiple lines', () => {
    const original = 'line1\nline2\nline3'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 2, newContent: 'new1\nnew2\nnew3' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('line1\nnew1\nnew2\nnew3\nline3')
  })

  it('applies multiple non-overlapping edits', () => {
    const original = 'a\nb\nc\nd\ne'
    const edits: LineEdit[] = [
      { startLine: 1, endLine: 1, newContent: 'A' },
      { startLine: 3, endLine: 3, newContent: 'C' },
      { startLine: 5, endLine: 5, newContent: 'E' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('A\nb\nC\nd\nE')
  })

  it('handles edits at the beginning and end of file', () => {
    const original = 'first\nmiddle\nlast'
    const edits: LineEdit[] = [
      { startLine: 1, endLine: 1, newContent: 'FIRST' },
      { startLine: 3, endLine: 3, newContent: 'LAST' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('FIRST\nmiddle\nLAST')
  })

  it('throws error when startLine < 1', () => {
    const original = 'line1\nline2'
    const edits: LineEdit[] = [
      { startLine: 0, endLine: 1, newContent: 'x' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('起始行号必须 >= 1')
  })

  it('throws error when endLine < startLine', () => {
    const original = 'line1\nline2\nline3'
    const edits: LineEdit[] = [
      { startLine: 3, endLine: 1, newContent: 'x' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('不能小于起始行号')
  })

  it('throws error when startLine exceeds file length', () => {
    const original = 'line1\nline2\nline3'
    const edits: LineEdit[] = [
      { startLine: 10, endLine: 10, newContent: 'x' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('超出文件范围')
  })

  it('throws error when endLine exceeds file length', () => {
    const original = 'line1\nline2\nline3'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 10, newContent: 'x' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('超出文件范围')
  })

  it('throws error when edits are not sorted', () => {
    const original = 'line1\nline2\nline3\nline4'
    const edits: LineEdit[] = [
      { startLine: 3, endLine: 3, newContent: 'x' },
      { startLine: 1, endLine: 1, newContent: 'y' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('必须按起始行号升序排列')
  })

  it('throws error when edits overlap', () => {
    const original = 'line1\nline2\nline3\nline4\nline5'
    const edits: LineEdit[] = [
      { startLine: 2, endLine: 4, newContent: 'x' },
      { startLine: 3, endLine: 5, newContent: 'y' }
    ]
    expect(() => applyLineEdits(original, edits)).toThrow('编辑范围重叠')
  })

  it('allows adjacent edits (non-overlapping)', () => {
    const original = 'line1\nline2\nline3\nline4\nline5'
    const edits: LineEdit[] = [
      { startLine: 1, endLine: 2, newContent: 'A' },
      { startLine: 3, endLine: 4, newContent: 'B' }
    ]
    const result = applyLineEdits(original, edits)
    expect(result).toBe('A\nB\nline5')
  })
})

describe('normalizeLineEdits', () => {
  it('returns edits for a well-formed array', () => {
    expect(normalizeLineEdits([{ startLine: 2, endLine: 3, newContent: 'x' }]))
      .toEqual([{ startLine: 2, endLine: 3, newContent: 'x' }])
  })

  it('returns null for a missing, empty, or non-array payload', () => {
    expect(normalizeLineEdits(undefined)).toBeNull()
    expect(normalizeLineEdits([])).toBeNull()
    expect(normalizeLineEdits('2-3')).toBeNull()
  })

  it('returns null when line numbers are not integers', () => {
    expect(normalizeLineEdits([{ startLine: '2', endLine: 3, newContent: 'x' }])).toBeNull()
    expect(normalizeLineEdits([{ startLine: 2.5, endLine: 3, newContent: 'x' }])).toBeNull()
  })

  it('returns null when newContent is not a string', () => {
    expect(normalizeLineEdits([{ startLine: 2, endLine: 3 }])).toBeNull()
    expect(normalizeLineEdits([{ startLine: 2, endLine: 3, newContent: 42 }])).toBeNull()
  })
})

describe('validateEditOperation', () => {
  it('allows edit operation with edits array', () => {
    expect(() => {
      validateEditOperation({
        kind: 'edit',
        edits: [{ startLine: 1, endLine: 1, newContent: 'x' }]
      })
    }).not.toThrow()
  })

  it('accepts an edit that also carries proposedContent', () => {
    // Models routinely send both fields; the edits win and content is ignored.
    expect(() => {
      validateEditOperation({
        kind: 'edit',
        edits: [{ startLine: 1, endLine: 1, newContent: 'x' }],
        proposedContent: 'whole file rewrite'
      })
    }).not.toThrow()
  })

  it('throws when edit operation has no usable edits array', () => {
    expect(() => validateEditOperation({ kind: 'edit', edits: [] }))
      .toThrow('edit 操作必须提供有效的 edits 数组')
    expect(() => validateEditOperation({ kind: 'edit' }))
      .toThrow('edit 操作必须提供有效的 edits 数组')
  })

  it('allows create/append/replace with proposedContent', () => {
    expect(() => {
      validateEditOperation({ kind: 'create', proposedContent: 'content' })
      validateEditOperation({ kind: 'append', proposedContent: 'content' })
      validateEditOperation({ kind: 'replace', proposedContent: 'content' })
    }).not.toThrow()
  })

  it('ignores a stray edits array on a whole-file operation', () => {
    expect(() => {
      validateEditOperation({
        kind: 'replace',
        proposedContent: 'content',
        edits: [{ startLine: 1, endLine: 1, newContent: 'x' }]
      })
    }).not.toThrow()
  })

  it('throws when create/append/replace missing proposedContent', () => {
    expect(() => {
      validateEditOperation({ kind: 'create' })
    }).toThrow('create 操作必须提供 proposedContent 字段')
  })
})
