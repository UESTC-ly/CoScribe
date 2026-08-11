import type { LineEdit } from '../../src/shared/types'

/**
 * Apply multiple line edits to original content.
 *
 * Requirements:
 * - edits must be sorted by startLine ascending
 * - line numbers are 1-based
 * - edits must not overlap
 * - edits are applied from back to front to avoid line number shifts
 *
 * @param originalContent - Original file content
 * @param edits - Array of line edits to apply
 * @returns Modified content
 * @throws Error if edits are invalid (out of range, overlapping, etc.)
 */
export function applyLineEdits(originalContent: string, edits: LineEdit[]): string {
  if (!edits || edits.length === 0) {
    return originalContent
  }

  const lines = originalContent.split('\n')
  const totalLines = lines.length

  // Validate and check for overlaps
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]

    // Validate line numbers
    if (edit.startLine < 1) {
      throw new Error(`起始行号必须 >= 1，实际为 ${edit.startLine}`)
    }
    if (edit.endLine < edit.startLine) {
      throw new Error(`结束行号 ${edit.endLine} 不能小于起始行号 ${edit.startLine}`)
    }
    if (edit.startLine > totalLines) {
      throw new Error(`起始行号 ${edit.startLine} 超出文件范围（共 ${totalLines} 行）`)
    }
    if (edit.endLine > totalLines) {
      throw new Error(`结束行号 ${edit.endLine} 超出文件范围（共 ${totalLines} 行）`)
    }

    // Check sorting
    if (i > 0 && edit.startLine < edits[i - 1].startLine) {
      throw new Error('编辑列表必须按起始行号升序排列')
    }

    // Check overlaps
    if (i > 0 && edit.startLine <= edits[i - 1].endLine) {
      throw new Error(`编辑范围重叠：第 ${i} 个编辑 (${edit.startLine}-${edit.endLine}) 与第 ${i - 1} 个编辑 (${edits[i - 1].startLine}-${edits[i - 1].endLine}) 冲突`)
    }
  }

  // Apply edits from back to front to avoid line number shifts
  const result = [...lines]
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]
    const startIdx = edit.startLine - 1 // Convert to 0-based
    const endIdx = edit.endLine // Exclusive end for slice

    // Split new content into lines
    const newLines = edit.newContent ? edit.newContent.split('\n') : []

    // Replace the range [startIdx, endIdx) with newLines
    result.splice(startIdx, endIdx - startIdx, ...newLines)
  }

  return result.join('\n')
}

/**
 * Normalize an untrusted `edits` payload into LineEdit[].
 * Returns null when the payload cannot be used as line edits, so callers can
 * fall back to a whole-file operation instead of failing the whole proposal.
 */
export function normalizeLineEdits(value: unknown): LineEdit[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const edits: LineEdit[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const { startLine, endLine, newContent } = candidate as Record<string, unknown>
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null
    if (typeof newContent !== 'string') return null
    edits.push({ startLine: startLine as number, endLine: endLine as number, newContent })
  }
  return edits
}

/**
 * Validate that an operation carries the fields its kind needs.
 *
 * Deliberately lenient about extra fields: models routinely send both `edits`
 * and `proposedContent`. For an `edit` the edits win and `proposedContent` is
 * ignored; for other kinds a stray `edits` array is ignored.
 *
 * @throws Error when the fields the kind actually needs are missing or malformed
 */
export function validateEditOperation(operation: {
  kind: string
  proposedContent?: string
  edits?: unknown
}): void {
  if (operation.kind === 'edit') {
    if (!normalizeLineEdits(operation.edits)) {
      throw new Error('edit 操作必须提供有效的 edits 数组（startLine、endLine 为整数，newContent 为字符串）')
    }
    return
  }
  if (typeof operation.proposedContent !== 'string') {
    throw new Error(`${operation.kind} 操作必须提供 proposedContent 字段`)
  }
}
