import { AlertCircle, Check, FileDiff, FilePlus2, FileText, FolderTree, Loader2, RotateCcw, X } from 'lucide-react'
import type { FileOperationProposal, MarkdownFileOperation } from '../../shared/types'

export interface MarkdownOperationCardProps {
  operation: FileOperationProposal
  busy?: boolean
  onAccept: (operation: FileOperationProposal) => void | Promise<void>
  onReject: (operation: FileOperationProposal) => void | Promise<void>
}

interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  value: string
  oldLine?: number
  newLine?: number
}

const MAX_DIFF_CELLS = 40_000
const MAX_VISIBLE_DIFF_LINES = 240

function buildLargeDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: DiffLine[] = before.slice(0, prefix).map((value, index) => ({
    kind: 'same',
    value,
    oldLine: index + 1,
    newLine: index + 1
  }))

  before.slice(prefix, before.length - suffix).forEach((value, index) => {
    rows.push({ kind: 'removed', value, oldLine: prefix + index + 1 })
  })
  after.slice(prefix, after.length - suffix).forEach((value, index) => {
    rows.push({ kind: 'added', value, newLine: prefix + index + 1 })
  })
  before.slice(before.length - suffix).forEach((value, index) => {
    rows.push({
      kind: 'same',
      value,
      oldLine: before.length - suffix + index + 1,
      newLine: after.length - suffix + index + 1
    })
  })

  return rows
}

function buildLineDiff(originalContent: string, proposedContent: string): DiffLine[] {
  const before = originalContent.replace(/\r\n/g, '\n').split('\n')
  const after = proposedContent.replace(/\r\n/g, '\n').split('\n')

  if (before.length * after.length > MAX_DIFF_CELLS) return buildLargeDiff(before, after)

  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0)
  )

  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] =
        before[oldIndex] === after[newIndex]
          ? lengths[oldIndex + 1][newIndex + 1] + 1
          : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1])
    }
  }

  const rows: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0

  while (oldIndex < before.length && newIndex < after.length) {
    if (before[oldIndex] === after[newIndex]) {
      rows.push({
        kind: 'same',
        value: before[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1
      })
      oldIndex += 1
      newIndex += 1
    } else if (lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1]) {
      rows.push({ kind: 'removed', value: before[oldIndex], oldLine: oldIndex + 1 })
      oldIndex += 1
    } else {
      rows.push({ kind: 'added', value: after[newIndex], newLine: newIndex + 1 })
      newIndex += 1
    }
  }

  while (oldIndex < before.length) {
    rows.push({ kind: 'removed', value: before[oldIndex], oldLine: oldIndex + 1 })
    oldIndex += 1
  }
  while (newIndex < after.length) {
    rows.push({ kind: 'added', value: after[newIndex], newLine: newIndex + 1 })
    newIndex += 1
  }

  return rows
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function OperationIcon({ kind }: Pick<FileOperationProposal, 'kind'>): React.JSX.Element {
  if (kind === 'create') return <FilePlus2 aria-hidden="true" />
  if (kind === 'append') return <FileText aria-hidden="true" />
  return <FileDiff aria-hidden="true" />
}

function operationItems(operation: FileOperationProposal): MarkdownFileOperation[] {
  return operation.operations?.length
    ? operation.operations
    : [{
        kind: operation.kind,
        targetPath: operation.targetPath,
        proposedContent: operation.proposedContent,
        ...(operation.originalContent !== undefined ? { originalContent: operation.originalContent } : {}),
        ...(operation.expectedModifiedAt !== undefined ? { expectedModifiedAt: operation.expectedModifiedAt } : {})
      }]
}

const operationLabels: Record<FileOperationProposal['kind'], string> = {
  create: '创建 Markdown',
  append: '追加内容',
  replace: '修改 Markdown'
}

