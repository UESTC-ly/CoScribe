import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Clock3, Globe2, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'

import type { WebTrackedSource, WebTrackingCheckResult, WebTrackingIntervalMinutes } from '../../shared/types'

interface WebTrackerWorkspaceProps {
  onOpenMarkdown: (path: string) => void
  onProjectChanged: () => void | Promise<void>
  onSendToAi: (text: string) => void
}

const INTERVALS: Array<{ value: WebTrackingIntervalMinutes; label: string }> = [
  { value: 0, label: '仅手动' },
  { value: 60, label: '每小时' },
  { value: 360, label: '每 6 小时' },
  { value: 1440, label: '每天' }
]

const STATUS_LABEL: Record<WebTrackedSource['status'], string> = {
  idle: '待检查', checking: '检查中', unchanged: '未变化', changed: '有变化', error: '失败'
}

export default function WebTrackerWorkspace(props: WebTrackerWorkspaceProps): React.JSX.Element {
  const [sources, setSources] = useState<WebTrackedSource[]>([])
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [interval, setIntervalValue] = useState<WebTrackingIntervalMinutes>(1440)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState<string | 'all' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [lastResults, setLastResults] = useState<Record<string, WebTrackingCheckResult>>({})

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setMessage(null)
    try { setSources(await window.coscribe.webTracker.list()) }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '网页跟踪列表读取失败。') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async (): Promise<void> => {
    if (!url.trim()) return
    try {
      const source = await window.coscribe.webTracker.add({ url: url.trim(), title: title.trim(), intervalMinutes: interval })
      setSources((current) => [source, ...current])
      setUrl('')
      setTitle('')
      setMessage('已加入跟踪列表。首次检查会建立带来源的 Markdown 基线快照。')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '网页添加失败。') }
  }

  const updateInterval = async (source: WebTrackedSource, value: WebTrackingIntervalMinutes): Promise<void> => {
    try {
      const updated = await window.coscribe.webTracker.update(source.id, { url: source.url, title: source.title, intervalMinutes: value })
      setSources((current) => current.map((item) => item.id === source.id ? updated : item))
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '检查频率更新失败。') }
  }

  const check = async (sourceId?: string): Promise<void> => {
    setChecking(sourceId ?? 'all')
    setMessage(null)
    try {
      const results = await window.coscribe.webTracker.check(sourceId)
      setSources(await window.coscribe.webTracker.list())
      setLastResults((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.source.id, result])) }))
      await props.onProjectChanged()
      const changed = results.filter((result) => result.changed).length
      const errors = results.filter((result) => result.source.status === 'error').length
      setMessage(`检查完成：${changed} 项有变化，${results.length - changed - errors} 项未变化${errors ? `，${errors} 项失败` : ''}。`)
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '网页检查失败。') }
    finally { setChecking(null) }
  }

  const remove = async (source: WebTrackedSource): Promise<void> => {
    if (!window.confirm(`停止跟踪“${source.title}”？已经生成的 Markdown 快照会保留。`)) return
    try {
      await window.coscribe.webTracker.remove(source.id)
      setSources((current) => current.filter((item) => item.id !== source.id))
      setMessage('已停止跟踪；历史快照没有删除。')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '停止跟踪失败。') }
  }

  return (
    <section className="plugin-workspace web-tracker-workspace" aria-label="网页资料持续跟踪插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Globe2 size={23} /></span><div><small>LOW-FREQUENCY RESEARCH WATCH</small><h1>网页资料持续跟踪</h1><p>只在 CoScribe 运行时低频检查 HTML / 纯文本，并仅为变化内容创建快照</p></div></div>
        <button className="secondary-button" type="button" disabled={!sources.length || Boolean(checking)} onClick={() => void check()}><RefreshCw size={14} />检查全部</button>
      </header>

      <section className="web-add-card">
        <div className="plugin-section-title"><div><small>ADD SOURCE</small><h2>添加研究网页</h2></div><span>首次检查建立基线</span></div>
        <div className="web-add-fields"><label><span>网页地址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org/research" /></label><label><span>名称（可选）</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="自动读取网页标题" /></label><label><span>检查频率</span><select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value) as WebTrackingIntervalMinutes)}>{INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button className="primary-button" type="button" disabled={!url.trim()} onClick={() => void add()}><Plus size={14} />加入跟踪</button></div>
      </section>

      {message && <p className="plugin-inline-message research-message" role="status">{message}</p>}

      {loading ? <div className="plugin-loading"><span className="viewer-spinner" />正在读取跟踪列表…</div> : sources.length ? <div className="web-source-list">{sources.map((source) => {
        const result = lastResults[source.id]
        return <article key={source.id}>
          <div className="web-source-main"><span className={`web-source-status is-${source.status}`}>{STATUS_LABEL[source.status]}</span><div><strong>{source.title}</strong><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a></div></div>
          <dl><div><dt>上次检查</dt><dd>{source.lastCheckedAt ? new Date(source.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查'}</dd></div><div><dt>变化次数</dt><dd>{source.changeCount}</dd></div><div><dt>检查频率</dt><dd><select aria-label={`${source.title} 检查频率`} value={source.intervalMinutes} onChange={(event) => void updateInterval(source, Number(event.target.value) as WebTrackingIntervalMinutes)}>{INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></dd></div></dl>
          {source.error && <p className="web-source-error">{source.error}</p>}
          <footer><button className="secondary-button" type="button" disabled={Boolean(checking)} onClick={() => void check(source.id)}><RefreshCw size={13} />{checking === source.id ? '检查中…' : '立即检查'}</button>{source.latestSnapshotPath && <button className="secondary-button" type="button" onClick={() => props.onOpenMarkdown(source.latestSnapshotPath!)}>最新快照 <ArrowUpRight size={13} /></button>}<button className="secondary-button" type="button" disabled={!result} onClick={() => result && props.onSendToAi(`请分析这个网页资料跟踪结果。来源：${source.url}\n检查时间：${source.lastCheckedAt ? new Date(source.lastCheckedAt).toISOString() : '未知'}\n状态：${result.changed ? '正文发生变化并已保存快照' : source.status === 'error' ? `检查失败：${source.error}` : '正文未变化'}\n${source.latestSnapshotPath ? `本地快照：${source.latestSnapshotPath}` : ''}`)}><Send size={13} />发送给 AI</button><button className="icon-button" type="button" aria-label={`停止跟踪 ${source.title}`} title="停止跟踪" onClick={() => void remove(source)}><Trash2 size={14} /></button></footer>
        </article>
      })}</div> : <div className="plugin-empty"><Clock3 size={29} /><strong>还没有持续跟踪的网页</strong><p>添加论文页面、规范或项目资料页；CoScribe 运行时会按设定频率检查。</p></div>}

      <p className="web-tracker-footnote">跟踪器不执行网页脚本、不登录站点、不处理视频或下载。它保存可比较的正文快照；需要保留完整原网页时，请使用内置资料浏览器的“保存原网页”。</p>
    </section>
  )
}
