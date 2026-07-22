import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  BookMarked,
  Clipboard,
  FilePlus2,
  FileText,
  Import,
  Library,
  Plus,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'

import type { FileKind, ResearchReference, ResearchReferenceType } from '../../shared/types'
import {
  bibTeXFor,
  citationToken,
  formattedReference,
  mergeReferences,
  normalizeReference,
  parseBibTeX,
  parseRis,
  referenceNoteMarkdown,
  referenceNotePath
} from './reference-utils'

type ReferenceFile = { path: string; name: string; kind: FileKind }
type ReferenceDraft = {
  id?: string
  citeKey: string
  type: ResearchReferenceType
  title: string
  authors: string
  year: string
  journal: string
  doi: string
  url: string
  pdfPath: string
  abstract: string
  tags: string
  notes: string
}

interface ReferencesWorkspaceProps {
  files: ReferenceFile[]
  networkGranted: boolean
  onOpenFile: (path: string, kind?: Exclude<FileKind, 'folder'>) => void
  onProjectChanged: () => void | Promise<void>
  onSendToAi: (text: string) => void
}

const EMPTY_DRAFT: ReferenceDraft = {
  citeKey: '', type: 'article', title: '', authors: '', year: '', journal: '', doi: '', url: '', pdfPath: '', abstract: '', tags: '', notes: ''
}

function draftFor(reference: ResearchReference): ReferenceDraft {
  return {
    id: reference.id,
    citeKey: reference.citeKey,
    type: reference.type,
    title: reference.title,
    authors: reference.authors.join('; '),
    year: reference.year ? String(reference.year) : '',
    journal: reference.journal ?? '',
    doi: reference.doi ?? '',
    url: reference.url ?? '',
    pdfPath: reference.pdfPath ?? '',
    abstract: reference.abstract ?? '',
    tags: reference.tags.join(', '),
    notes: reference.notes ?? ''
  }
}

function referenceFor(draft: ReferenceDraft, previous?: ResearchReference): ResearchReference {
  const year = Number.parseInt(draft.year, 10)
  return normalizeReference({
    ...previous,
    ...(draft.id ? { id: draft.id } : {}),
    citeKey: draft.citeKey,
    type: draft.type,
    title: draft.title,
    authors: draft.authors.split(/[;\n]/u).map((author) => author.trim()).filter(Boolean),
    ...(Number.isInteger(year) ? { year } : {}),
    journal: draft.journal,
    doi: draft.doi,
    url: draft.url,
    pdfPath: draft.pdfPath,
    abstract: draft.abstract,
    tags: draft.tags.split(/[,，;\n]/u).map((tag) => tag.trim()).filter(Boolean),
    notes: draft.notes,
    updatedAt: Date.now()
  })
}

function storedReferences(value: unknown): ResearchReference[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const raw = (value as { references?: unknown }).references
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): ResearchReference[] => {
    try { return [normalizeReference(item as Partial<ResearchReference>)] }
    catch { return [] }
  }).slice(0, 5_000)
}

