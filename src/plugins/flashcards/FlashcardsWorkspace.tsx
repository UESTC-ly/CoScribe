import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Brain, CheckCircle2, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'

import type { FileKind } from '../../shared/types'
import {
  initialReviewState,
  parseFlashcards,
  scheduleReview,
  type Flashcard,
  type FlashcardGrade,
  type FlashcardReviewState
} from './flashcard-utils'

interface FlashcardsWorkspaceProps {
  files: Array<{ path: string; name: string; kind: FileKind }>
  aiConfigured: boolean
  onOpenMarkdown: (path: string) => void
  onGenerateWithAi: (topic: string) => void | Promise<void>
  onOpenSettings: () => void
}

interface FlashcardData {
  reviews: Record<string, FlashcardReviewState>
}

async function scanMarkdownFiles(files: FlashcardsWorkspaceProps['files']): Promise<Flashcard[]> {
  const markdown = files.filter((file) => file.kind === 'markdown')
  const cards: Flashcard[] = []
  for (let index = 0; index < markdown.length; index += 8) {
    const batch = markdown.slice(index, index + 8)
    const results = await Promise.all(batch.map(async (file) => {
      try { return parseFlashcards((await window.coscribe.file.read(file.path)).content, file.path) }
      catch { return [] }
    }))
    cards.push(...results.flat())
  }
  return cards
}

function relativeDate(value: number): string {
  if (value <= Date.now()) return '现在到期'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(value)
}

export default function FlashcardsWorkspace(props: FlashcardsWorkspaceProps): React.JSX.Element {
  const [cards, setCards] = useState<Flashcard[]>([])
  const [data, setData] = useState<FlashcardData>({ reviews: {} })
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)
  const [topic, setTopic] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setMessage(null)
    try {
      const [nextCards, stored] = await Promise.all([
        scanMarkdownFiles(props.files),
        window.coscribe.plugins.data('flashcards')
      ])
      setCards(nextCards)
      if (stored && typeof stored === 'object') {
        const reviews = (stored as Partial<FlashcardData>).reviews
        if (reviews && typeof reviews === 'object') setData({ reviews })
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '闪卡扫描失败。')
    } finally {
      setLoading(false)
    }
  }, [props.files])

  useEffect(() => { void load() }, [load])

  const dueCards = useMemo(() => cards.filter((card) => (data.reviews[card.id]?.dueAt ?? 0) <= Date.now()), [cards, data.reviews])
  const current = dueCards[0]
  const reviewed = cards.filter((card) => Boolean(data.reviews[card.id]?.lastReviewedAt)).length

  const grade = async (value: FlashcardGrade): Promise<void> => {
    if (!current) return
    const nextReview = scheduleReview(data.reviews[current.id] ?? initialReviewState(current.id), value)
    const next = { reviews: { ...data.reviews, [current.id]: nextReview } }
    setData(next)
    setRevealed(false)
    try { await window.coscribe.plugins.saveData('flashcards', next) }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '复习进度保存失败。') }
  }

  const generate = async (): Promise<void> => {
    if (!topic.trim()) return
    setMessage(null)
    try {
      await props.onGenerateWithAi(topic.trim())
      setMessage('AI 已在聊天侧边栏生成候选写入预览；确认后再刷新闪卡。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '无法生成闪卡。')
    }
  }

  return (
    <section className="plugin-workspace flashcards-workspace" aria-label="闪卡与间隔复习插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Brain size={23} /></span><div><small>LOCAL SPACED REPETITION</small><h1>闪卡与间隔复习</h1><p>使用相邻两行 <code>Q::</code> 与 <code>A::</code> 编写可移植闪卡</p></div></div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />重新扫描</button>
      </header>

      <div className="flashcard-metrics">
        <article><strong>{cards.length}</strong><small>项目闪卡</small></article>
        <article><strong>{dueCards.length}</strong><small>现在到期</small></article>
        <article><strong>{reviewed}</strong><small>已有记录</small></article>
      </div>

      <div className="flashcard-layout">
        <section className="review-card">
          <div className="plugin-section-title"><div><small>REVIEW QUEUE</small><h2>今日复习</h2></div>{current ? <span>{relativeDate(data.reviews[current.id]?.dueAt ?? 0)}</span> : <CheckCircle2 size={18} />}</div>
          {loading ? <div className="plugin-loading"><span className="viewer-spinner" />正在扫描 Markdown 闪卡…</div> : !current ? (
            <div className="plugin-empty"><CheckCircle2 size={28} /><strong>当前没有到期卡片</strong><p>你可以刷新项目，或让 AI 基于现有资料生成候选闪卡。</p></div>
          ) : (
            <div className="flashcard-stage">
              <small>问题</small><h3>{current.question}</h3>
              {revealed ? <div className="flashcard-answer"><small>答案</small><p>{current.answer}</p></div> : <button className="primary-button" type="button" onClick={() => setRevealed(true)}>显示答案</button>}
              {revealed && <div className="flashcard-grades" aria-label="评价本次回忆"><button onClick={() => void grade('again')}><RotateCcw size={13} />重来</button><button onClick={() => void grade('hard')}>困难</button><button onClick={() => void grade('good')}>记得</button><button onClick={() => void grade('easy')}>简单</button></div>}
              <button className="text-button flashcard-source" type="button" onClick={() => props.onOpenMarkdown(current.sourcePath)}>来源 · 第 {current.line} 行 <ArrowUpRight size={13} /></button>
            </div>
          )}
        </section>

        <aside className="flashcard-ai-card">
          <div className="plugin-section-title"><div><small>AI CANDIDATES</small><h2>从项目资料生成</h2></div><Sparkles size={17} /></div>
          <p>AI 只会生成文件操作预览。你确认后才会写入“闪卡”目录。</p>
          <textarea value={topic} onChange={(event) => setTopic(event.target.value)} rows={5} placeholder="例如：基于项目中有关 RAG 评估的资料，生成 12 张理解型闪卡" />
          <button className="primary-button" type="button" disabled={!topic.trim() || !props.aiConfigured} onClick={() => void generate()}><Sparkles size={14} />生成候选闪卡</button>
          {!props.aiConfigured && <p className="plugin-inline-message">需要先配置 AI。<button type="button" onClick={props.onOpenSettings}>打开设置</button></p>}
          {message && <p className="plugin-inline-message" role="status">{message}</p>}
        </aside>
      </div>
    </section>
  )
}
