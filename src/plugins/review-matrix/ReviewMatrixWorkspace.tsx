import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Grid3X3, RefreshCw, Save, Sparkles } from 'lucide-react'

import type { FileReadResult, LiteratureMatrixRow, LiteratureReviewStatus, ResearchReference } from '../../shared/types'
import { normalizeReference } from '../references/reference-utils'
import {
  buildReviewMatrix,
  parseReviewMatrix,
  REVIEW_MATRIX_PATH,
  syncMatrixRows
} from './matrix-utils'

interface ReviewMatrixWorkspaceProps {
  aiConfigured: boolean
  onOpenMarkdown: (path: string) => void
  onProjectChanged: () => void | Promise<void>
  onGenerateWithAi: (references: ResearchReference[], rows: LiteratureMatrixRow[]) => void | Promise<void>
  onOpenSettings: () => void
}

function referencesFrom(value: unknown): ResearchReference[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const raw = (value as { references?: unknown }).references
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): ResearchReference[] => {
    try { return [normalizeReference(item as Partial<ResearchReference>)] }
    catch { return [] }
  })
}

async function readOrCreateMatrix(): Promise<FileReadResult> {
  try { return await window.coscribe.file.read(REVIEW_MATRIX_PATH) }
  catch (reason) {
    if (!/(?:不存在|找不到|ENOENT|not found)/iu.test(String(reason))) throw reason
    try { return await window.coscribe.file.createMarkdown(REVIEW_MATRIX_PATH, buildReviewMatrix([])) }
    catch (createError) {
      if (!/(?:存在|EEXIST)/iu.test(String(createError))) throw createError
      return window.coscribe.file.read(REVIEW_MATRIX_PATH)
    }
  }
}

const FIELDS: Array<{ key: keyof Pick<LiteratureMatrixRow, 'researchQuestion' | 'method' | 'sample' | 'findings' | 'limitations' | 'evidence'>; label: string }> = [
  { key: 'researchQuestion', label: '研究问题' },
  { key: 'method', label: '方法' },
  { key: 'sample', label: '样本 / 数据' },
  { key: 'findings', label: '主要发现' },
  { key: 'limitations', label: '局限' },
  { key: 'evidence', label: '证据位置' }
]

