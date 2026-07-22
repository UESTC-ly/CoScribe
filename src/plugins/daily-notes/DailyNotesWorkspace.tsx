import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, BookOpenText, CalendarDays, FilePlus2, Save } from 'lucide-react'

import type { FileReadResult } from '../../shared/types'
import {
  dailyNotePath,
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_WEEKLY_TEMPLATE,
  isValidLocalDateValue,
  localDateValue,
  renderNoteTemplate,
  weeklyNotePath
} from './daily-utils'

interface DailyNotesData {
  dailyTemplate: string
  weeklyTemplate: string
}

interface DailyNotesWorkspaceProps {
  projectName: string
  onOpenMarkdown: (path: string) => void
  onFileChanged: (result: FileReadResult) => void | Promise<void>
}

function isMissing(reason: unknown): boolean {
  return /(?:不存在|找不到|ENOENT|not found)/iu.test(String(reason))
}

export default function DailyNotesWorkspace(props: DailyNotesWorkspaceProps): React.JSX.Element {
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily')
  const [date, setDate] = useState(localDateValue)
  const [data, setData] = useState<DailyNotesData>({ dailyTemplate: DEFAULT_DAILY_TEMPLATE, weeklyTemplate: DEFAULT_WEEKLY_TEMPLATE })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.coscribe.plugins.data('daily-notes').then((value) => {
      if (!alive || !value || typeof value !== 'object') return
      const raw = value as Partial<DailyNotesData>
      setData({
        dailyTemplate: typeof raw.dailyTemplate === 'string' ? raw.dailyTemplate : DEFAULT_DAILY_TEMPLATE,
        weeklyTemplate: typeof raw.weeklyTemplate === 'string' ? raw.weeklyTemplate : DEFAULT_WEEKLY_TEMPLATE
      })
    }).catch((reason) => setMessage(reason instanceof Error ? reason.message : '模板读取失败。')).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  const validDate = isValidLocalDateValue(date)
  const targetPath = useMemo(() => validDate ? (mode === 'daily' ? dailyNotePath(date) : weeklyNotePath(date)) : '', [date, mode, validDate])
  const template = mode === 'daily' ? data.dailyTemplate : data.weeklyTemplate

  const saveTemplate = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      await window.coscribe.plugins.saveData('daily-notes', data)
      setMessage('模板已保存在当前项目。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '模板保存失败。')
    } finally {
      setSaving(false)
    }
  }

  const createOrOpen = async (): Promise<void> => {
    if (!validDate) {
      setMessage('请先选择有效日期。')
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      let result: FileReadResult
      try {
        result = await window.coscribe.file.read(targetPath)
        setMessage('这份笔记已经存在，已为你打开。')
      } catch (reason) {
        if (!isMissing(reason)) throw reason
        result = await window.coscribe.file.createMarkdown(targetPath, renderNoteTemplate(template, date, props.projectName))
        setMessage('笔记已创建。')
      }
      await props.onFileChanged(result)
      props.onOpenMarkdown(result.path)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '笔记创建失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="plugin-workspace daily-workspace" aria-label="每日笔记与模板插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><BookOpenText size={23} /></span><div><small>LOCAL MARKDOWN WORKFLOW</small><h1>每日笔记与模板</h1><p>{props.projectName} · 模板和笔记都保存在当前项目</p></div></div>
        <button className="primary-button" type="button" disabled={saving || loading || !validDate} onClick={() => void createOrOpen()}><FilePlus2 size={15} />{saving ? '处理中…' : '创建或打开'}</button>
      </header>

      <div className="daily-layout">
        <section className="daily-create-card">
          <div className="plugin-section-title"><div><small>NOTE DATE</small><h2>选择笔记</h2></div><CalendarDays size={18} /></div>
          <div className="daily-mode" role="tablist" aria-label="笔记周期">
            <button className={mode === 'daily' ? 'is-active' : ''} type="button" onClick={() => setMode('daily')}>每日笔记</button>
            <button className={mode === 'weekly' ? 'is-active' : ''} type="button" onClick={() => setMode('weekly')}>每周回顾</button>
          </div>
          <label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <div className="daily-target"><small>将使用文件</small><code>{targetPath || '请选择有效日期'}</code></div>
          <button className="secondary-button" type="button" onClick={() => void createOrOpen()} disabled={saving || loading || !validDate}>打开这份笔记 <ArrowUpRight size={14} /></button>
          {message && <p className="plugin-inline-message" role="status">{message}</p>}
        </section>

        <section className="daily-template-card">
          <div className="plugin-section-title"><div><small>PORTABLE TEMPLATE</small><h2>{mode === 'daily' ? '每日模板' : '每周模板'}</h2></div><button className="text-button" type="button" disabled={saving} onClick={() => void saveTemplate()}><Save size={14} />保存模板</button></div>
          <p>可使用 <code>{'{{date}}'}</code>、<code>{'{{weekday}}'}</code>、<code>{'{{week}}'}</code>、<code>{'{{project}}'}</code> 等变量。</p>
          <textarea
            aria-label={`${mode === 'daily' ? '每日' : '每周'}笔记模板`}
            value={template}
            onChange={(event) => setData((current) => mode === 'daily'
              ? { ...current, dailyTemplate: event.target.value }
              : { ...current, weeklyTemplate: event.target.value })}
            spellCheck={false}
          />
        </section>
      </div>
    </section>
  )
}
