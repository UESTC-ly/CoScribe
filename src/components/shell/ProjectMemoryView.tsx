import { useEffect, useState } from 'react'
import { BrainCircuit, ExternalLink, Save } from 'lucide-react'

import type { ProjectMemoryDocument } from '../../shared/types'

interface ProjectMemoryViewProps {
  projectPath: string
  onOpen: (path: string) => void
  onSaved: () => void | Promise<void>
  onSendToAi: (prompt: string) => void
}

export function ProjectMemoryView({ projectPath, onOpen, onSaved, onSendToAi }: ProjectMemoryViewProps): React.JSX.Element {
  const [document, setDocument] = useState<ProjectMemoryDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void window.coscribe.project.memory().then((next) => {
      if (!alive) return
      setDocument(next)
      setDraft(next.content)
    }).catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason.message : '无法读取项目记忆。')
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [projectPath])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await window.coscribe.project.saveMemory(draft)
      setDocument(next)
      setDraft(next.content)
      await onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目记忆保存失败。')
    } finally {
      setSaving(false)
    }
  }

  const dirty = Boolean(document && draft !== document.content)

  if (loading) return <div className="empty-state"><span className="viewer-spinner" /><strong>正在读取项目记忆</strong></div>

  return (
    <div className="project-memory">
      <div className="project-memory__intro">
        <span><BrainCircuit aria-hidden="true" /></span>
        <div>
          <strong>跨会话记忆</strong>
          <p>COSCRIBE.md 是项目内透明、可迁移的长期记忆。只记录稳定偏好、事实和决策。</p>
        </div>
      </div>
      <label className="project-memory__editor">
        <span>Markdown</span>
        <textarea
          value={draft}
          maxLength={32_000}
          spellCheck={false}
          aria-label="项目记忆 Markdown"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="project-memory__meta">
        <span>{draft.length.toLocaleString('zh-CN')} / 32,000</span>
        <span>{document?.exists ? '已写入项目' : '保存后创建 COSCRIBE.md'}</span>
      </div>
      {error && <p className="project-memory__error" role="alert">{error}</p>}
      <div className="project-memory__actions">
        <button className="primary-button" disabled={!dirty || saving} onClick={() => void save()}>
          <Save aria-hidden="true" />{saving ? '保存中…' : '保存记忆'}
        </button>
        <button className="secondary-button" disabled={!document?.exists} onClick={() => document && onOpen(document.path)}>
          <ExternalLink aria-hidden="true" />打开文件
        </button>
      </div>
      <button className="project-memory__ask" onClick={() => onSendToAi('请把下面这条稳定信息整理后加入项目记忆：\n\n')}>
        让 AI 帮我记住…
      </button>
      <p className="project-memory__notice">不要在记忆中保存 API Key、密码或大段会话原文。</p>
    </div>
  )
}
