import type { LiteratureMatrixRow, LiteratureReviewStatus, ResearchReference } from '../../shared/types'

export const REVIEW_MATRIX_PATH = '研究/文献综述矩阵.md'
export const REVIEW_MATRIX_START = '<!-- coscribe:literature-matrix:start -->'
export const REVIEW_MATRIX_END = '<!-- coscribe:literature-matrix:end -->'

const STATUS_LABELS: Record<LiteratureReviewStatus, string> = {
  unread: '未读',
  reading: '阅读中',
  reviewed: '已完成'
}

const LABEL_STATUS: Record<string, LiteratureReviewStatus> = {
  未读: 'unread',
  阅读中: 'reading',
  已完成: 'reviewed'
}

function escapeCell(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>').trim()
}

function unescapeCell(value: string): string {
  return value.replace(/<br\s*\/?\s*>/giu, '\n').replace(/\\\|/gu, '|').replace(/\\\\/gu, '\\').trim()
}

function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of line.trim().replace(/^\|/u, '').replace(/\|$/u, '')) {
    if (escaped) {
      current += `\\${character}`
      escaped = false
    } else if (character === '\\') escaped = true
    else if (character === '|') {
      cells.push(unescapeCell(current))
      current = ''
    } else current += character
  }
  if (escaped) current += '\\'
  cells.push(unescapeCell(current))
  return cells
}

export function matrixRowFor(reference: ResearchReference): LiteratureMatrixRow {
  return {
    referenceId: reference.id,
    citeKey: reference.citeKey,
    title: reference.title,
    ...(reference.year ? { year: reference.year } : {}),
    researchQuestion: '',
    method: '',
    sample: '',
    findings: '',
    limitations: '',
    evidence: '',
    tags: [...reference.tags],
    status: 'unread'
  }
}

export function syncMatrixRows(rows: LiteratureMatrixRow[], references: ResearchReference[]): LiteratureMatrixRow[] {
  const byId = new Map(rows.map((row) => [row.referenceId, row]))
  const byKey = new Map(rows.map((row) => [row.citeKey.toLocaleLowerCase(), row]))
  return references.map((reference) => {
    const existing = byId.get(reference.id) ?? byKey.get(reference.citeKey.toLocaleLowerCase())
    return existing
      ? {
          ...existing,
          referenceId: reference.id,
          citeKey: reference.citeKey,
          title: reference.title,
          ...(reference.year ? { year: reference.year } : { year: undefined }),
          tags: [...new Set([...reference.tags, ...existing.tags])]
        }
      : matrixRowFor(reference)
  })
}

export function parseReviewMatrix(markdown: string): LiteratureMatrixRow[] {
  const start = markdown.indexOf(REVIEW_MATRIX_START)
  const end = markdown.indexOf(REVIEW_MATRIX_END)
  if (start < 0 || end <= start) return []
  const table = markdown.slice(start + REVIEW_MATRIX_START.length, end)
  const lines = table.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith('|'))
  return lines.slice(2).flatMap((line): LiteratureMatrixRow[] => {
    const cells = splitRow(line)
    if (cells.length < 12 || !cells[0]) return []
    const year = Number.parseInt(cells[3] ?? '', 10)
    return [{
      referenceId: cells[0],
      citeKey: cells[1] || cells[0],
      title: cells[2],
      ...(Number.isInteger(year) ? { year } : {}),
      status: LABEL_STATUS[cells[4]] ?? 'unread',
      researchQuestion: cells[5],
      method: cells[6],
      sample: cells[7],
      findings: cells[8],
      limitations: cells[9],
      evidence: cells[10],
      tags: cells[11].split(/[;,，]/u).map((tag) => tag.trim()).filter(Boolean)
    }]
  })
}

export function buildReviewMatrix(rows: LiteratureMatrixRow[]): string {
  const tableRows = rows.map((row) => [
    row.referenceId,
    row.citeKey,
    row.title,
    row.year ? String(row.year) : '',
    STATUS_LABELS[row.status],
    row.researchQuestion,
    row.method,
    row.sample,
    row.findings,
    row.limitations,
    row.evidence,
    row.tags.join(', ')
  ].map(escapeCell).join(' | '))
  return [
    '# 文献综述矩阵',
    '',
    '> 这是 CoScribe 可读写的普通 Markdown。每一行对应一篇文献；AI 修改仍需预览确认。',
    '',
    REVIEW_MATRIX_START,
    '| reference_id | citekey | 文献 | 年份 | 状态 | 研究问题 | 方法 | 样本 / 数据 | 主要发现 | 局限 | 证据位置 | 标签 |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...tableRows.map((row) => `| ${row} |`),
    REVIEW_MATRIX_END,
    '',
    '## 综合判断',
    '',
    '- 共识：',
    '- 分歧：',
    '- 研究空白：',
    '- 下一步检索方向：',
    ''
  ].join('\n')
}
