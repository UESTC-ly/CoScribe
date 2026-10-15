import { useCallback, useEffect, useRef, useState } from 'react'

import type { KnowledgePoint, LearningCorrection, LearningMutation, LearningRecord, LearningRecordInput, LearningSnapshot, LearningSourceInput, KnowledgeRelationKind, ReviewMaterial } from '../../shared/learning'
import type { FlashcardGrade } from '../../plugins/flashcards/flashcard-utils'

const labels: Record<string, string> = {
  interest: '技术关注', stage: '学习阶段', 'self-assessment': '用户自评',
  following: '关注', 'not-following': '不再关注', 'not-started': '尚未开始', learning: '学习中', learned: '学过', paused: '暂停',
  unassessed: '尚未自评', 'needs-practice': '需要练习', confident: '自述掌握',
  prerequisite: '前置知识', 'part-of': '组成', contrast: '对比', application: '应用',
  available: '来源可用', changed: '来源已变化，请核对或重新关联', missing: '来源失效，请重新关联', 'project-closed': '来源项目未打开', unverified: '来源尚未核对', blocked: '来源无法访问，请核对权限或符号链接',
  again: '重来', hard: '困难', good: '记得', easy: '简单'
}
const recordValues = { interest: ['following', 'not-following'], stage: ['not-started', 'learning', 'learned', 'paused'], 'self-assessment': ['unassessed', 'needs-practice', 'confident'] } as const
const dayEnd = (): number => {
  const date = new Date()
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}
const dateLabel = (time: number): string => new Date(time).toLocaleString('zh-CN')

interface LearningPanelProps {
  managementOnly?: boolean
  writable?: boolean
  files?: Array<{
    path: string
    kind: string
  }>
  readingContext?: {
    path: string
    quote?: string
    page?: number
  }
  onOpenSource?: (path: string) => void
}