export default function ReferencesWorkspace(props: ReferencesWorkspaceProps): React.JSX.Element {
  const [references, setReferences] = useState<ResearchReference[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ReferenceDraft>(EMPTY_DRAFT)
  const [query, setQuery] = useState('')
  const [importText, setImportText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [projectImportPath, setProjectImportPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setMessage(null)
    try {
      const next = storedReferences(await window.coscribe.plugins.data('references'))
      setReferences(next)
      setSelectedId((current) => current && next.some((reference) => reference.id === current) ? current : next[0]?.id ?? null)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '文献库读取失败。')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const selected = references.find((reference) => reference.id === selectedId)
  useEffect(() => {
    if (selected) setDraft(draftFor(selected))
    else setDraft(EMPTY_DRAFT)
  }, [selectedId])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return references
    return references.filter((reference) => [reference.title, reference.citeKey, ...reference.authors, ...reference.tags, reference.doi].some((value) => value?.toLocaleLowerCase().includes(needle)))
  }, [query, references])
  const pdfFiles = props.files.filter((file) => file.kind === 'pdf')
  const metadataFiles = props.files.filter((file) => /\.(?:bib|ris)$/iu.test(file.path))

  const persist = async (next: ResearchReference[]): Promise<void> => {
    await window.coscribe.plugins.saveData('references', { version: 1, references: next })
    setReferences(next)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft.title.trim()) return
    setSaving(true)
    setMessage(null)
    try {
      const nextReference = referenceFor(draft, selected)
      const next = selected
        ? references.map((reference) => reference.id === selected.id ? nextReference : reference)
        : mergeReferences(references, [nextReference])
      await persist(next)
      setSelectedId(nextReference.id)
      setDraft(draftFor(nextReference))
      setMessage('文献元数据已保存在当前项目。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '文献保存失败。')
    } finally { setSaving(false) }
  }

  const importReferences = async (text = importText): Promise<void> => {
    const incoming = text.trimStart().startsWith('@') ? parseBibTeX(text) : parseRis(text)
    if (!incoming.length) {
      setMessage('没有识别到 BibTeX 或 RIS 文献记录。')
      return
    }
    try {
      const next = mergeReferences(references, incoming)
      await persist(next)
      setSelectedId(incoming[0]?.id ?? next[0]?.id ?? null)
      setImportText('')
      setImportOpen(false)
      setMessage(`已导入 ${incoming.length} 条记录；相同 DOI 或 citekey 已合并。`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '文献导入失败。')
    }
  }

  const importProjectFile = async (): Promise<void> => {
    if (!projectImportPath) return
    try {
      const file = await window.coscribe.file.read(projectImportPath)
      await importReferences(file.content)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '无法读取文献文件。')
    }
  }

  const lookupDoi = async (): Promise<void> => {
    if (!draft.doi.trim() || !props.networkGranted) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.coscribe.references.lookupDoi(draft.doi)
      const merged = normalizeReference({ ...referenceFor(draft, selected), ...result, id: draft.id })
      setDraft(draftFor(merged))
      setMessage('已从 Crossref 获取元数据，请检查后保存。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'DOI 查询失败。')
    } finally { setSaving(false) }
  }

  const removeSelected = async (): Promise<void> => {
    if (!selected || !window.confirm(`从文献库移除“${selected.title}”？本地 PDF 和笔记不会被删除。`)) return
    try {
      const next = references.filter((reference) => reference.id !== selected.id)
      await persist(next)
      setSelectedId(next[0]?.id ?? null)
      setMessage('已从文献库移除；原文件未删除。')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '移除失败。') }
  }

  const copy = async (value: string, label: string): Promise<void> => {
    try { await navigator.clipboard.writeText(value); setMessage(`${label}已复制。`) }
    catch { setMessage('系统剪贴板不可用。') }
  }

  const openNote = async (): Promise<void> => {
    if (!selected) return
    const target = referenceNotePath(selected)
    try {
      let file
      try { file = await window.coscribe.file.createMarkdown(target, referenceNoteMarkdown(selected)) }
      catch (reason) {
        if (!/(?:存在|EEXIST)/iu.test(String(reason))) throw reason
        file = await window.coscribe.file.read(target)
      }
      await props.onProjectChanged()
      props.onOpenFile(file.path, 'markdown')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '文献笔记创建失败。') }
  }

  return (
    <section className="plugin-workspace research-workspace" aria-label="文献与引用插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Library size={23} /></span><div><small>LOCAL REFERENCE LIBRARY</small><h1>文献与引用</h1><p>BibTeX / RIS 元数据留在项目中，PDF 只保存本地关联路径</p></div></div>
        <div className="research-hero-actions"><button className="secondary-button" type="button" onClick={() => setImportOpen((value) => !value)}><Import size={14} />导入</button><button className="primary-button" type="button" onClick={() => { setSelectedId(null); setDraft(EMPTY_DRAFT) }}><Plus size={14} />新建文献</button></div>
      </header>

      {message && <p className="plugin-inline-message research-message" role="status">{message}</p>}

      {importOpen && <section className="research-import-panel">
        <div className="plugin-section-title"><div><small>IMPORT</small><h2>导入 BibTeX / RIS</h2></div><span>相同 DOI 或 citekey 自动合并</span></div>
        {metadataFiles.length > 0 && <div className="research-inline-form"><select value={projectImportPath} onChange={(event) => setProjectImportPath(event.target.value)}><option value="">选择项目内 .bib / .ris 文件</option>{metadataFiles.map((file) => <option key={file.path} value={file.path}>{file.name}</option>)}</select><button className="secondary-button" type="button" disabled={!projectImportPath} onClick={() => void importProjectFile()}>读取文件</button></div>}
        <textarea value={importText} onChange={(event) => setImportText(event.target.value)} rows={7} placeholder="粘贴 @article{...} 或 RIS 记录" />
        <div className="research-panel-actions"><button className="text-button" type="button" onClick={() => setImportOpen(false)}>取消</button><button className="primary-button" type="button" disabled={!importText.trim()} onClick={() => void importReferences()}>导入记录</button></div>
      </section>}

      <div className="research-library-layout">
        <aside className="research-reference-list">
          <label className="research-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题名、作者、标签或 DOI" /></label>
          <div className="research-list-meta"><span>{filtered.length} / {references.length} 条</span><button className="text-button" type="button" onClick={() => void load()}>刷新</button></div>
          {loading ? <div className="plugin-loading"><span className="viewer-spinner" />正在读取文献库…</div> : filtered.length ? <div className="research-list-items">{filtered.map((reference) => <button className={selectedId === reference.id ? 'is-active' : ''} type="button" key={reference.id} onClick={() => setSelectedId(reference.id)}><small>{reference.type.toUpperCase()} · {reference.year ?? 'n.d.'}</small><strong>{reference.title}</strong><span>{reference.authors.join(', ') || '未知作者'}</span><code>{citationToken(reference)}</code></button>)}</div> : <div className="plugin-empty"><BookMarked size={28} /><strong>文献库还是空的</strong><p>导入 BibTeX / RIS、查询 DOI，或手动建立第一条记录。</p></div>}
        </aside>

        <section className="research-editor">
          <div className="plugin-section-title"><div><small>{selected ? 'REFERENCE DETAIL' : 'NEW REFERENCE'}</small><h2>{selected ? '编辑文献' : '添加文献'}</h2></div>{selected && <button className="icon-button" type="button" title="移除文献" aria-label="移除文献" onClick={() => void removeSelected()}><Trash2 size={14} /></button>}</div>
          <div className="research-form-grid">
            <label className="is-wide"><span>题名</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="文献标题" /></label>
            <label><span>citekey</span><input value={draft.citeKey} onChange={(event) => setDraft({ ...draft, citeKey: event.target.value })} placeholder="Author2026Topic" /></label>
            <label><span>类型</span><select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ResearchReferenceType })}><option value="article">期刊论文</option><option value="conference">会议论文</option><option value="book">图书</option><option value="chapter">章节</option><option value="thesis">学位论文</option><option value="report">报告</option><option value="web">网页</option><option value="other">其他</option></select></label>
            <label className="is-wide"><span>作者（分号分隔）</span><input value={draft.authors} onChange={(event) => setDraft({ ...draft, authors: event.target.value })} placeholder="Ada Lovelace; Alan Turing" /></label>
            <label><span>年份</span><input value={draft.year} inputMode="numeric" onChange={(event) => setDraft({ ...draft, year: event.target.value })} placeholder="2026" /></label>
            <label><span>期刊 / 会议</span><input value={draft.journal} onChange={(event) => setDraft({ ...draft, journal: event.target.value })} /></label>
            <label className="is-wide"><span>DOI</span><div className="research-field-action"><input value={draft.doi} onChange={(event) => setDraft({ ...draft, doi: event.target.value })} placeholder="10.xxxx/xxxxx" /><button type="button" disabled={!props.networkGranted || !draft.doi.trim() || saving} onClick={() => void lookupDoi()}><Sparkles size={13} />Crossref</button></div></label>
            <label className="is-wide"><span>URL</span><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://…" /></label>
            <label className="is-wide"><span>关联本地 PDF</span><select value={draft.pdfPath} onChange={(event) => setDraft({ ...draft, pdfPath: event.target.value })}><option value="">不关联</option>{pdfFiles.map((file) => <option key={file.path} value={file.path}>{file.name}</option>)}</select></label>
            <label className="is-wide"><span>摘要</span><textarea value={draft.abstract} onChange={(event) => setDraft({ ...draft, abstract: event.target.value })} rows={5} /></label>
            <label className="is-wide"><span>标签</span><input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="RAG, evaluation, benchmark" /></label>
            <label className="is-wide"><span>备注</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={3} /></label>
          </div>
          <div className="research-panel-actions"><button className="primary-button" type="button" disabled={!draft.title.trim() || saving} onClick={() => void saveDraft()}><FilePlus2 size={14} />{selected ? '保存修改' : '加入文献库'}</button></div>
          {selected && <div className="research-reference-actions"><button type="button" onClick={() => void copy(citationToken(selected), '文内引用')}><Clipboard size={13} />复制 {citationToken(selected)}</button><button type="button" onClick={() => void copy(bibTeXFor(selected), 'BibTeX')}><FileText size={13} />复制 BibTeX</button><button type="button" onClick={() => void openNote()}><BookMarked size={13} />打开文献笔记</button>{selected.pdfPath && <button type="button" onClick={() => props.onOpenFile(selected.pdfPath!, 'pdf')}>PDF <ArrowUpRight size={13} /></button>}<button type="button" onClick={() => props.onSendToAi(`请分析以下文献，并区分元数据事实与需要阅读原文才能确认的内容：\n\n${formattedReference(selected)}\n\n摘要：${selected.abstract || '未录入'}`)}><Sparkles size={13} />发送给 AI</button></div>}
        </section>
      </div>
    </section>
  )
}
