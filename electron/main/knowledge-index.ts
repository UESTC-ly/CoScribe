import path from 'node:path'

import type {
  BacklinkEdge,
  BacklinkGraph,
  BacklinkNode,
  FileKind,
  FileNode,
  KnowledgeIndexStatus,
  SearchResult
} from '../../src/shared/types'
import { ProjectService } from './project'
import { PdfTextService } from './pdf'

const INDEX_VERSION = 1
const CHUNK_CHARACTERS = 6_000
const MAX_INDEXED_TEXT_PER_FILE = 4 * 1024 * 1024
const MAX_TOTAL_INDEXED_TEXT = 64 * 1024 * 1024
const MAX_RESULTS = 300
const INDEXABLE_KINDS = new Set<FileKind>(['markdown', 'text', 'docx', 'ppt', 'pptx', 'pdf', 'image'])
const QUERY_STOP_WORDS = new Set([
  '当前', '项目', '文档', '文件', '资料', '内容', '回答', '一下', '哪些', '这个', '这些',
  'please', 'about', 'current', 'project', 'document', 'files', 'answer', 'find', 'search'
])

interface IndexSegment {
  text: string
  line?: number
  heading?: string
  page?: number
}

interface IndexedDocument {
  relativePath: string
  name: string
  kind: FileKind
  size: number
  modifiedAt: number
  segments: IndexSegment[]
}

interface StoredIndex {
  version: 1
  indexedAt: number
  documents: IndexedDocument[]
}

function flatten(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  const visit = (node: FileNode): void => {
    if (node.kind === 'folder') node.children?.forEach(visit)
    else files.push(node)
  }
  nodes.forEach(visit)
  return files
}

function portableRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function absolutePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'))
}