export default function ReviewMatrixWorkspace(props: ReviewMatrixWorkspaceProps): React.JSX.Element {
  const [document, setDocument] = useState<FileReadResult | null>(null)
  const [references, setReferences] = useState<ResearchReference[]>([])
  const [rows, setRows] = useState<LiteratureMatrixRow[]>([])
  const [savedRows, setSavedRows] = useState<LiteratureMatrixRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setMessage(null)
    try {
      const [file, stored] = await Promise.all([readOrCreateMatrix(), window.coscribe.plugins.data('references')])
      const nextReferences = referencesFrom(stored)
      const parsed = parseReviewMatrix(file.content)
      const synced = syncMatrixRows(parsed, nextReferences)
      setDocument(file)
      setReferences(nextReferences)
      setRows(synced)
      setSavedRows(parsed)
      await props.onProjectChanged()
      if (!nextReferences.length) setMessage('文献库为空。请先启用“文献与引用”插件并加入文献，再同步矩阵。')
      else if (synced.length !== parsed.length) setMessage(`发现 ${synced.length - parsed.length} 篇尚未写入矩阵的文献，点击“保存矩阵”即可同步。`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '文献综述矩阵读取失败。')
    } finally { setLoading(false) }
  }, [props.onProjectChanged])

  useEffect(() => { void load() }, [load])

  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(savedRows), [rows, savedRows])
  const reviewed = rows.filter((row) => row.status === 'reviewed').length
  const filled = rows.filter((row) => row.findings.trim() || row.method.trim()).length

  const updateRow = <K extends keyof LiteratureMatrixRow>(referenceId: string, key: K, value: LiteratureMatrixRow[K]): void => {
    setRows((current) => current.map((row) => row.referenceId === referenceId ? { ...row, [key]: value } : row))
  }

  const save = async (): Promise<void> => {
    if (!document) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.coscribe.file.saveMarkdown(document.path, buildReviewMatrix(rows), document.modifiedAt)
      setDocument(result)
      setSavedRows(rows)
      await props.onProjectChanged()
      setMessage('矩阵已保存为普通 Markdown。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '矩阵保存失败；请刷新后重试。')
    } finally { setSaving(false) }
  }

  const generate = async (): Promise<void> => {
    if (!props.aiConfigured || !references.length) return
    setMessage(null)
    try {
      await props.onGenerateWithAi(references, rows)
      setMessage('AI 已在聊天侧边栏生成受限文件操作预览；确认后再刷新矩阵。')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'AI 矩阵补全失败。') }
  }

  return (
    <section className="plugin-workspace matrix-workspace" aria-label="文献综述矩阵插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Grid3X3 size={23} /></span><div><small>EVIDENCE REVIEW MATRIX</small><h1>文献综述矩阵</h1><p>{REVIEW_MATRIX_PATH} · 未找到证据的字段应保持空白</p></div></div>
        <div className="research-hero-actions"><button className="secondary-button" type="button" disabled={!document} onClick={() => document && props.onOpenMarkdown(document.path)}>Markdown <ArrowUpRight size={14} /></button><button className="secondary-button" type="button" onClick={() => void load()}><RefreshCw size={14} />刷新</button><button className="primary-button" type="button" disabled={!dirty || saving || !document} onClick={() => void save()}><Save size={14} />保存矩阵</button></div>
      </header>

      <div className="matrix-metrics"><article><strong>{references.length}</strong><small>文献库记录</small></article><article><strong>{rows.length}</strong><small>矩阵行</small></article><article><strong>{filled}</strong><small>已有方法或发现</small></article><article><strong>{reviewed}</strong><small>完成阅读</small></article></div>
      {message && <p className="plugin-inline-message research-message" role="status">{message}</p>}

      {loading ? <div className="plugin-loading"><span className="viewer-spinner" />正在同步文献与矩阵…</div> : rows.length ? <div className="matrix-table-shell">
        <table className="matrix-table">
          <thead><tr><th>文献</th><th>状态</th>{FIELDS.map((field) => <th key={field.key}>{field.label}</th>)}<th>标签</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.referenceId}>
            <th scope="row"><small>{row.citeKey} · {row.year ?? 'n.d.'}</small><strong>{row.title}</strong></th>
            <td><select aria-label={`${row.title} 阅读状态`} value={row.status} onChange={(event) => updateRow(row.referenceId, 'status', event.target.value as LiteratureReviewStatus)}><option value="unread">未读</option><option value="reading">阅读中</option><option value="reviewed">已完成</option></select></td>
            {FIELDS.map((field) => <td key={field.key}><textarea aria-label={`${row.title} ${field.label}`} value={row[field.key]} onChange={(event) => updateRow(row.referenceId, field.key, event.target.value)} rows={4} /></td>)}
            <td><textarea aria-label={`${row.title} 标签`} value={row.tags.join(', ')} onChange={(event) => updateRow(row.referenceId, 'tags', event.target.value.split(/[,，;\n]/u).map((tag) => tag.trim()).filter(Boolean))} rows={4} /></td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="plugin-empty"><Grid3X3 size={30} /><strong>还没有可比较的文献</strong><p>先在“文献与引用”中导入记录，随后刷新本页。</p></div>}

      <aside className="matrix-ai-bar"><div><Sparkles size={18} /><span><strong>AI 证据辅助</strong><small>AI 只能更新固定矩阵文件，且必须保留矩阵标记；没有项目证据时不得猜测。</small></span></div><button className="primary-button" type="button" disabled={!props.aiConfigured || !references.length} onClick={() => void generate()}><Sparkles size={14} />基于项目资料补全</button>{!props.aiConfigured && <button className="text-button" type="button" onClick={props.onOpenSettings}>先配置 AI</button>}</aside>
    </section>
  )
}
