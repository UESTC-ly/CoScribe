import { useEffect, useRef, useState } from 'react'
import type { ReviewDraft, ReviewWorkspacePolicy } from '../../shared/assistant'
import type { FileOperationProposal, FileReadResult } from '../../shared/types'

export function DailyReviewPanel(props: { date: string; onFileChanged: (file: FileReadResult) => void | Promise<void>; onOpenMarkdown: (path: string) => void }): React.JSX.Element {
  const [policy, setPolicy] = useState<ReviewWorkspacePolicy | null>(null)
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [includePlan, setIncludePlan] = useState(false)
  const [kind, setKind] = useState<'completed' | 'unresolved' | 'reflection'>('completed')
  const [summary, setSummary] = useState('')
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [targetPath, setTargetPath] = useState('')
  const [proposal, setProposal] = useState<FileOperationProposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [clearing, setClearing] = useState(false)
  const pending = useRef(false)
  const manualKey = useRef(crypto.randomUUID())

  useEffect(() => {
    let alive = true
    void window.coscribe.assistant.review.policy().then((value) => { if (alive) setPolicy(value) }).catch((reason) => { if (alive) setError(String(reason)) })
    return () => { alive = false }
  }, [])
  useEffect(() => { setDraft(null); setProposal(null); setTargetPath('') }, [props.date, timeZone, includePlan])

  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await action() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作未能确认，请核对后重试。') }
    finally { pending.current = false; setBusy(false) }
  }

  return <section className="daily-template-card daily-review-card" aria-label="每日复盘">
    <div className="plugin-section-title"><div><small>DAILY REVIEW</small><h2>每日复盘</h2></div></div>
    <p>按 {props.date || '所选日期'} 的已记录活动生成本地草稿，预览确认后写入笔记。计划状态不会被算作实际完成。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">正在处理复盘…</p>}
    <fieldset disabled={busy || !policy}>
      <label className="check-row"><input type="checkbox" checked={policy?.recording ?? false} onChange={(event) => {
        const recording = event.target.checked
        void perform(async () => {
          setPolicy(await window.coscribe.assistant.review.setPolicy({ recording, expectedRevision: policy!.revision }))
          setDraft(null); setProposal(null)
          setNotice(recording ? '开始记录本项目的新对话与笔记编辑；不会补录历史。' : '已停止自动记录，历史账本仍保留。')
        })
      }} /><span><strong>记录本项目活动用于复盘</strong><small>默认关闭。记录新对话的用户输入与笔记保存事件，不记录打开文件或导入旧会话。</small></span></label>
      <label className="field-label">复盘时区<input className="field" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="Asia/Shanghai" /></label>
      <label className="field-label">补充类型<select className="field" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); manualKey.current = crypto.randomUUID() }}><option value="completed">实际完成</option><option value="unresolved">未解决问题</option><option value="reflection">个人反思</option></select></label>
      <label className="field-label">手动补充内容<textarea className="field" rows={3} maxLength={1_000} value={summary} onChange={(event) => { setSummary(event.target.value); manualKey.current = crypto.randomUUID() }} /></label>
      <button className="secondary-button" type="button" disabled={!summary.trim() || !props.date} onClick={() => void perform(async () => {
        await window.coscribe.assistant.review.addActivity({ date: props.date, timeZone, kind, summary, key: manualKey.current })
        setSummary(''); manualKey.current = crypto.randomUUID(); setDraft(null); setProposal(null)
        setNotice('已记录用户补充；重复提交同一条操作不会重复入账。')
      })}>记录这条补充</button>
      <label className="check-row"><input type="checkbox" checked={includePlan} onChange={(event) => setIncludePlan(event.target.checked)} /><span><strong>读取项目计划进行对照</strong><small>仅读取本项目的“计划/项目计划.md”，不读取系统日历或邮箱。</small></span></label>
      <button className="primary-button" type="button" disabled={!props.date || !timeZone} onClick={() => void perform(async () => {
        setProposal(null)
        setDraft(await window.coscribe.assistant.review.generate({ date: props.date, timeZone, includePlan }))
        setNotice('复盘草稿已生成；尚未写入文件。')
      })}>生成复盘草稿</button>
      {draft && <>
        <p className="field-caption">活动 {draft.activityCount} 条 · 草稿 {draft.id}</p>
        <label className="field-label">复盘草稿<textarea className="field" aria-label="复盘草稿" rows={12} readOnly value={draft.markdown} /></label>
        <label className="field-label">复盘保存位置<input className="field" value={targetPath} placeholder={`每日笔记/${props.date}.md`} onChange={(event) => { setTargetPath(event.target.value); setProposal(null) }} /></label>
        <button className="secondary-button" type="button" onClick={() => void perform(async () => {
          setProposal(await window.coscribe.assistant.review.prepareExport({ draftId: draft.id, ...(targetPath.trim() ? { targetPath: targetPath.trim() } : {}) }))
          setNotice('已生成文件预览，请核对完整内容再确认写入。')
        })}>预览写入复盘</button>
      </>}
      {proposal && <>
        <p>{proposal.summary} · {proposal.targetPath}</p>
        <details><summary>查看写入前内容</summary><textarea className="field" aria-label="复盘写入前内容" rows={6} readOnly value={proposal.originalContent ?? '（新建文件）'} /></details>
        <label className="field-label">复盘写入预览<textarea className="field" aria-label="复盘写入预览" rows={12} readOnly value={proposal.proposedContent} /></label>
        <button className="primary-button" type="button" onClick={() => void perform(async () => {
          const result = await window.coscribe.assistant.review.commitExport(proposal.id)
          setProposal(null)
          await props.onFileChanged(result)
          props.onOpenMarkdown(result.path)
          setNotice('复盘已写入，区块外的人工内容已保留。')
        })}>确认写入复盘</button>
        <button className="secondary-button" type="button" onClick={() => setProposal(null)}>取消写入</button>
      </>}
      <div className="personal-memory-actions">
        <button className="secondary-button" type="button" onClick={() => void perform(async () => { setPolicy(await window.coscribe.assistant.review.policy()); setNotice('已刷新活动授权。') })}>刷新活动授权</button>
        {!clearing ? <button className="secondary-button" type="button" onClick={() => setClearing(true)}>清理本项目活动账本</button> : <>
          <p>将删除活动、复盘草稿和写入凭据，停止记录；已导出的笔记保留，旧区块不再自动替换。</p>
          <button className="secondary-button" type="button" onClick={() => void perform(async () => {
            setPolicy(await window.coscribe.assistant.review.clear(policy!.revision)); setDraft(null); setProposal(null); setClearing(false)
            setNotice('已清理本项目活动账本与草稿。导出文件仍保留。')
          })}>确认清理账本</button><button className="secondary-button" type="button" onClick={() => setClearing(false)}>保留账本</button>
        </>}
      </div>
    </fieldset>
  </section>
}
