import type { WebContents } from 'electron'

import type { SearchProgress, SearchResult } from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { KnowledgeIndexService } from './knowledge-index'
import { ProjectService } from './project'

const MAX_RESULTS = 300

function excerpt(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 90)
  const end = Math.min(text.length, index + queryLength + 140)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`
}

export class ProjectSearchService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly project: ProjectService,
    private readonly knowledge: KnowledgeIndexService
  ) {}

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  /** Bounded, locally indexed retrieval used only for an explicitly selected project scope. */
  async retrieve(rawQuery: string, limit = 8): Promise<SearchResult[]> {
    return this.knowledge.search(rawQuery, Math.max(1, Math.min(20, limit)), true)
  }

  private progress(sender: WebContents, value: SearchProgress): void {
    if (!sender.isDestroyed()) sender.send(IPC.searchProgress, value)
  }

  async query(sender: WebContents, requestId: string, rawQuery: string): Promise<SearchResult[]> {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('搜索请求 ID 无效。')
    if (typeof rawQuery !== 'string') throw new Error('搜索内容格式无效。')
    const query = rawQuery.trim().slice(0, 500)
    this.cancel(requestId)
    const controller = new AbortController()
    this.controllers.set(requestId, controller)

    if (!query) {
      this.progress(sender, { requestId, scanned: 0, total: 0, done: true })
      this.controllers.delete(requestId)
      return []
    }

    try {
      await this.knowledge.ensureFresh(false, (scanned, total, current) => {
        this.progress(sender, { requestId, scanned, total, ...(current ? { current } : {}), done: false })
      })
      if (controller.signal.aborted) return []

      const fileResults = await this.knowledge.search(query, MAX_RESULTS)
      const sessions = await this.project.listSessions()
      const total = this.knowledge.status().fileCount + sessions.length
      let scanned = this.knowledge.status().fileCount
      const results = [...fileResults]
      const needle = query.toLocaleLowerCase()

      for (const session of sessions) {
        if (controller.signal.aborted) return []
        this.progress(sender, { requestId, scanned, total, current: session.title, done: false })
        const searchable = `${session.title}\n${session.messages.map((message) => message.content).join('\n')}`
        const haystack = searchable.toLocaleLowerCase()
        const index = haystack.indexOf(needle)
        if (index !== -1 && results.length < MAX_RESULTS) {
          results.push({
            id: `session:${session.id}`,
            type: 'session',
            sessionId: session.id,
            title: session.title,
            excerpt: excerpt(searchable, index, query.length),
            score: session.title.toLocaleLowerCase().includes(needle) ? 110 : 70
          })
        }
        scanned += 1
      }
      results.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh-CN'))
      this.progress(sender, { requestId, scanned: total, total, done: true })
      return results.slice(0, MAX_RESULTS)
    } catch (error) {
      this.progress(sender, { requestId, scanned: 0, done: true })
      if ((error as Error).name === 'AbortError') return []
      throw error
    } finally {
      if (this.controllers.get(requestId) === controller) this.controllers.delete(requestId)
    }
  }
}
