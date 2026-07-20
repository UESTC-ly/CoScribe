import type { WebContents } from 'electron'

import type { FileNode, SearchProgress, SearchResult } from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { PdfTextService } from './pdf'
import { ProjectService } from './project'

const MAX_RESULTS = 300

const QUERY_STOP_WORDS = new Set([
  '当前', '项目', '文档', '文件', '资料', '内容', '回答', '一下', '哪些', '这个', '这些',
  'please', 'about', 'current', 'project', 'document', 'files', 'answer', 'find', 'search'
])

function flatten(nodes: FileNode[]): FileNode[] {
  const output: FileNode[] = []
  const visit = (node: FileNode) => {
    if (node.kind === 'folder') {
      node.children?.forEach(visit)
    } else {
      output.push(node)
    }
  }
  nodes.forEach(visit)
  return output
}

function excerpt(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 90)
  const end = Math.min(text.length, index + queryLength + 140)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let cursor = 0
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1
    cursor += Math.max(needle.length, 1)
  }
  return count
}

function lineAndHeading(content: string, index: number): { line: number; heading?: string } {
  const before = content.slice(0, index)
  const line = before.split('\n').length
  const headingMatches = [...before.matchAll(/^#{1,6}\s+(.+)$/gmu)]
  const lastHeading = headingMatches.at(-1)?.[1]?.trim()
  return { line, ...(lastHeading ? { heading: lastHeading } : {}) }
}

function retrievalTokens(rawQuery: string): string[] {
  const raw = rawQuery.toLocaleLowerCase().slice(0, 1_000)
  const matches = raw.match(/[a-z][a-z0-9_.-]{1,}|[\p{Script=Han}]{2,}/gu) ?? []
  const tokens = new Set<string>()
  for (const match of matches) {
    if (QUERY_STOP_WORDS.has(match)) continue
    if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 6) {
      for (let index = 0; index < match.length - 1; index += 2) {
        const token = match.slice(index, Math.min(match.length, index + 4))
        if (!QUERY_STOP_WORDS.has(token)) tokens.add(token)
      }
    } else tokens.add(match)
  }
  return [...tokens].sort((left, right) => right.length - left.length).slice(0, 10)
}

function retrievalScore(text: string, tokens: readonly string[]): { score: number; index: number; tokenLength: number } {
  const haystack = text.toLocaleLowerCase()
  let score = 0
  let firstIndex = -1
  let tokenLength = 0
  for (const token of tokens) {
    const index = haystack.indexOf(token)
    if (index < 0) continue
    if (firstIndex < 0 || index < firstIndex) {
      firstIndex = index
      tokenLength = token.length
    }
    score += 12 + Math.min(20, countOccurrences(haystack, token) * 2) + Math.min(8, token.length)
  }
  return { score, index: firstIndex, tokenLength }
}

export class ProjectSearchService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly project: ProjectService,
    private readonly pdf: PdfTextService
  ) {}

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  /** Bounded app-owned retrieval, called only for an explicitly selected project scope. */
  async retrieve(rawQuery: string, limit = 8): Promise<SearchResult[]> {
    const tokens = retrievalTokens(rawQuery)
    const files = flatten(await this.project.tree())
    const results: SearchResult[] = []

    for (const file of files) {
      if (file.kind === 'markdown' || file.kind === 'text') {
        try {
          const value = await this.project.read(file.path)
          const match = retrievalScore(`${file.name}\n${value.content}`, tokens)
          if (tokens.length > 0 && match.score === 0) continue
          const contentIndex = Math.max(0, match.index - file.name.length - 1)
          const location = lineAndHeading(value.content, contentIndex)
          results.push({
            id: `retrieve:${file.path}:${location.line}`,
            type: 'content',
            path: file.path,
            title: file.name,
            excerpt: excerpt(value.content, contentIndex, Math.max(1, match.tokenLength)),
            kind: file.kind,
            line: location.line,
            ...('heading' in location ? { heading: location.heading } : {}),
            score: match.score || 1
          })
        } catch {
          // Unreadable files are omitted rather than guessed.
        }
      } else if (file.kind === 'pdf') {
        try {
          const pages = await this.pdf.allPages(file.path)
          for (const page of pages) {
            if (!page.readable) continue
            const match = retrievalScore(`${file.name}\n${page.text}`, tokens)
            if (tokens.length > 0 && match.score === 0) continue
            const textIndex = Math.max(0, match.index - file.name.length - 1)
            results.push({
              id: `retrieve-pdf:${file.path}:${page.page}`,
              type: 'content',
              path: file.path,
              title: file.name,
              excerpt: excerpt(page.text, textIndex, Math.max(1, match.tokenLength)),
              kind: 'pdf',
              page: page.page,
              score: match.score || Math.max(1, 4 - page.page / 100)
            })
          }
        } catch {
          // Damaged and scanned PDFs contribute no fabricated text.
        }
      }
    }

    return results
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh-CN'))
      .slice(0, Math.max(1, Math.min(20, limit)))
  }

  private progress(sender: WebContents, value: SearchProgress): void {
    if (!sender.isDestroyed()) sender.send(IPC.searchProgress, value)
  }

  async query(sender: WebContents, requestId: string, rawQuery: string): Promise<SearchResult[]> {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('搜索请求 ID 无效。')
    if (typeof rawQuery !== 'string') throw new Error('搜索内容格式无效。')
    const query = rawQuery.trim().slice(0, 500)
    const needle = query.toLocaleLowerCase()
    this.cancel(requestId)
    const controller = new AbortController()
    this.controllers.set(requestId, controller)

    if (!needle) {
      this.progress(sender, { requestId, scanned: 0, total: 0, done: true })
      this.controllers.delete(requestId)
      return []
    }

    const files = flatten(await this.project.tree())
    const sessions = await this.project.listSessions()
    const total = files.length + sessions.length
    let scanned = 0
    const results: SearchResult[] = []

    const add = (result: SearchResult) => {
      if (results.length < MAX_RESULTS) results.push(result)
    }

    try {
      this.progress(sender, { requestId, scanned, total, done: false })
      for (const file of files) {
        if (controller.signal.aborted) throw new DOMException('Search cancelled', 'AbortError')
        this.progress(sender, { requestId, scanned, total, current: file.path, done: false })
        const lowerName = file.name.toLocaleLowerCase()
        const nameIndex = lowerName.indexOf(needle)
        if (nameIndex !== -1) {
          add({
            id: `file:${file.path}`,
            type: 'file',
            path: file.path,
            title: file.name,
            excerpt: file.path,
            kind: file.kind,
            score: 120 + countOccurrences(lowerName, needle) * 5
          })
        }

        if (file.kind === 'markdown' || file.kind === 'text') {
          try {
            const value = await this.project.read(file.path)
            const haystack = value.content.toLocaleLowerCase()
            const index = haystack.indexOf(needle)
            if (index !== -1) {
              const location = lineAndHeading(value.content, index)
              add({
                id: `content:${file.path}:${location.line}`,
                type: 'content',
                path: file.path,
                title: file.name,
                excerpt: excerpt(value.content, index, query.length),
                kind: file.kind,
                line: location.line,
                ...('heading' in location ? { heading: location.heading } : {}),
                score: 80 + Math.min(20, countOccurrences(haystack, needle))
              })
            }
          } catch {
            // Unreadable files remain searchable by name.
          }
        } else if (file.kind === 'pdf') {
          try {
            const pages = await this.pdf.allPages(file.path)
            for (const page of pages) {
              if (controller.signal.aborted) throw new DOMException('Search cancelled', 'AbortError')
              const haystack = page.text.toLocaleLowerCase()
              const index = haystack.indexOf(needle)
              if (index !== -1) {
                add({
                  id: `pdf:${file.path}:${page.page}`,
                  type: 'content',
                  path: file.path,
                  title: file.name,
                  excerpt: excerpt(page.text, index, query.length),
                  kind: 'pdf',
                  page: page.page,
                  score: 85 + Math.min(20, countOccurrences(haystack, needle))
                })
              }
            }
          } catch (error) {
            if ((error as Error).name === 'AbortError') throw error
          }
        }
        scanned += 1
      }

      for (const session of sessions) {
        if (controller.signal.aborted) throw new DOMException('Search cancelled', 'AbortError')
        this.progress(sender, { requestId, scanned, total, current: session.title, done: false })
        const searchable = `${session.title}\n${session.messages.map((message) => message.content).join('\n')}`
        const haystack = searchable.toLocaleLowerCase()
        const index = haystack.indexOf(needle)
        if (index !== -1) {
          add({
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
      this.progress(sender, { requestId, scanned, total, done: true })
      return results
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.progress(sender, { requestId, scanned, total, done: true })
        return []
      }
      this.progress(sender, { requestId, scanned, total, done: true })
      throw error
    } finally {
      if (this.controllers.get(requestId) === controller) this.controllers.delete(requestId)
    }
  }
}