export function MarkdownOperationCard({
  operation,
  busy = false,
  onAccept,
  onReject
}: MarkdownOperationCardProps): React.JSX.Element {
  const diff =
    operation.kind === 'replace'
      ? buildLineDiff(operation.originalContent ?? '', operation.proposedContent)
      : []
  const visibleDiff = diff.slice(0, MAX_VISIBLE_DIFF_LINES)
  const isPending = operation.status === 'pending'
  const items = operationItems(operation)
  const isBatch = items.length > 1

  return (
    <section
      className={`ai-operation ai-operation--${operation.status}`}
      aria-label={`${operationLabels[operation.kind]}建议`}
    >
      <header className="ai-operation__header">
        <span className="ai-operation__icon">
          {isBatch ? <FolderTree aria-hidden="true" /> : <OperationIcon kind={operation.kind} />}
        </span>
        <span className="ai-operation__heading">
          <span className="ai-operation__eyebrow">文件操作建议</span>
          <strong>{isBatch ? `创建笔记项目 · ${items.length} 个文件` : operationLabels[operation.kind]}</strong>
        </span>
        {operation.status !== 'pending' && (
          <span className={`ai-operation__status ai-operation__status--${operation.status}`}>
            {operation.status === 'accepted' && <Check aria-hidden="true" />}
            {operation.status === 'rejected' && <X aria-hidden="true" />}
            {operation.status === 'failed' && <AlertCircle aria-hidden="true" />}
            {operation.status === 'accepted' ? '已写入' : operation.status === 'rejected' ? '已拒绝' : '写入失败'}
          </span>
        )}
      </header>

      {isBatch ? (
        <div className="ai-operation__batch" aria-label="批量 Markdown 文件预览">
          {items.map((item, index) => (
            <details key={`${item.targetPath}-${index}`} open={index === 0}>
              <summary>
                <span><FilePlus2 aria-hidden="true" /><strong>{getFileName(item.targetPath)}</strong></span>
                <code title={item.targetPath}>{item.targetPath}</code>
                <em>{item.proposedContent.split(/\r?\n/u).length} 行</em>
              </summary>
              <pre tabIndex={0}><code>{item.proposedContent}</code></pre>
            </details>
          ))}
        </div>
      ) : (
        <div className="ai-operation__target">
          <span>目标</span>
          <strong title={operation.targetPath}>{getFileName(operation.targetPath)}</strong>
          <code title={operation.targetPath}>{operation.targetPath}</code>
        </div>
      )}

      {operation.summary && <p className="ai-operation__summary">{operation.summary}</p>}

      {!isBatch && operation.kind === 'replace' ? (
        <div className="ai-operation__preview">
          <div className="ai-operation__preview-title">
            <span>原文 / 新文差异</span>
            <span className="ai-operation__diff-legend" aria-hidden="true">
              <i className="ai-operation__legend-remove" /> 删除
              <i className="ai-operation__legend-add" /> 新增
            </span>
          </div>
          <div className="ai-diff" role="region" aria-label="Markdown 修改差异" tabIndex={0}>
            {visibleDiff.map((line, index) => (
              <div className={`ai-diff__line ai-diff__line--${line.kind}`} key={`${line.kind}-${index}`}>
                <span className="ai-diff__line-number">{line.oldLine ?? ''}</span>
                <span className="ai-diff__line-number">{line.newLine ?? ''}</span>
                <span className="ai-diff__marker">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                <code>{line.value || ' '}</code>
              </div>
            ))}
          </div>
          {diff.length > MAX_VISIBLE_DIFF_LINES && (
            <p className="ai-operation__truncated">
              预览仅展示前 {MAX_VISIBLE_DIFF_LINES} 行；确认时仍会应用完整修改。
            </p>
          )}
        </div>
      ) : !isBatch ? (
        <div className="ai-operation__preview">
          <div className="ai-operation__preview-title">
            <span>{operation.kind === 'create' ? '完整文件内容' : '将追加的内容'}</span>
            <span>{operation.proposedContent.split(/\r?\n/).length} 行</span>
          </div>
          <pre className="ai-operation__content" tabIndex={0}>
            <code>{operation.proposedContent}</code>
          </pre>
        </div>
      ) : null}

      {operation.status === 'failed' && operation.error && (
        <div className="ai-operation__error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{operation.error}</span>
        </div>
      )}

      {operation.status === 'accepted' && (
        <p className="ai-operation__result"><Check aria-hidden="true" /> 修改已写入项目文件。</p>
      )}
      {operation.status === 'rejected' && (
        <p className="ai-operation__result"><X aria-hidden="true" /> 已拒绝，磁盘文件没有变化。</p>
      )}

      {(isPending || operation.status === 'failed') && (
        <footer className="ai-operation__actions">
          <span className="ai-operation__safety">{isBatch ? '一次确认后写入整组文件' : '确认前不会修改磁盘文件'}</span>
          <button
            className="ai-button ai-button--quiet"
            type="button"
            disabled={busy}
            onClick={() => void onReject(operation)}
          >
            <X aria-hidden="true" />
            拒绝
          </button>
          <button
            className="ai-button ai-button--primary"
            type="button"
            disabled={busy}
            onClick={() => void onAccept(operation)}
          >
            {busy ? <Loader2 className="ai-spin" aria-hidden="true" /> : operation.status === 'failed' ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
            {busy ? '正在写入…' : operation.status === 'failed' ? '重新尝试' : '接受并写入'}
          </button>
        </footer>
      )}
    </section>
  )
}
