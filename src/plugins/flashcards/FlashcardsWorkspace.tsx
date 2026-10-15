import { useState } from 'react'
import { Brain, Sparkles } from 'lucide-react'

import { LearningPanel } from '../../components/assistant/LearningPanel'
import type { FileKind } from '../../shared/types'

interface FlashcardsWorkspaceProps {
  files: Array<{
    path: string
    name: string
    kind: FileKind
  }>
  aiConfigured: boolean
  learningGranted: boolean
  learningWritable: boolean
  readingContext?: {
    path: string
    quote?: string
    page?: number
  }
  onOpenMarkdown: (path: string) => void
  onGenerateWithAi: (topic: string) => void | Promise<void>
  onOpenSettings: () => void
}

export default function FlashcardsWorkspace(props: FlashcardsWorkspaceProps): React.JSX.Element {
  const [topic, setTopic] = useState('')
  const [message, setMessage] = useState('')
  const [generating, setGenerating] = useState(false)
  const generate = async (): Promise<void> => {
    if (!topic.trim() || generating) return
    setGenerating(true)
    setMessage('')
    try {
      await props.onGenerateWithAi(topic.trim())
      setMessage('AI 已生成候选文件预览；确认保存后，可显式导入学习库。')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '无法生成闪卡。') }
    finally { setGenerating(false) }
  }
  return (
    <section className="plugin-workspace flashcards-workspace" aria-label="闪卡与间隔复习插件">
      <header className="plugin-hero"><div className="plugin-hero__identity"><span><Brain size={23} aria-hidden="true" /></span><div><small>PERSONAL LEARNING</small><h1>闪卡与间隔复习</h1><p>知识点、学习依据与关联复习。旧 <code>Q:: / A::</code> 闪卡可显式导入，原记录保留。</p></div></div></header>
      {props.learningGranted ? <LearningPanel files={props.files} writable={props.learningWritable} readingContext={props.readingContext} onOpenSource={props.onOpenMarkdown} /> : <p className="plugin-inline-message" role="status">请在插件中心补充“读取／写入全局个人学习库”权限。已有记录可在设置 → 关于我中管理。</p>}
      <details className="flashcard-ai-card learning-ai"><summary>从项目资料生成 AI 候选闪卡</summary><p>预览并确认保存 Markdown 后，再主动导入学习库。模型输出不直接写入学习状态。</p><label>AI 闪卡主题<textarea value={topic} onChange={(event) => setTopic(event.target.value)} rows={3} /></label><button className="primary-button" type="button" disabled={generating || !topic.trim() || !props.aiConfigured} onClick={() => void generate()}><Sparkles size={14} aria-hidden="true" />{generating ? '正在生成…' : '生成候选闪卡'}</button>{!props.aiConfigured && <p>需要先配置 AI。<button type="button" onClick={props.onOpenSettings}>打开设置</button></p>}{message && <p role="status">{message}</p>}</details>
    </section>
  )
}