function boundedText(value: string, maximumBytes = MAX_INDEXED_TEXT_PER_FILE): string {
  const normalized = value.replace(/\r\n?/gu, '\n')
  const bytes = Buffer.from(normalized)
  if (bytes.length <= maximumBytes) return normalized
  return bytes.subarray(0, maximumBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function textBytes(segments: readonly IndexSegment[]): number {
  return segments.reduce((total, segment) => total + Buffer.byteLength(segment.text), 0)
}

function boundedSegments(segments: readonly IndexSegment[]): IndexSegment[] {
  let remaining = MAX_INDEXED_TEXT_PER_FILE
  const result: IndexSegment[] = []
  for (const segment of segments) {
    if (remaining <= 0) break
    const text = boundedText(segment.text, remaining)
    if (!text) continue
    result.push({ ...segment, text })
    remaining -= Buffer.byteLength(text)
  }
  return result
}

function textSegments(raw: string): IndexSegment[] {
  const content = boundedText(raw)
  if (!content) return []
  const lines = content.split('\n')
  const segments: IndexSegment[] = []
  let current: string[] = []
  let currentLength = 0
  let startLine = 1
  let heading: string | undefined
  let segmentHeading: string | undefined

  const flush = (): void => {
    const value = current.join('\n').trim()
    if (value) segments.push({ text: value, line: startLine, ...(segmentHeading ? { heading: segmentHeading } : {}) })
    current = []
    currentLength = 0
    segmentHeading = heading
  }

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^#{1,6}\s+(.+)$/u)
    if (match?.[1]) heading = match[1].trim()
    if (!current.length) {
      startLine = index + 1
      segmentHeading = heading
    }
    if (currentLength + line.length + 1 > CHUNK_CHARACTERS && current.length) flush()
    current.push(line)
    currentLength += line.length + 1
  }
  flush()
  return segments
}

function excerpt(text: string, index: number, queryLength: number): string {
  const safeIndex = Math.max(0, index)
  const start = Math.max(0, safeIndex - 90)
  const end = Math.min(text.length, safeIndex + Math.max(1, queryLength) + 140)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let cursor = 0
  while (needle && (cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1
    cursor += needle.length
  }
  return count
}

export function retrievalTokens(rawQuery: string): string[] {
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

function isStoredIndex(value: unknown): value is StoredIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<StoredIndex>
  return candidate.version === INDEX_VERSION && typeof candidate.indexedAt === 'number' && Array.isArray(candidate.documents)
}

function normalizedStoredIndex(value: unknown): StoredIndex {
  if (!isStoredIndex(value)) return { version: INDEX_VERSION, indexedAt: 0, documents: [] }
  let retainedText = 0
  const documents = value.documents.flatMap((document): IndexedDocument[] => {
    if (!document || typeof document !== 'object') return []
    if (typeof document.relativePath !== 'string' || document.relativePath.includes('..') || path.isAbsolute(document.relativePath)) return []
    if (typeof document.name !== 'string' || !INDEXABLE_KINDS.has(document.kind)) return []
    if (!Array.isArray(document.segments)) return []
    const segments = boundedSegments(document.segments.flatMap((segment): IndexSegment[] => {
      if (!segment || typeof segment.text !== 'string') return []
      return [{
        text: boundedText(segment.text),
        ...(typeof segment.line === 'number' && segment.line > 0 ? { line: Math.floor(segment.line) } : {}),
        ...(typeof segment.heading === 'string' ? { heading: segment.heading.slice(0, 2_000) } : {}),
        ...(typeof segment.page === 'number' && segment.page > 0 ? { page: Math.floor(segment.page) } : {})
      }]
    }))
    const textSize = textBytes(segments)
    if (retainedText + textSize > MAX_TOTAL_INDEXED_TEXT) return []
    retainedText += textSize
    return [{
      relativePath: document.relativePath,
      name: document.name.slice(0, 1_000),
      kind: document.kind,
      size: Number.isFinite(document.size) ? document.size : 0,
      modifiedAt: Number.isFinite(document.modifiedAt) ? document.modifiedAt : 0,
      segments
    }]
  })
  return { version: INDEX_VERSION, indexedAt: value.indexedAt, documents }
}

function markdownTitle(document: IndexedDocument): string {
  const heading = document.segments.map((segment) => segment.text.match(/^#\s+(.+)$/mu)?.[1]?.trim()).find(Boolean)
  return heading || path.basename(document.relativePath, path.extname(document.relativePath))
}

function markdownLine(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length
}

function resolveMarkdownTarget(source: IndexedDocument, rawTarget: string, notes: IndexedDocument[]): IndexedDocument | undefined {
  const decoded = (() => { try { return decodeURIComponent(rawTarget) } catch { return rawTarget } })()
  const clean = decoded.split(/[?#]/u, 1)[0]?.trim().replace(/\\/gu, '/') ?? ''
  if (!clean || /^(?:https?:|mailto:|data:)/iu.test(clean)) return undefined
  const titleTarget = clean.replace(/\.(?:md|markdown)$/iu, '').toLocaleLowerCase()
  const byTitle = notes.filter((note) => markdownTitle(note).toLocaleLowerCase() === titleTarget || path.basename(note.relativePath, path.extname(note.relativePath)).toLocaleLowerCase() === titleTarget)
  if (!clean.includes('/') && byTitle.length === 1) return byTitle[0]
  const base = clean.startsWith('/') ? clean.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(path.posix.dirname(source.relativePath), clean))
  const candidates = /\.(?:md|markdown)$/iu.test(base) ? [base] : [base, `${base}.md`, `${base}.markdown`]
  return notes.find((note) => candidates.includes(note.relativePath))
}

export class KnowledgeIndexService {
  private root = ''
  private documents = new Map<string, IndexedDocument>()
  private loaded = false
  private validatedForSession = false
  private forceDirty = false
  private readonly dirtyPaths = new Set<string>()
  private indexing: Promise<KnowledgeIndexStatus> | null = null
  private currentStatus: KnowledgeIndexStatus = {
    state: 'idle', fileCount: 0, segmentCount: 0, indexedAt: 0, durationMs: 0, changedFiles: 0, storedBytes: 0
  }

  constructor(private readonly project: ProjectService, private readonly pdf: PdfTextService) {}

  invalidate(filePath?: string): void {
    if (!filePath || !this.root) {
      this.forceDirty = true
      return
    }
    this.dirtyPaths.add(portableRelative(this.root, filePath))
  }

  reset(): void {
    this.root = ''
    this.documents.clear()
    this.loaded = false
    this.validatedForSession = false
    this.forceDirty = false
    this.dirtyPaths.clear()
    this.indexing = null
    this.currentStatus = { state: 'idle', fileCount: 0, segmentCount: 0, indexedAt: 0, durationMs: 0, changedFiles: 0, storedBytes: 0 }
  }

  status(): KnowledgeIndexStatus {
    return { ...this.currentStatus }
  }

  private async load(): Promise<void> {
    const root = this.project.info.path
    if (this.loaded && this.root === root) return
    this.root = root
    const stored = normalizedStoredIndex(await this.project.readMetadata<unknown>('knowledge-index', { version: INDEX_VERSION, indexedAt: 0, documents: [] }))
    this.documents = new Map(stored.documents.map((document) => [document.relativePath, document]))
    this.loaded = true
    this.validatedForSession = false
    const serialized = JSON.stringify(stored)
    this.currentStatus = {
      state: stored.indexedAt ? 'ready' : 'idle',
      fileCount: stored.documents.length,
      segmentCount: stored.documents.reduce((total, document) => total + document.segments.length, 0),
      indexedAt: stored.indexedAt,
      durationMs: 0,
      changedFiles: 0,
      storedBytes: Buffer.byteLength(serialized)
    }
  }

  private async indexDocument(file: FileNode): Promise<IndexedDocument> {
    let segments: IndexSegment[] = []
    if (file.kind === 'pdf') {
      const pages = await this.pdf.allPages(file.path)
      segments = pages.filter((page) => page.readable && page.text.trim()).map((page) => ({ text: boundedText(page.text), page: page.page }))
      const readablePages = new Set(segments.map((segment) => segment.page))
      for (const ocr of await this.project.ocrResults(file.path)) {
        if (ocr.text.trim() && !readablePages.has(ocr.page)) segments.push({ text: boundedText(ocr.text), ...(ocr.page ? { page: ocr.page } : {}) })
      }
    } else if (file.kind === 'image') {
      const ocr = await this.project.getOcr(file.path)
      segments = ocr?.text.trim() ? [{ text: boundedText(ocr.text) }] : []
    } else {
      segments = textSegments((await this.project.read(file.path)).content)
    }
    return {
      relativePath: portableRelative(this.root, file.path),
      name: file.name,
      kind: file.kind,
      size: file.size,
      modifiedAt: file.modifiedAt,
      segments: boundedSegments(segments)
    }
  }

  async ensureFresh(
    force = false,
    onProgress?: (scanned: number, total: number, current?: string) => void
  ): Promise<KnowledgeIndexStatus> {
    if (this.indexing) return this.indexing
    this.indexing = (async () => {
      const started = performance.now()
      let dirtyAtStart = new Set<string>()
      let forcedAtStart = false
      try {
        await this.load()
        if (!force && this.validatedForSession && !this.forceDirty && this.dirtyPaths.size === 0 && this.currentStatus.state === 'ready') {
          onProgress?.(this.currentStatus.fileCount, this.currentStatus.fileCount)
          return this.status()
        }
        forcedAtStart = this.forceDirty
        dirtyAtStart = new Set(this.dirtyPaths)
        this.forceDirty = false
        this.dirtyPaths.clear()
        const files = flatten(await this.project.tree()).filter((file) => INDEXABLE_KINDS.has(file.kind))
        const nextPaths = new Set(files.map((file) => portableRelative(this.root, file.path)))
        let changedFiles = 0
        let retainedText = [...this.documents.values()].reduce((total, document) => total + textBytes(document.segments), 0)
        this.currentStatus = { ...this.currentStatus, state: 'indexing', error: undefined }
        for (const [index, file] of files.entries()) {
          const relativePath = portableRelative(this.root, file.path)
          const cached = this.documents.get(relativePath)
          const changed = force || forcedAtStart || dirtyAtStart.has(relativePath) || !cached || cached.modifiedAt !== file.modifiedAt || cached.size !== file.size || cached.kind !== file.kind
          onProgress?.(index, files.length, file.path)
          if (!changed) continue
          changedFiles += 1
          retainedText -= cached ? textBytes(cached.segments) : 0
          try {
            const indexed = await this.indexDocument(file)
            const indexedText = textBytes(indexed.segments)
            const retained = retainedText + indexedText <= MAX_TOTAL_INDEXED_TEXT ? indexed : { ...indexed, segments: [] }
            this.documents.set(relativePath, retained)
            retainedText += textBytes(retained.segments)
          } catch {
            this.documents.set(relativePath, { relativePath, name: file.name, kind: file.kind, size: file.size, modifiedAt: file.modifiedAt, segments: [] })
          }
        }
        for (const relativePath of [...this.documents.keys()]) {
          if (!nextPaths.has(relativePath)) {
            const removed = this.documents.get(relativePath)
            retainedText -= removed ? textBytes(removed.segments) : 0
            this.documents.delete(relativePath)
            changedFiles += 1
          }
        }
        const shouldPersist = force || forcedAtStart || changedFiles > 0 || this.currentStatus.indexedAt === 0
        const stored: StoredIndex = {
          version: INDEX_VERSION,
          indexedAt: shouldPersist ? Date.now() : this.currentStatus.indexedAt,
          documents: [...this.documents.values()]
        }
        let storedBytes = this.currentStatus.storedBytes
        if (shouldPersist) {
          await this.project.writeMetadata('knowledge-index', stored)
          storedBytes = Buffer.byteLength(JSON.stringify(stored))
        }
        this.validatedForSession = true
        this.currentStatus = {
          state: 'ready',
          fileCount: stored.documents.length,
          segmentCount: stored.documents.reduce((total, document) => total + document.segments.length, 0),
          indexedAt: stored.indexedAt,
          durationMs: Math.round(performance.now() - started),
          changedFiles,
          storedBytes
        }
        onProgress?.(files.length, files.length)
        return this.status()
      } catch (error) {
        for (const dirtyPath of dirtyAtStart) this.dirtyPaths.add(dirtyPath)
        if (force || forcedAtStart) this.forceDirty = true
        this.validatedForSession = false
        this.currentStatus = { ...this.currentStatus, state: 'error', durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : '索引失败。' }
        throw error
      } finally {
        this.indexing = null
      }
    })()
    return this.indexing
  }

  async rebuild(): Promise<KnowledgeIndexStatus> {
    await this.load()
    this.documents.clear()
    return this.ensureFresh(true)
  }

  async search(rawQuery: string, limit = MAX_RESULTS, semanticTokens = false): Promise<SearchResult[]> {
    await this.ensureFresh()
    const query = rawQuery.trim().slice(0, 1_000)
    if (!query) return []
    const needle = query.toLocaleLowerCase()
    const tokens = semanticTokens ? retrievalTokens(query) : [needle]
    const results: SearchResult[] = []
    for (const document of this.documents.values()) {
      const filePath = absolutePath(this.root, document.relativePath)
      const lowerName = document.name.toLocaleLowerCase()
      if (lowerName.includes(needle)) {
        results.push({
          id: `file:${filePath}`,
          type: 'file',
          path: filePath,
          title: document.name,
          excerpt: document.relativePath,
          kind: document.kind,
          score: 120 + countOccurrences(lowerName, needle) * 5
        })
      }
      for (const [segmentIndex, segment] of document.segments.entries()) {
        const match = retrievalScore(`${document.name}\n${segment.text}`, tokens)
        if (match.score === 0) continue
        const contentIndex = Math.max(0, match.index - document.name.length - 1)
        results.push({
          id: `index:${filePath}:${segment.page ?? segment.line ?? segmentIndex}`,
          type: 'content',
          path: filePath,
          title: document.name,
          excerpt: excerpt(segment.text, contentIndex, Math.max(query.length, match.tokenLength)),
          kind: document.kind,
          ...(segment.page ? { page: segment.page } : {}),
          ...(segment.line ? { line: segment.line + segment.text.slice(0, contentIndex).split('\n').length - 1 } : {}),
          ...(segment.heading ? { heading: segment.heading } : {}),
          score: (semanticTokens ? 70 : 80) + match.score
        })
      }
    }
    return results
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh-CN'))
      .slice(0, Math.max(1, Math.min(MAX_RESULTS, limit)))
  }

  async backlinks(): Promise<BacklinkGraph> {
    await this.ensureFresh()
    const notes = [...this.documents.values()].filter((document) => document.kind === 'markdown')
    const edges: BacklinkEdge[] = []
    const explicitPairs = new Set<string>()
    const noteText = new Map(notes.map((note) => [note.relativePath, note.segments.map((segment) => segment.text).join('\n')]))

    for (const source of notes) {
      const content = noteText.get(source.relativePath) ?? ''
      const matches = [
        ...[...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)].map((match) => ({ raw: match[1] ?? '', index: match.index })),
        ...[...content.matchAll(/\[[^\]]*\]\(([^)]+\.(?:md|markdown)(?:[?#][^)]*)?)\)/giu)].map((match) => ({ raw: match[1] ?? '', index: match.index }))
      ]
      for (const match of matches) {
        const target = resolveMarkdownTarget(source, match.raw, notes)
        if (!target || target.relativePath === source.relativePath) continue
        const pair = `${source.relativePath}\u0000${target.relativePath}`
        if (explicitPairs.has(pair)) continue
        explicitPairs.add(pair)
        edges.push({
          sourcePath: absolutePath(this.root, source.relativePath),
          targetPath: absolutePath(this.root, target.relativePath),
          kind: 'link',
          line: markdownLine(content, match.index),
          excerpt: excerpt(content, match.index, match.raw.length)
        })
      }
    }

    const mentionBuckets = new Map<string, Array<{ note: IndexedDocument; title: string; lowerTitle: string }>>()
    for (const note of notes) {
      const title = markdownTitle(note)
      const lowerTitle = title.toLocaleLowerCase()
      if (lowerTitle.length < 2) continue
      const key = lowerTitle.slice(0, 2)
      const bucket = mentionBuckets.get(key) ?? []
      bucket.push({ note, title, lowerTitle })
      mentionBuckets.set(key, bucket)
    }

    for (const source of notes) {
      const content = noteText.get(source.relativePath) ?? ''
      const lower = content.toLocaleLowerCase()
      const matchedTargets = new Set<string>()
      for (let index = 0; index < lower.length - 1; index += 1) {
        const candidates = mentionBuckets.get(lower.slice(index, index + 2))
        if (!candidates) continue
        for (const candidate of candidates) {
          const target = candidate.note
          if (target.relativePath === source.relativePath || matchedTargets.has(target.relativePath)) continue
          const pair = `${source.relativePath}\u0000${target.relativePath}`
          if (explicitPairs.has(pair) || !lower.startsWith(candidate.lowerTitle, index)) continue
          matchedTargets.add(target.relativePath)
          edges.push({
            sourcePath: absolutePath(this.root, source.relativePath),
            targetPath: absolutePath(this.root, target.relativePath),
            kind: 'unlinked-mention',
            line: markdownLine(content, index),
            excerpt: excerpt(content, index, candidate.title.length)
          })
        }
      }
    }

    const nodes: BacklinkNode[] = notes.map((note) => {
      const notePath = absolutePath(this.root, note.relativePath)
      return {
        path: notePath,
        title: markdownTitle(note),
        inbound: edges.filter((edge) => edge.kind === 'link' && edge.targetPath === notePath).length,
        outbound: edges.filter((edge) => edge.kind === 'link' && edge.sourcePath === notePath).length,
        unlinkedMentions: edges.filter((edge) => edge.kind === 'unlinked-mention' && edge.targetPath === notePath).length
      }
    }).sort((left, right) => right.inbound - left.inbound || left.title.localeCompare(right.title, 'zh-CN'))
    return { generatedAt: Date.now(), nodes, edges }
  }
}