export function LearningPanel({ managementOnly = false, writable = true, files = [], readingContext, onOpenSource }: LearningPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [editingPoint, setEditingPoint] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [kind, setKind] = useState<LearningRecordInput['kind']>('stage')
  const [value, setValue] = useState('learning')
  const [note, setNote] = useState('')
  const [editingRecord, setEditingRecord] = useState<string | null>(null)
  const [recordSource, setRecordSource] = useState('')
  const [sourceKind, setSourceKind] = useState<LearningSourceInput['kind']>('note')
  const [sourcePath, setSourcePath] = useState('')
  const [sourceQuote, setSourceQuote] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const [sourcePage, setSourcePage] = useState('')
  const [relinking, setRelinking] = useState<string | null>(null)
  const [relationTarget, setRelationTarget] = useState('')
  const [relationKind, setRelationKind] = useState<KnowledgeRelationKind>('prerequisite')
  const [relationNote, setRelationNote] = useState('')
  const [relationSource, setRelationSource] = useState('')
  const [modelRelation, setModelRelation] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [materialRelation, setMaterialRelation] = useState('')
  const [materialSource, setMaterialSource] = useState('')
  const [modelMaterial, setModelMaterial] = useState(false)
  const [editingMaterial, setEditingMaterial] = useState<string | null>(null)
  const [queue, setQueue] = useState<ReviewMaterial[]>([])
  const [legacyPath, setLegacyPath] = useState('')
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [manualCardId, setManualCardId] = useState<string | null>(null)
  const pending = useRef(false)
  const feedback = useRef<{
    submissionId: string
    materialId: string
    grade: FlashcardGrade
    expectedRevision: number
  } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await (managementOnly ? window.coscribe.assistant.learning.inspect() : window.coscribe.assistant.learning.list())
      if (feedback.current) feedback.current.expectedRevision = result.revision
      setSnapshot(result)
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '学习库读取失败。请刷新重试。') }
    finally {
      pending.current = false
      setBusy(false)
    }
  }, [managementOnly])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let current = true
    if (!managementOnly && snapshot) {
      void window.coscribe.assistant.learning.due(dayEnd()).then((result) => {
        if (current && result.revision === snapshot.revision) setQueue(result.materials)
      }, (reason) => {
        if (current) {
          setQueue([])
          setError(reason instanceof Error ? reason.message : '到期查询失败。')
        }
      })
    }
    return () => { current = false }
  }, [managementOnly, snapshot])

  const perform = async (action: () => Promise<LearningSnapshot>, message: string): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      setSnapshot((previous) => ({ ...result, sources: result.sources.map((source) => ({ ...source, status: previous?.sources.find((item) => item.id === source.id && item.revision === source.revision)?.status ?? source.status })) }))
      setNotice(message)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未确认，请刷新核对后重试。')
      return false
    }
    finally {
      pending.current = false
      setBusy(false)
    }
  }
  const mutate = (input: LearningMutation, message: string): Promise<boolean> => perform(() => managementOnly
    ? window.coscribe.assistant.learning.correct(input as LearningCorrection)
    : window.coscribe.assistant.learning.mutate(input), message)
  const version = snapshot?.revision ?? 0
  const selected = snapshot?.knowledge.find((point) => point.id === selectedId) ?? snapshot?.knowledge[0]
  const records = snapshot?.records.filter((record) => record.knowledgeId === selected?.id) ?? []
  const relations = snapshot?.relations.filter((relation) => relation.fromId === selected?.id || relation.toId === selected?.id) ?? []
  const sources = snapshot?.sources.filter((source) => selected?.sourceIds.includes(source.id)) ?? []
  const materials = snapshot?.materials.filter((material) => material.knowledgeId === selected?.id) ?? []
  const currentCard = snapshot?.materials.find((card) => card.id === manualCardId && card.confirmedAt !== null) ?? queue.find((card) => snapshot?.materials.some((item) => item.id === card.id && item.revision === card.revision))
  const writeDisabled = busy || (!managementOnly && !writable)

  const editPoint = (point: KnowledgePoint): void => {
    setEditingPoint(point.id)
    setName(point.name)
    setDomain(point.domain)
  }
  const editRecord = (record: LearningRecord): void => {
    setEditingRecord(record.id)
    setKind(record.kind)
    setValue(record.value)
    setNote(record.note)
    setRecordSource(record.sourceId ?? '')
  }
  const editMaterial = (material: ReviewMaterial): void => {
    setEditingMaterial(material.id)
    setQuestion(material.question)
    setAnswer(material.answer)
    setMaterialRelation(material.relationIds[0] ?? '')
    setMaterialSource(material.sourceId ?? '')
    setModelMaterial(material.origin === 'model')
  }
  const useReading = (): void => {
    if (!readingContext) return
    setSourceKind(readingContext.quote ? 'selection' : 'note')
    setSourcePath(readingContext.path)
    setSourceQuote(readingContext.quote?.slice(0, 2_000) ?? '')
    setSourcePage(readingContext.page ? String(readingContext.page) : '')
  }
  const grade = async (grade: FlashcardGrade): Promise<void> => {
    if (!currentCard) return
    if (!feedback.current || feedback.current.materialId !== currentCard.id || feedback.current.grade !== grade) feedback.current = { submissionId: crypto.randomUUID(), materialId: currentCard.id, grade, expectedRevision: version }
    const accepted = await mutate({ op: 'review.submit', ...feedback.current }, '复习反馈已保存，已更新下次到期时间。')
    if (accepted) {
      feedback.current = null
      setRevealedId(null)
      setManualCardId(null)
    }
  }
  const resetSelection = (nextId: string): void => {
    setSelectedId(nextId)
    setEditingRecord(null)
    setEditingPoint(null)
    setEditingMaterial(null)
    setRelinking(null)
    setDeleting(null)
    setName('')
    setDomain('')
    setNote('')
    setQuestion('')
    setAnswer('')
    setRelationSource('')
    setRelationTarget('')
    setMaterialRelation('')
    setMaterialSource('')
    setRecordSource('')
  }

  return (
    <section className="learning-panel" aria-label={managementOnly ? '学习数据管理' : '个人学习与复习'}>
      <div className="plugin-section-title"><div><h2>{managementOnly ? '个人学习数据' : '个人学习与复习'}</h2><p>跨项目保存。关注、学过、自述掌握和复习表现分别记录。</p></div><button className="secondary-button" type="button" disabled={busy} onClick={() => void load()}>刷新学习库</button></div>
      {error && <p className="plugin-inline-message" role="alert">{error} 若提交结果不确定，请先刷新核对。</p>}
      {notice && <p className="plugin-inline-message" role="status">{notice}</p>}
      {busy && <p aria-live="polite">正在读取或保存…</p>}
      {!managementOnly && !writable && <p>写入学习库尚未授权。请在插件中心补充“写入全局个人学习库”权限。</p>}
      {managementOnly && <p>关闭记忆召回或撤销插件权限后仍可查看、纠正、删除。助理是否使用这些数据由上方个人记忆授权控制。</p>}
      {snapshot && <>
        {!managementOnly && <section className="review-card learning-queue" aria-label="今日到期队列">
          <h3>{manualCardId ? '手动复习' : `今日到期 · ${queue.length}`}</h3>{manualCardId && <button type="button" onClick={() => {
            setManualCardId(null)
            setRevealedId(null)
            feedback.current = null
          }}>返回到期队列</button>}<p>截至本机今日结束；你也可以在材料中手动确认后复习。关联练习仅记录本题目标知识点的表现。</p>
          {currentCard ? <div className="flashcard-stage"><small>{snapshot.knowledge.find((point) => point.id === currentCard.knowledgeId)?.name} · {dateLabel(currentCard.schedule.dueAt)}</small><h3>{currentCard.question}</h3>{currentCard.sourceId && <p>{labels[snapshot.sources.find((source) => source.id === currentCard.sourceId)?.status ?? 'unverified']}</p>}
            {revealedId === currentCard.id ? <><div className="flashcard-answer"><p>{currentCard.answer}</p></div><div className="flashcard-grades">{(['again', 'hard', 'good', 'easy'] as const).map((gradeValue) => <button type="button" key={gradeValue} disabled={writeDisabled} onClick={() => void grade(gradeValue)}>{labels[gradeValue]}</button>)}</div></> : <button className="primary-button" type="button" onClick={() => setRevealedId(currentCard.id)}>显示答案</button>}
          </div> : <p>今日没有到期材料。先创建并确认题目，或导入旧闪卡。</p>}
        </section>}
        <div className="learning-layout">
          <aside className="learning-card">
            <h3>知识点 · {snapshot.knowledge.length}</h3>
            <div className="learning-point-list">{snapshot.knowledge.map((point) => <button className={selected?.id === point.id ? 'is-selected' : ''} type="button" key={point.id} aria-pressed={selected?.id === point.id} onClick={() => resetSelection(point.id)}>{point.name}<small>{point.domain || '未指定领域'}</small></button>)}</div>
            {!snapshot.knowledge.length && <p>尚无知识点。</p>}
            {(!managementOnly || editingPoint) && <form onSubmit={(event) => {
              event.preventDefault()
              void mutate({ op: 'knowledge.save', ...(editingPoint ? { id: editingPoint } : {}), name, domain, expectedRevision: version }, editingPoint ? '已纠正知识点，稳定 ID 与复习历史保留。' : '已创建知识点。').then((success) => {
                if (success) {
                  setName('')
                  setDomain('')
                  setEditingPoint(null)
                }
              })
            }}>
              <label>知识点名称<input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} required /></label>
              <label>所属领域<input value={domain} maxLength={100} onChange={(event) => setDomain(event.target.value)} /></label>
              <button className="primary-button" type="submit" disabled={writeDisabled || !name.trim()}>{editingPoint ? '保存知识点修正' : '创建知识点'}</button>
              {editingPoint && <button type="button" onClick={() => {
                setEditingPoint(null)
                setName('')
                setDomain('')
              }}>取消修正</button>}
            </form>}
            {!managementOnly && <><label>导入闪卡来源<select aria-label="导入闪卡来源" value={legacyPath} onChange={(event) => setLegacyPath(event.target.value)}><option value="">全部 Markdown（最多 100 个文件）</option>{files.filter((file) => file.kind === 'markdown').map((file) => <option key={file.path} value={file.path}>{file.path.split(/[\\/]/u).at(-1)}</option>)}</select></label><button className="secondary-button" type="button" disabled={writeDisabled || !files.some((file) => file.kind === 'markdown') || (!legacyPath && files.filter((file) => file.kind === 'markdown').length > 100)} onClick={() => void perform(async () => {
              const result = await window.coscribe.assistant.learning.importLegacy({ expectedRevision: version, paths: legacyPath ? [legacyPath] : files.filter((file) => file.kind === 'markdown').map((file) => file.path) })
              if (result.unmatchedReviewIds.length) setError(`有 ${result.unmatchedReviewIds.length} 条旧进度无法匹配：${result.unmatchedReviewIds.join('、')}。原项目记录保留，请核对原文件。`)
              return result.snapshot
            }, '旧闪卡已导入或已存在；原项目数据保留，重复导入不会覆盖新进度。')}>导入项目 Markdown 闪卡</button>{files.filter((file) => file.kind === 'markdown').length > 100 && <p>文件较多，请选择单个来源分批导入。</p>}</>}
          </aside>
          <div className="learning-detail">
            {selected && <section className="learning-card" aria-label="知识点详情">
              <h3>{selected.name}</h3><p>{selected.domain || '未指定领域'} · 第 {selected.revision} 版 · {dateLabel(selected.updatedAt)}</p>
              <div className="learning-actions"><button type="button" disabled={writeDisabled} onClick={() => editPoint(selected)}>修正知识点</button><button type="button" disabled={writeDisabled} onClick={() => setDeleting(selected.id)}>删除知识点</button></div>
              {deleting === selected.id && <div className="learning-confirm"><p>删除此知识点及其学习记录、材料和复习事件；原始文件保留。</p><button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'knowledge.delete', id: selected.id, expectedRevision: version }, '已删除知识点及相关个人数据。').then((success) => { if (success) { resetSelection('') } })}>确认删除知识点</button><button type="button" onClick={() => setDeleting(null)}>取消删除</button></div>}
              <h4>学习状态及依据</h4>
              {!records.length && <p>没有学习自述。阅读或复习不会自动标为掌握。</p>}
              {records.map((record) => <article className="learning-item" key={record.id}>
                <strong>{labels[record.kind]} · {labels[record.value]}</strong><p>{record.note || '无补充说明'} · 用户明确记录 · 第 {record.revision} 版 · {dateLabel(record.updatedAt)}</p>
                {record.sourceId && <small>来源：{snapshot.sources.find((source) => source.id === record.sourceId)?.path ?? '项目／文献'}</small>}
                <div className="learning-actions"><button type="button" disabled={writeDisabled} onClick={() => editRecord(record)}>纠正状态</button><button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'record.delete', id: record.id, expectedRevision: version }, '已删除学习自述。')}>删除状态</button></div>
              </article>)}
              {(!managementOnly || editingRecord) && <form onSubmit={(event) => {
                event.preventDefault()
                const record = { knowledgeId: selected.id, kind, value, note, ...(recordSource ? { sourceId: recordSource } : {}) } as LearningRecordInput
                void mutate({ op: 'record.save', ...(editingRecord ? { id: editingRecord } : {}), record, expectedRevision: version }, '已保存用户明确记录的学习状态。').then((success) => {
                  if (success) {
                    setEditingRecord(null)
                    setNote('')
                  }
                })
              }}>
                <label>状态类别<select value={kind} onChange={(event) => {
                  const next = event.target.value as LearningRecordInput['kind']
                  setKind(next)
                  setValue(recordValues[next][0])
                }}>{Object.keys(recordValues).map((key) => <option key={key} value={key}>{labels[key]}</option>)}</select></label>
                <label>学习状态<select aria-label="学习状态" value={value} onChange={(event) => setValue(event.target.value)}>{recordValues[kind].map((entry) => <option key={entry} value={entry}>{labels[entry]}</option>)}</select></label>
                <label>学习依据来源<select value={recordSource} onChange={(event) => setRecordSource(event.target.value)}><option value="">用户直接自述</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.path ?? source.referenceId ?? source.projectName}</option>)}</select></label>
                <label>用户自述依据<textarea value={note} maxLength={1_000} rows={2} onChange={(event) => setNote(event.target.value)} /></label>
                <button className="primary-button" type="submit" disabled={writeDisabled}>{editingRecord ? '保存状态纠正' : '记录用户自述'}</button>
                {editingRecord && <button type="button" onClick={() => setEditingRecord(null)}>取消状态纠正</button>}
              </form>}
              <details className="learning-group"><summary>资料来源</summary>
                {sources.map((source) => <article className="learning-item" key={source.id}>
                  <strong>{source.projectName} · {source.path ?? source.referenceId ?? '项目'}</strong><p>{labels[source.status]} · 第 {source.revision} 版{source.page ? ` · 第 ${source.page} 页` : ''}</p>{source.quote && <blockquote>{source.quote}</blockquote>}
                  <div className="learning-actions">
                    {source.path && source.status === 'available' && onOpenSource && <button type="button" onClick={() => onOpenSource(source.path!)}>打开来源</button>}
                    {!managementOnly && <button type="button" disabled={writeDisabled || source.status === 'project-closed'} onClick={() => {
                      setRelinking(source.id)
                      setSourceKind(source.kind)
                      setSourcePath(source.path ?? '')
                      setSourceQuote(source.quote ?? '')
                      setSourceReference(source.referenceId ?? '')
                      setSourcePage(source.page ? String(source.page) : '')
                    }}>重新关联来源</button>}
                    <button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'source.delete', id: source.id, expectedRevision: version }, '已删除来源定位；学习状态与复习历史保留。')}>删除来源</button>
                  </div>
                </article>)}
                {!managementOnly && <form onSubmit={(event) => {
                  event.preventDefault()
                  const source: LearningSourceInput = { kind: sourceKind, ...(sourceKind !== 'project' && sourcePath ? { path: sourcePath } : {}), ...(sourceKind === 'literature' ? { referenceId: sourceReference } : {}), ...(sourceKind !== 'project' && sourceQuote ? { quote: sourceQuote } : {}), ...(sourceKind !== 'project' && sourcePage ? { page: Number(sourcePage) } : {}) }
                  void mutate(relinking ? { op: 'source.relink', id: relinking, source, expectedRevision: version } : { op: 'source.attach', knowledgeId: selected.id, source, expectedRevision: version }, '已关联来源；原文只作为资料依据，不代表用户掌握。').then((success) => {
                    if (success) {
                      setRelinking(null)
                      void load()
                    }
                  })
                }}>
                  {readingContext && <button className="secondary-button" type="button" disabled={writeDisabled} onClick={useReading}>使用当前阅读／选区</button>}
                  <label>来源类型<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as LearningSourceInput['kind'])}><option value="note">笔记／资料文件</option><option value="selection">选区</option><option value="literature">文献库条目</option><option value="project">当前项目</option></select></label>
                  {sourceKind !== 'project' && <><label>来源文件路径<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} required={sourceKind !== 'literature'} /></label><label>来源选区原文<textarea value={sourceQuote} maxLength={2_000} rows={2} onChange={(event) => setSourceQuote(event.target.value)} required={sourceKind === 'selection'} /></label><label>PDF 来源页码<input type="number" min="1" value={sourcePage} onChange={(event) => setSourcePage(event.target.value)} /></label></>}
                  {sourceKind === 'literature' && <label>文献 ID<input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} required /></label>}
                  <button className="primary-button" type="submit" disabled={writeDisabled}>{relinking ? '确认重新关联来源' : '关联资料来源'}</button>
                </form>}
              </details><details className="learning-group"><summary>知识关联</summary>
                {relations.map((relation) => <article className="learning-item" key={relation.id}><strong>{snapshot.knowledge.find((point) => point.id === relation.fromId)?.name} → {labels[relation.kind]} → {snapshot.knowledge.find((point) => point.id === relation.toId)?.name}</strong><p>{relation.note} · {relation.origin === 'model' ? '模型建议' : '用户整理'} · {relation.confirmedAt ? '已确认' : '待确认'}</p><div className="learning-actions">{!managementOnly && !relation.confirmedAt && <button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'relation.confirm', id: relation.id, expectedRevision: version }, '已确认关联，不传播掌握状态。')}>确认关系</button>}<button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'relation.delete', id: relation.id, expectedRevision: version }, '已删除关系；使用它的题目需重新确认。')}>删除关系</button></div></article>)}
                {!managementOnly && <form onSubmit={(event) => {
                  event.preventDefault()
                  void mutate({ op: 'relation.save', fromId: selected.id, toId: relationTarget, kind: relationKind, note: relationNote, ...(relationSource ? { sourceId: relationSource } : {}), origin: modelRelation ? 'model' : 'user', expectedRevision: version }, '关系已保存为待确认建议。')
                }}>
                  <label>关联知识点<select value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)} required><option value="">选择另一知识点</option>{snapshot.knowledge.filter((point) => point.id !== selected.id).map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label>
                  <label>关系类型<select value={relationKind} onChange={(event) => setRelationKind(event.target.value as KnowledgeRelationKind)}>{['prerequisite', 'part-of', 'contrast', 'application'].map((kind) => <option key={kind} value={kind}>{labels[kind]}</option>)}</select></label>
                  <label>关系来源<select value={relationSource} onChange={(event) => setRelationSource(event.target.value)}><option value="">用户手动整理</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.path ?? source.referenceId ?? source.projectName}</option>)}</select></label>
                  <label>关系说明<input value={relationNote} maxLength={1_000} onChange={(event) => setRelationNote(event.target.value)} /></label>
                  <label className="learning-check"><input type="checkbox" checked={modelRelation} onChange={(event) => setModelRelation(event.target.checked)} />来自模型建议</label>
                  <button className="primary-button" type="submit" disabled={writeDisabled || !relationTarget}>保存关系建议</button>
                </form>}
              </details><details className="learning-group"><summary>复习材料</summary>
                {materials.map((material) => <article className="learning-item" key={material.id}><strong>{material.question}</strong><details><summary>核对参考答案与关联</summary><p>{material.answer}</p>{material.relationIds.map((id) => <p key={id}>{labels[snapshot.relations.find((relation) => relation.id === id)?.kind ?? '']} · {snapshot.relations.find((relation) => relation.id === id)?.note}</p>)}</details><p>{material.confirmedAt ? `下次：${dateLabel(material.schedule.dueAt)}` : '待确认，尚未加入队列'}</p><div className="learning-actions">{!managementOnly && <><button type="button" disabled={writeDisabled} onClick={() => editMaterial(material)}>修改题目</button>{material.confirmedAt && <button type="button" disabled={writeDisabled} onClick={() => {
                  setManualCardId(material.id)
                  setRevealedId(null)
                  feedback.current = null
                }}>手动复习</button>}{!material.confirmedAt && <button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'material.confirm', id: material.id, expectedRevision: version }, '已确认题目并加入复习队列。')}>确认题目并加入队列</button>}</>}<button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'material.delete', id: material.id, expectedRevision: version }, '已删除题目及其复习证据。')}>删除题目</button></div></article>)}
                {!managementOnly && <form onSubmit={(event) => {
                  event.preventDefault()
                  void mutate({ op: 'material.save', ...(editingMaterial ? { id: editingMaterial } : {}), knowledgeId: selected.id, question, answer, relationIds: materialRelation ? [materialRelation] : [], ...(materialSource ? { sourceId: materialSource } : {}), origin: modelMaterial ? 'model' : 'user', expectedRevision: version }, '题目已保存，核对并确认后才加入复习。').then((success) => {
                    if (success) {
                      setQuestion('')
                      setAnswer('')
                      setEditingMaterial(null)
                    }
                  })
                }}>
                  <label>复习问题<textarea value={question} maxLength={2_000} rows={2} onChange={(event) => setQuestion(event.target.value)} required /></label>
                  <label>参考答案<textarea value={answer} maxLength={4_000} rows={3} onChange={(event) => setAnswer(event.target.value)} required /></label>
                  <label>使用的知识关联<select value={materialRelation} onChange={(event) => setMaterialRelation(event.target.value)}><option value="">单知识点回忆</option>{relations.map((relation) => <option key={relation.id} value={relation.id}>{labels[relation.kind]} · {snapshot.knowledge.find((point) => point.id === (relation.fromId === selected.id ? relation.toId : relation.fromId))?.name}{relation.confirmedAt ? '' : '（待确认）'}</option>)}</select></label>
                  <label>题目来源<select value={materialSource} onChange={(event) => setMaterialSource(event.target.value)}><option value="">用户手动编写</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.path ?? source.referenceId ?? source.projectName}</option>)}</select></label>
                  <label className="learning-check"><input type="checkbox" checked={modelMaterial} onChange={(event) => setModelMaterial(event.target.checked)} />题目来自模型建议</label>
                  <button className="primary-button" type="submit" disabled={writeDisabled || !question.trim() || !answer.trim()}>{editingMaterial ? '保存题目修改' : '保存待确认题目'}</button>
                </form>}
              </details><details className="learning-item"><summary>复习证据记录</summary>{snapshot.events.filter((event) => event.knowledgeId === selected.id).slice().reverse().map((event) => <article key={event.id}><p>{labels[event.grade]} · {dateLabel(event.reviewedAt)} · 第 {event.revision} 版 · 下次 {dateLabel(event.nextDueAt)}</p><div className="learning-actions"><label>纠正复习反馈<select value={event.grade} disabled={writeDisabled} onChange={(change) => void mutate({ op: 'review.correct', id: event.id, grade: change.target.value as FlashcardGrade, expectedRevision: version }, '已纠正复习证据并重新计算到期时间。')}>{['again', 'hard', 'good', 'easy'].map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label><button type="button" disabled={writeDisabled} onClick={() => void mutate({ op: 'review.delete', id: event.id, expectedRevision: version }, '已删除本次复习证据并重新计算到期时间。')}>删除复习证据</button></div></article>)}</details>
            </section>}
          </div>
        </div>

      </>}
    </section>
  )
}
