import { FileEdit, History, RotateCcw } from 'lucide-react'

import type { AiOperationHistoryEntry } from '../../shared/types'

interface OperationHistoryViewProps {
  entries: AiOperationHistoryEntry[]
  undoingId: string | null
  onUndo: (entry: AiOperationHistoryEntry) => void | Promise<void>
  onOpen: (path: string) => void
}

function relativeTime(value: number): string {
  const minutes = Math.floor((Date.now() - value) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

function fileName(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value
}

export function OperationHistoryView(props: OperationHistoryViewProps): React.JSX.Element {
  if (!props.entries.length) return <div className="empty-state"><History size={23} /><strong>还没有 AI 文件操作</strong><span>AI 创建或修改 Markdown 后，这里会出现可核验的本地记录。</span></div>
  return (
    <div className="operation-history">
      <div className="operation-history__notice"><History size={15} /><p>撤销前会再次核对磁盘内容。如果文件后来被你修改，CoScribe 会拒绝覆盖。</p></div>
      {props.entries.map((entry) => (
        <article className={`operation-history__item is-${entry.status}`} key={entry.id}>
          <header><span><FileEdit size={15} /></span><div><strong>{entry.summary}</strong><small>{relativeTime(entry.appliedAt)} · {entry.operations.length} 个文件</small></div><em>{entry.status === 'applied' ? '已应用' : '已撤销'}</em></header>
          <div className="operation-history__files">{entry.operations.map((operation) => <button key={operation.targetPath} type="button" onClick={() => props.onOpen(operation.targetPath)}><span>{operation.kind === 'create' ? '新建' : operation.kind === 'append' ? '追加' : '替换'}</span><strong title={operation.targetPath}>{fileName(operation.targetPath)}</strong></button>)}</div>
          {entry.status === 'applied' ? <button className="secondary-button" type="button" disabled={props.undoingId === entry.id} onClick={() => void props.onUndo(entry)}><RotateCcw size={13} />{props.undoingId === entry.id ? '正在安全撤销…' : '撤销这次操作'}</button> : <p className="operation-history__undone">撤销于 {relativeTime(entry.undoneAt ?? entry.appliedAt)}</p>}
        </article>
      ))}
    </div>
  )
}
