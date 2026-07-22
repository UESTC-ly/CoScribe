import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ListTodo,
  Plus,
  Sparkles
} from 'lucide-react'

import type { FileReadResult } from '../../shared/types'
import {
  appendPlannerTask,
  createPlannerMarkdown,
  parsePlannerTasks,
  PLANNER_FILE_PATH,
  PLANNER_PRIORITIES,
  type PlannerPriority,
  type PlannerTask
} from './planner-utils'

interface PlannerWorkspaceProps {
  projectName: string
  aiConfigured: boolean
  hasUnsavedPlan: boolean
  onOpenMarkdown: (path: string) => void
  onFileChanged: (result: FileReadResult) => void | Promise<void>
  onGenerateWithAi: (goal: string, horizon: string) => void | Promise<void>
  onOpenSettings: () => void
}

function todayValue(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' }).format(date)
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '计划表操作失败。'
}

async function readOrCreatePlanner(): Promise<FileReadResult> {
  try {
    return await window.coscribe.file.read(PLANNER_FILE_PATH)
  } catch (reason) {
    if (!/(?:不存在|找不到|ENOENT|not found)/iu.test(String(reason))) throw reason
    try {
      return await window.coscribe.file.createMarkdown(PLANNER_FILE_PATH, createPlannerMarkdown())
    } catch (createError) {
      if (!/(?:已经存在|EEXIST)/iu.test(String(createError))) throw createError
      return window.coscribe.file.read(PLANNER_FILE_PATH)
    }
  }
}

export default function PlannerWorkspace(props: PlannerWorkspaceProps): React.JSX.Element {
  const [document, setDocument] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [horizon, setHorizon] = useState('本周')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayValue)
  const [time, setTime] = useState('')
  const [priority, setPriority] = useState<PlannerPriority>('中')
  const [notes, setNotes] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await readOrCreatePlanner()
      setDocument(result)
      await props.onFileChanged(result)
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [props.onFileChanged])

  useEffect(() => { void load() }, [load])

  const tasks = useMemo(() => parsePlannerTasks(document?.content ?? ''), [document?.content])
  const grouped = useMemo(() => tasks.reduce<Record<string, PlannerTask[]>>((all, task) => {
    (all[task.date] ??= []).push(task)
    return all
  }, {}), [tasks])
  const completed = tasks.filter((task) => task.status === '已完成').length
  const inProgress = tasks.filter((task) => task.status === '进行中').length
  const today = todayValue()
  const upcoming = tasks.filter((task) => task.date >= today && task.status !== '已完成').length

  const addTask = async (): Promise<void> => {
    if (!title.trim() || !document || props.hasUnsavedPlan) return
    setSaving(true)
    setError(null)
    try {
      const next = appendPlannerTask(document.content, {
        date,
        time,
        title: title.trim(),
        status: '待办',
        priority,
        notes: notes.trim()
      })
      const result = await window.coscribe.file.saveMarkdown(PLANNER_FILE_PATH, next, document.modifiedAt)
      setDocument(result)
      await props.onFileChanged(result)
      setTitle('')
      setTime('')
      setNotes('')
    } catch (reason) {
      setError(failureMessage(reason))
      await load()
    } finally {
      setSaving(false)
    }
  }

  const generate = async (): Promise<void> => {
    if (!goal.trim() || !props.aiConfigured || generating) return
    setGenerating(true)
    setError(null)
    try {
      await props.onGenerateWithAi(goal.trim(), horizon)
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="planner-workspace" aria-label="计划与日程插件">
      <header className="planner-hero">
        <div className="planner-hero__identity">
          <span><CalendarCheck2 size={24} /></span>
          <div><small>TRUSTED BUILT-IN PLUGIN</small><h1>计划与日程</h1><p>{props.projectName} · 数据保存在 {PLANNER_FILE_PATH}</p></div>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={!document}
          onClick={() => document && props.onOpenMarkdown(document.path)}
        >
          编辑 Markdown <ArrowUpRight size={14} />
        </button>
      </header>

      {error && <div className="planner-alert" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => setError(null)}>关闭</button></div>}
      {props.hasUnsavedPlan && <div className="planner-alert is-warning"><AlertCircle size={15} /><span>项目计划正在 Markdown 编辑器中修改。请先保存，再从插件快速添加任务。</span></div>}

      <div className="planner-metrics" aria-label="计划概览">
        <article><span><ListTodo size={17} /></span><div><strong>{tasks.length}</strong><small>全部事项</small></div></article>
        <article><span><Clock3 size={17} /></span><div><strong>{inProgress}</strong><small>进行中</small></div></article>
        <article><span><CalendarDays size={17} /></span><div><strong>{upcoming}</strong><small>待执行</small></div></article>
        <article><span><CheckCircle2 size={17} /></span><div><strong>{completed}</strong><small>已完成</small></div></article>
      </div>

      <div className="planner-layout">
        <div className="planner-agenda">
          <div className="planner-section-title"><div><small>AGENDA</small><h2>日程</h2></div><button className="text-button" type="button" onClick={() => void load()}>刷新</button></div>
          {loading ? <div className="planner-loading"><span className="viewer-spinner" />正在读取计划表…</div> : tasks.length === 0 ? (
            <div className="planner-empty"><CalendarDays size={28} /><strong>日程还是空的</strong><p>从右侧快速加入一项，或让 AI 根据目标生成完整计划。</p></div>
          ) : (
            <div className="planner-days">
              {Object.entries(grouped).map(([day, items]) => (
                <section className="planner-day" key={day}>
                  <header><strong>{dateLabel(day)}</strong><span>{items.length} 项</span></header>
                  {items.map((task, index) => (
                    <article className={`planner-task is-${task.status === '已完成' ? 'done' : task.status === '进行中' ? 'active' : 'todo'}`} key={`${task.date}-${task.time}-${task.title}-${index}`}>
                      <span className="planner-task__time">{task.time || '全天'}</span>
                      <div><strong>{task.title}</strong>{task.notes && <p>{task.notes}</p>}</div>
                      <span className={`planner-priority is-${task.priority}`}>{task.priority}</span>
                      <small>{task.status}</small>
                    </article>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>

        <aside className="planner-sidebar">
          <section className="planner-compose">
            <div className="planner-section-title"><div><small>QUICK ADD</small><h2>添加事项</h2></div><Plus size={17} /></div>
            <label>事项<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成需求评审" /></label>
            <div className="planner-field-row"><label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label></div>
            <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as PlannerPriority)}>{PLANNER_PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>备注<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label>
            <button className="primary-button" type="button" disabled={!title.trim() || saving || loading || props.hasUnsavedPlan} onClick={() => void addTask()}>{saving ? '正在保存…' : '加入日程'}</button>
          </section>

          <section className="planner-ai-card">
            <div className="planner-ai-card__title"><span><Sparkles size={16} /></span><div><small>AI PLANNER</small><h2>从目标生成计划</h2></div></div>
            <textarea rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述目标、截止时间和已有约束…" />
            <div className="planner-ai-card__actions"><select value={horizon} onChange={(event) => setHorizon(event.target.value)}><option>今天</option><option>本周</option><option>本月</option><option>完整项目</option></select><button type="button" disabled={!goal.trim() || generating || !props.aiConfigured} onClick={() => void generate()}>{generating ? '准备中…' : '交给 AI'}</button></div>
            {!props.aiConfigured && <p>需要先配置 AI。<button type="button" onClick={props.onOpenSettings}>打开设置</button></p>}
          </section>
        </aside>
      </div>
    </section>
  )
}
