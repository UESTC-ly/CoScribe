import { useEffect, useRef, useState } from 'react'
import type { ResearchDraft, ResearchRun, ResearchSource } from '../../shared/research'
import type { FileKind } from '../../shared/types'

interface Props {
  networkGranted: boolean
  aiGranted: boolean
  mcpGranted: boolean
  onOpenFile: (path: string, kind?: Exclude<FileKind, 'folder'>) => void
  onChanged: () => Promise<void>
}
const LABELS: Record<ResearchSource, string> = { crossref: 'Crossref 文献', arxiv: 'arXiv 论文', github: 'GitHub 仓库' }
const STATUS: Record<ResearchRun['status'], string> = { searching: '正在规划与检索', ready: '候选已就绪', importing: '正在导入资料', completed: '导入任务结束', cancelled: '已取消', failed: '任务失败', interrupted: '上次任务已中断' }
export default function AutoResearchPanel(props: Props): React.JSX.Element {
  const [topic, setTopic] = useState('')
  const [sources, setSources] = useState<ResearchSource[]>(['crossref', 'arxiv', 'github'])
  const [limit, setLimit] = useState(5)
  const [useAi, setUseAi] = useState(false)
  const [download, setDownload] = useState(true)
  const [mcpServer, setMcpServer] = useState('')
  const [servers, setServers] = useState<Array<{ id: string; name: string }>>([])
  const [history, setHistory] = useState<ResearchRun[]>([])
  const [run, setRun] = useState<ResearchRun | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<ResearchDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const callback = useRef(props.onChanged)
  callback.current = props.onChanged
  useEffect(() => {
    mounted.current = true
    void window.coscribe.research.list().then((runs) => {
      if (!mounted.current) return
      setHistory(runs); setRun(runs[0] ?? null)
    }).catch((reason) => { if (mounted.current) setError(String(reason)) })
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!props.mcpGranted) return
    void window.coscribe.mcp.listServers().then((items) => setServers(items.map(({ id, name }) => ({ id, name })))).catch(() => setServers([]))
  }, [props.mcpGranted])
  useEffect(() => {
    if (!run || !['searching', 'importing'].includes(run.status)) return
    let stopped = false
    const timer = window.setTimeout(() => {
      void window.coscribe.research.get(run.id).then(async (next) => {
        if (stopped) return
        setRun(next)
        if (!['searching', 'importing'].includes(next.status)) {
          setHistory(await window.coscribe.research.list())
          if (run.status === 'importing') await callback.current()
        }
      }).catch((reason) => { if (!stopped) { setError(String(reason)); setRun({ ...run, status: 'failed' }) } })
    }, 800)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [run])
  const active = Boolean(run && ['searching', 'importing'].includes(run.status))
  const execute = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const imported = selected.filter((id) => run?.candidates.some((candidate) => candidate.id === id && candidate.imported))
  return <details className="research-import-panel auto-research-panel" open>
    <summary><strong>Auto Research · 主题研究</strong></summary>
    <p>检索论文和开源仓库，选择资料后导入。笔记与综述先预览，再保存到项目。</p>
    <label className="auto-research-topic">研究主题<input aria-label="研究主题" value={topic} maxLength={500} onChange={(event) => setTopic(event.target.value)} placeholder="例如：图神经网络在药物发现中的应用" disabled={active || busy} /></label>
    <div className="auto-research-options">
      {Object.entries(LABELS).map(([source, label]) => <label key={source}><input type="checkbox" checked={sources.includes(source as ResearchSource)} disabled={active || busy} onChange={(event) => setSources((current) => event.target.checked ? [...current, source as ResearchSource] : current.filter((item) => item !== source))} />{label}</label>)}
      <label>每来源数量<input aria-label="每来源数量" type="number" min={1} max={10} value={limit} disabled={active || busy} onChange={(event) => setLimit(Number(event.target.value))} /></label>
    </div>
    <div className="auto-research-options">
      <label><input type="checkbox" checked={useAi && props.aiGranted} disabled={!props.aiGranted || active || busy} onChange={(event) => setUseAi(event.target.checked)} />用已配置 AI 规划检索词并生成草稿</label>
      <label><input type="checkbox" checked={download} disabled={active || busy} onChange={(event) => setDownload(event.target.checked)} />导入时尝试下载 PDF / README</label>
    </div>
    <p className="auto-research-help">AI 选项会将主题和选中资料的摘要、PDF 前 8 页摘录或 README 发送给已配置的模型服务。未启用 AI 时可创建笔记和综述模板。</p>
    {props.mcpGranted && servers.length > 0 && <label>GitHub 检索服务<select aria-label="GitHub 检索服务" value={mcpServer} disabled={active || busy} onChange={(event) => setMcpServer(event.target.value)}><option value="">公共 GitHub API</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}（需只读 search_repositories）</option>)}</select></label>}
    {!props.networkGranted && <p role="status">请在插件管理中补充“文献与引用”的网络访问授权。</p>}
    {!props.aiGranted && <p className="auto-research-help">AI 规划和草稿需要在插件管理中补充 AI 请求授权。</p>}
    <div className="research-panel-actions">
      <button className="primary-button" type="button" disabled={!props.networkGranted || topic.trim().length < 2 || !sources.length || active || busy} onClick={() => void execute(async () => { setSelected([]); setDraft(null); setRun(await window.coscribe.research.start({ topic, sources, limit, useAi: useAi && props.aiGranted, ...(mcpServer ? { githubMcpServerId: mcpServer } : {}) })) })}>开始研究</button>
      {run && (active || busy) && <button className="secondary-button" type="button" onClick={() => void window.coscribe.research.cancel(run.id).then(() => setRun({ ...run, status: 'cancelled' })).catch((reason) => setError(String(reason)))}>取消任务</button>}
    </div>
    {history.length > 0 && <label>研究记录<select aria-label="研究记录" value={run?.id ?? ''} disabled={active || busy} onChange={(event) => { setRun(history.find((item) => item.id === event.target.value) ?? null); setSelected([]); setDraft(null) }}>{run && !history.some((item) => item.id === run.id) && <option value={run.id}>{run.topic}</option>}{history.map((item) => <option key={item.id} value={item.id}>{item.topic} · {new Date(item.createdAt).toLocaleDateString()}</option>)}</select></label>}
    {error && <p role="alert" className="plugin-inline-message">{error}</p>}
    {run && <div className="auto-research-results">
      <p role="status">{STATUS[run.status]} · {run.candidates.length} 条候选 · 已选 {selected.length} / 8</p>
      <p>检索词：{run.queries.join('；')}</p>
      {run.warnings.length > 0 && <details><summary>检索与下载缺口（{run.warnings.length}）</summary><ul>{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="auto-research-candidates">{run.candidates.map((candidate) => <article key={candidate.id}>
        <label><input type="checkbox" checked={selected.includes(candidate.id)} disabled={active || busy || (!selected.includes(candidate.id) && selected.length >= 8)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><strong>{candidate.reference.title}</strong></label>
        <small>{LABELS[candidate.source]} · {candidate.reference.year ?? '年份未知'} · {candidate.imported ? '已导入' : '待导入'}</small>
        <p>{candidate.reference.abstract?.slice(0, 240) || '没有摘要，仅有元数据。'}</p>
        <p>{candidate.reference.url}</p>
        {candidate.downloadStatus && <p>{candidate.downloadStatus}</p>}
        {candidate.reference.pdfPath && <button className="text-button" type="button" onClick={() => props.onOpenFile(candidate.reference.pdfPath!, 'pdf')}>打开 PDF</button>}
        {candidate.readmePath && <button className="text-button" type="button" onClick={() => props.onOpenFile(candidate.readmePath!, 'markdown')}>打开 README</button>}
      </article>)}</div>
      <div className="research-panel-actions">
        <button className="primary-button" type="button" disabled={!selected.length || active || busy || (download && !props.networkGranted)} onClick={() => void execute(async () => { setDraft(null); setRun(await window.coscribe.research.import(run.id, selected, download)) })}>导入选中资料</button>
        <button className="secondary-button" type="button" disabled={selected.length !== 1 || imported.length !== 1 || active || busy} onClick={() => void execute(async () => setDraft(await window.coscribe.research.draft(run.id, selected, 'note', useAi && props.aiGranted)))}>预览文献笔记</button>
        <button className="secondary-button" type="button" disabled={!selected.length || imported.length !== selected.length || active || busy} onClick={() => void execute(async () => setDraft(await window.coscribe.research.draft(run.id, selected, 'review', useAi && props.aiGranted)))}>预览主题综述</button>
        {(run.artifacts ?? []).map((artifact) => <button key={artifact.path} className="text-button" type="button" onClick={() => props.onOpenFile(artifact.path, 'markdown')}>打开{artifact.kind === 'note' ? '已保存笔记' : '已保存综述'}</button>)}
        {run.logPath && <button className="text-button" type="button" onClick={() => props.onOpenFile(run.logPath!, 'markdown')}>打开检索记录</button>}
      </div>
      {busy && <p role="status">正在处理，请稍候…</p>}
    </div>}
    {draft && <section aria-label="研究草稿预览">
      <h3>草稿预览</h3><p>{draft.path}</p>
      <textarea aria-label="研究草稿内容" readOnly value={draft.content} rows={14} />
      <div className="research-panel-actions"><button className="text-button" type="button" disabled={busy} onClick={() => setDraft(null)}>放弃草稿</button><button className="primary-button" type="button" disabled={busy} onClick={() => void execute(async () => { const file = await window.coscribe.research.confirm(draft.id); setDraft(null); if (run) setRun(await window.coscribe.research.get(run.id)); await props.onChanged(); props.onOpenFile(file.path, 'markdown') })}>确认保存草稿</button></div>
    </section>}
  </details>
}
