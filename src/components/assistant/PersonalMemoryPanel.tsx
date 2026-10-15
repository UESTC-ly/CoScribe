import { useEffect, useRef, useState } from 'react'
import { LearningPanel } from './LearningPanel'

import type { PersonalMemory, PersonalMemoryCategory, PersonalMemorySnapshot } from '../../shared/assistant'
import type { AiProviderProfile } from '../../shared/types'

const categoryLabels: Record<PersonalMemoryCategory, string> = {
  preference: '表达偏好', profile: '个人信息', goal: '当前目标'
}

export function PersonalMemoryPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<PersonalMemorySnapshot | null>(null)
  const [text, setText] = useState('')
  const [category, setCategory] = useState<PersonalMemoryCategory>('preference')
  const [editing, setEditing] = useState<PersonalMemory | null>(null)
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [replacements, setReplacements] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([])
  const [searchProfile, setSearchProfile] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const pending = useRef(false)

  useEffect(() => {
    let current = true
    void window.coscribe.assistant.memory.list().then(
      (value) => { if (current) setSnapshot(value) },
      () => { if (current) setError('个人记忆存储不可用。原数据已保留，普通聊天仍可使用。') }
    )
    void window.coscribe.settings.get().then((settings) => { if (current) setProfiles(settings.aiProfiles.filter((profile) => profile.provider === 'openai')) }, () => undefined)
    return () => { current = false }
  }, [])
  useEffect(() => {
    setSearchProfile(snapshot?.search?.profileId ?? '')
    setEmbeddingModel(snapshot?.search?.model ?? '')
  }, [snapshot?.search?.profileId, snapshot?.search?.model])

  const perform = async (action: () => Promise<PersonalMemorySnapshot>, success: string): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setSnapshot(await action())
      setNotice(success)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请刷新后重试。')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    if (!text.trim()) { setError('请填写需要记住的内容。'); return }
    await perform(async () => {
      const value = editing
        ? await window.coscribe.assistant.memory.update({ id: editing.id, expectedRevision: editing.revision, category, text })
        : await window.coscribe.assistant.memory.remember({ category, text })
      setText('')
      setEditing(null)
      return value
    }, editing ? '已修正记忆，后续召回使用新内容。' : '已保存记忆。')
  }

  return (
    <div className="settings-sections" aria-label="个人记忆管理">
      <section className="settings-section">
        <header><div><h3>关于我</h3><p>管理明确保存的信息与已授权的新对话自述。自动记忆默认关闭，不读取历史对话、邮件或日历。</p></div></header>
        <p className="field-caption">此页操作即时保存。修改或关闭记忆会停止正在进行的 AI 请求。</p>
        {snapshot?.storage && <p className="field-caption">记忆正文保存为 Markdown，SQLite 保存索引与来源。全局目录：{snapshot.storage.directory}</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status">正在保存或读取记忆…</p>}
        {!snapshot && !error && <p role="status">正在读取个人记忆…</p>}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => window.coscribe.assistant.memory.list(), '已刷新。')}>刷新记忆</button>
        {snapshot && (
          <div className="settings-grid">
            <label className="check-row span-2">
              <input type="checkbox" checked={snapshot.policy.enabled} disabled={busy} onChange={(event) => {
                const enabled = event.target.checked
                void perform(() => window.coscribe.assistant.memory.setPolicy({ enabled, allowRemote: snapshot.policy.allowRemote, expectedRevision: snapshot.policy.revision }), enabled ? '已启用个人记忆。' : '已关闭个人记忆召回，保存的数据仍可管理。')
              }} />
              <span><strong>回答时使用个人记忆</strong><small>默认关闭。启用后，普通聊天使用少量偏好、相关信息及最新学习状态。</small></span>
            </label>
            <label className="check-row span-2">
              <input type="checkbox" checked={snapshot.policy.allowRemote} disabled={busy || !snapshot.policy.enabled} onChange={(event) => {
                const allowRemote = event.target.checked
                void perform(() => window.coscribe.assistant.memory.setPolicy({ enabled: snapshot.policy.enabled, allowRemote, expectedRevision: snapshot.policy.revision }), allowRemote ? '已允许向所选远程 AI 服务发送相关个人记忆。' : '已禁止向远程 AI 服务发送个人记忆。')
              }} />
              <span><strong>允许远程 AI 服务处理个人记忆</strong><small>默认关闭。关闭时个人学习状态也遵守此授权。关闭时仅向本机回环地址发送；此设置只控制额外召回的记忆，不控制你主动发送的聊天正文和项目资料。</small></span>
            </label>
          </div>
        )}
      </section>
      {snapshot && (
        <>
          <section className="settings-section">
            <header><div><h3>记忆检索</h3><p>少量摘要随问题加载，模型可按需搜索和读取原文。默认使用关键词；可选语义检索补充同义表达。</p></div></header>
            <div className="settings-grid">
              <label className="field-label">检索服务
                <select className="field" disabled={busy} value={searchProfile} onChange={(event) => setSearchProfile(event.target.value)}>
                  <option value="">仅关键词</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.baseUrl}</option>)}
                </select>
              </label>
              <label className="field-label">Embedding 模型
                <input className="field" disabled={busy || !searchProfile} value={embeddingModel} maxLength={100} placeholder="服务支持的 embedding 模型名称" onChange={(event) => setEmbeddingModel(event.target.value)} />
              </label>
            </div>
            <p className="field-caption">语义检索会在记忆新增或修改后建立向量，查询时处理检索词，可能产生服务费用。远程 embedding 也需要上方的个人记忆远程授权；凭据沿用所选服务配置。索引更新或服务失败时会提示并保留关键词检索。</p>
            <button className="secondary-button" type="button" disabled={busy || Boolean(searchProfile && !embeddingModel.trim())} onClick={() => void perform(() => window.coscribe.assistant.memory.setSearch({ profileId: searchProfile, model: searchProfile ? embeddingModel : '', expectedRevision: snapshot.policy.revision }), '检索设置已保存。')}>保存检索设置</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void perform(() => window.coscribe.assistant.memory.rebuildIndex({ expectedRevision: snapshot.policy.revision }), '已从 Markdown 正文重建检索索引。')}>重建索引</button>
          </section>
          <section className="settings-section">
            <header><div><h3>自动记忆</h3><p>仅从本次直接输入的明确自述提取，不处理引用、附件或模型回答。采用本地规则，不调用模型。</p></div></header>
            <label className="check-row">
              <input type="checkbox" checked={snapshot.automatic.enabled} disabled={busy} onChange={(event) => {
                const enabled = event.target.checked
                void perform(() => window.coscribe.assistant.memory.setAutomatic({ enabled, saveLearning: snapshot.automatic.saveLearning, expectedRevision: snapshot.automatic.revision }), '自动记忆授权已更新，旧授权下的待确认候选已清除。')
              }} />
              <span><strong>从新对话提取记忆候选</strong><small>默认关闭。偏好和个人信息始终需要确认。</small></span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={snapshot.automatic.saveLearning} disabled={busy || !snapshot.automatic.enabled} onChange={(event) => {
                const saveLearning = event.target.checked
                void perform(() => window.coscribe.assistant.memory.setAutomatic({ enabled: snapshot.automatic.enabled, saveLearning, expectedRevision: snapshot.automatic.revision }), '自动保存授权已更新，旧授权下的待确认候选已清除。')
              }} />
              <span><strong>自动保存明确的学习状态</strong><small>例如“我正在学习图论”。仅保存没有冲突的非敏感自述；可随时修正、遗忘。</small></span>
            </label>
            <h4>待确认候选 · {snapshot.candidates.length}</h4>
            {!snapshot.candidates.length && <p className="field-caption">没有待确认候选。新对话结束后可刷新查看。</p>}
            {snapshot.candidates.map((item) => <article key={item.id} className="personal-memory-item">
              <strong>{categoryLabels[item.category]}</strong><p className="personal-memory-text">{item.text}</p>
              <details><summary>查看候选来源</summary><p>{item.quote}</p><p className="field-caption">用户直接输入 · 会话 {item.sessionId} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p></details>
              {item.conflict && <label className="field-label">已有同类记忆，确认处理方式
                <select className="field" disabled={busy} value={replacements[item.id] ?? ''} onChange={(event) => setReplacements((current) => ({ ...current, [item.id]: event.target.value }))}>
                  <option value="">保留原信息，新增这条记忆</option>
                  {snapshot.items.filter((memory) => memory.category === item.category).map((memory) => <option key={memory.id} value={memory.id}>替换：{memory.text}</option>)}
                </select>
              </label>}
              <div className="personal-memory-actions">
                <button className="secondary-button" disabled={busy} type="button" onClick={() => void perform(() => {
                  const previous = snapshot.items.find((memory) => memory.id === replacements[item.id])
                  return window.coscribe.assistant.memory.resolveCandidate({ id: item.id, action: 'accept', ...(previous ? { replaceId: previous.id, expectedRevision: previous.revision } : {}) })
                }, '已确认候选并保存记忆。')}>{replacements[item.id] ? '确认替换' : '确认记住'}</button>
                <button className="secondary-button" disabled={busy} type="button" onClick={() => void perform(() => window.coscribe.assistant.memory.resolveCandidate({ id: item.id, action: 'dismiss' }), '已忽略，此自述不会再次自动加入。')}>忽略候选</button>
              </div>
            </article>)}
          </section>
          <section className="settings-section">
            <header><div><h3>{editing ? '修正记忆' : '明确记住'}</h3><p>以你自己的陈述为来源，不把模型推断保存为个人事实。</p></div></header>
            <form onSubmit={(event) => { event.preventDefault(); void save() }}>
              <div className="settings-grid">
                <label className="field-label span-2">记忆类别
                  <select className="field" disabled={busy} value={category} onChange={(event) => setCategory(event.target.value as PersonalMemoryCategory)}>
                    {Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label className="field-label span-2">记忆内容
                  <textarea className="field" rows={3} maxLength={1_000} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：讲解时先给一个具体例子，再说明原理。" />
                  <small className="field-caption">{text.length} / 1,000</small>
                </label>
              </div>
              <button className="primary-button" type="submit" disabled={busy || !text.trim()}>{busy ? '正在保存…' : editing ? '保存修正' : '记住这条信息'}</button>
              {editing && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setEditing(null); setText('') }}>取消修正</button>}
            </form>
          </section>
          <section className="settings-section">
            <header><div><h3>已保存的记忆 · {snapshot.items.length}</h3><p>遗忘会删除这条记忆及其检索内容，不删除原始聊天、活动账本、导出文件或系统备份。</p></div></header>
            {!snapshot.items.length && <p className="field-caption">还没有个人记忆。</p>}
            {snapshot.items.map((item) => (
              <article key={item.id} className="personal-memory-item">
                <strong>{categoryLabels[item.category]}</strong>
                <p className="personal-memory-text">{item.text}</p>
                <details><summary>查看来源</summary><p className="field-caption">{item.source.origin === 'memory-file' ? '你在记忆目录中的 Markdown 修订' : item.source.origin === 'chat' ? (item.source.kind === 'user-stated' ? '授权自动保存的用户自述' : '用户确认的对话自述') : '你在“关于我”中的明确输入'} · {new Date(item.source.recordedAt).toLocaleString('zh-CN')} · 第 {item.revision} 版</p><p className="field-caption">来源编号：{item.source.id} · memory/{item.id}.md</p>{item.source.quote && <p>原文：{item.source.quote} · 会话 {item.source.sessionId}</p>}</details>
                <div className="personal-memory-actions">
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => { setEditing(item); setText(item.text); setCategory(item.category); setForgetting(null) }}>修正</button>
                  {forgetting === item.id ? (
                    <>
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => void perform(async () => {
                        const value = await window.coscribe.assistant.memory.forget({ id: item.id, expectedRevision: item.revision })
                        setForgetting(null)
                        if (editing?.id === item.id) { setEditing(null); setText('') }
                        return value
                      }, '已遗忘，这条信息不再参与个人记忆召回。')}>确认遗忘</button>
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => setForgetting(null)}>保留</button>
                    </>
                  ) : <button className="secondary-button" type="button" disabled={busy} onClick={() => setForgetting(item.id)}>遗忘</button>}
                </div>
              </article>
            ))}
          </section>
        </>
      )}
      {snapshot && <LearningPanel managementOnly />}
    </div>
  )
}
