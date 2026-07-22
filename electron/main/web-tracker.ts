import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  WebTrackedSource,
  WebTrackedSourceInput,
  WebTrackingCheckResult,
  WebTrackingIntervalMinutes
} from '../../src/shared/types'
import type { ProjectService, ProjectWriteScope } from './project'

const PLUGIN_ID = 'web-tracker'
const MAX_SOURCES = 100
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000
const VALID_INTERVALS = new Set<WebTrackingIntervalMinutes>([0, 60, 360, 1440])

type StoredSources = { version: 1; sources: WebTrackedSource[] }
type CapturedPage = { title: string; text: string; etag?: string; lastModified?: string; notModified: boolean }

async function boundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('网页内容超过 2 MB 上限。')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
}

function validUrl(value: unknown): string {
  const raw = cleanText(value, 8_000)
  let parsed: URL
  try { parsed = new URL(raw) }
  catch { throw new Error('请输入有效的网页地址。') }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('网页跟踪仅支持不含内嵌账号密码的 HTTP(S) 地址。')
  }
  parsed.hash = ''
  return parsed.toString()
}

function interval(value: unknown, fallback: WebTrackingIntervalMinutes = 1440): WebTrackingIntervalMinutes {
  return typeof value === 'number' && VALID_INTERVALS.has(value as WebTrackingIntervalMinutes)
    ? value as WebTrackingIntervalMinutes
    : fallback
}

function status(value: unknown): WebTrackedSource['status'] {
  return value === 'unchanged' || value === 'changed' || value === 'error' ? value : 'idle'
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizedSource(value: unknown): WebTrackedSource | null {
  if (!isRecord(value)) return null
  let url: string
  try { url = validUrl(value.url) }
  catch { return null }
  const id = cleanText(value.id, 200)
  if (!/^[A-Za-z0-9-]{1,200}$/u.test(id)) return null
  const createdAt = timestamp(value.createdAt) ?? Date.now()
  const title = cleanText(value.title, 500) || new URL(url).hostname
  return {
    id,
    url,
    title,
    intervalMinutes: interval(value.intervalMinutes),
    createdAt,
    updatedAt: timestamp(value.updatedAt) ?? createdAt,
    ...(timestamp(value.lastCheckedAt) ? { lastCheckedAt: timestamp(value.lastCheckedAt) } : {}),
    ...(timestamp(value.lastChangedAt) ? { lastChangedAt: timestamp(value.lastChangedAt) } : {}),
    ...(cleanText(value.lastHash, 128) ? { lastHash: cleanText(value.lastHash, 128) } : {}),
    ...(cleanText(value.etag, 2_000) ? { etag: cleanText(value.etag, 2_000) } : {}),
    ...(cleanText(value.lastModified, 2_000) ? { lastModified: cleanText(value.lastModified, 2_000) } : {}),
    changeCount: typeof value.changeCount === 'number' && Number.isInteger(value.changeCount) && value.changeCount >= 0 ? value.changeCount : 0,
    status: status(value.status),
    ...(cleanText(value.error, 4_000) ? { error: cleanText(value.error, 4_000) } : {}),
    ...(cleanText(value.latestSnapshotPath, 8_000) ? { latestSnapshotPath: cleanText(value.latestSnapshotPath, 8_000) } : {})
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (_match, decimal: string, hex: string, name: string) => {
    if (decimal) return String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(decimal, 10)))
    if (hex) return String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(hex, 16)))
    return named[name.toLocaleLowerCase()] ?? `&${name};`
  })
}

export function extractTrackedPage(html: string, contentType = 'text/html'): { title: string; text: string } {
  if (!/html|xhtml/iu.test(contentType)) return { title: '', text: html.replace(/\r\n?/gu, '\n').trim() }
  const titleMatch = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu)
  const title = decodeEntities((titleMatch?.[1] ?? '').replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim().slice(0, 500)
  const text = decodeEntities(html
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/<(?:script|style|noscript|svg|canvas|template)(?:\s[^>]*)?>[\s\S]*?<\/(?:script|style|noscript|svg|canvas|template)>/giu, ' ')
    .replace(/<\s*br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|div|section|article|main|header|footer|nav|aside|h[1-6]|li|tr|blockquote)>/giu, '\n')
    .replace(/<li(?:\s[^>]*)?>/giu, '- ')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return { title, text }
}

function safeSegment(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 80) || '网页资料'
}

function snapshotMarkdown(source: WebTrackedSource, page: CapturedPage, checkedAt: number, hash: string): string {
  return [
    '---',
    `title: ${JSON.stringify(page.title || source.title)}`,
    `source: ${JSON.stringify(source.url)}`,
    `checked_at: ${JSON.stringify(new Date(checkedAt).toISOString())}`,
    `content_hash: ${JSON.stringify(hash)}`,
    '---',
    '',
    `# ${page.title || source.title}`,
    '',
    `> 来源：[${source.url}](${source.url})`,
    `> 检查时间：${new Date(checkedAt).toLocaleString('zh-CN')}`,
    '',
    page.text,
    ''
  ].join('\n')
}

export class WebTrackerService {
  private timer: NodeJS.Timeout | null = null
  private checking = false

  constructor(
    private readonly project: ProjectService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly backgroundAllowed: () => Promise<boolean> = async () => true
  ) {}

  private sameScope(scope: ProjectWriteScope): boolean {
    try {
      const current = this.project.captureWriteScope()
      return current.root === scope.root && current.revision === scope.revision
    } catch {
      return false
    }
  }

  private async sources(): Promise<WebTrackedSource[]> {
    const data = await this.project.pluginData(PLUGIN_ID)
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources)) return []
    return data.sources.flatMap((source): WebTrackedSource[] => {
      const normalized = normalizedSource(source)
      return normalized ? [normalized] : []
    }).slice(0, MAX_SOURCES)
  }

  private async save(sources: WebTrackedSource[], scope?: ProjectWriteScope): Promise<void> {
    if (scope && !this.sameScope(scope)) throw new Error('项目已切换，网页跟踪结果未写入。')
    const stored: StoredSources = { version: 1, sources: sources.slice(0, MAX_SOURCES) }
    await this.project.savePluginData(PLUGIN_ID, stored)
  }

  async list(): Promise<WebTrackedSource[]> {
    return this.sources()
  }

  async add(input: WebTrackedSourceInput): Promise<WebTrackedSource> {
    const url = validUrl(input?.url)
    const current = await this.sources()
    if (current.some((source) => source.url === url)) throw new Error('这个网页已经在跟踪列表中。')
    if (current.length >= MAX_SOURCES) throw new Error(`最多跟踪 ${MAX_SOURCES} 个网页。`)
    const now = Date.now()
    const source: WebTrackedSource = {
      id: randomUUID(),
      url,
      title: cleanText(input?.title, 500) || new URL(url).hostname,
      intervalMinutes: interval(input?.intervalMinutes),
      createdAt: now,
      updatedAt: now,
      changeCount: 0,
      status: 'idle'
    }
    await this.save([source, ...current])
    return source
  }

  async update(sourceId: string, input: WebTrackedSourceInput): Promise<WebTrackedSource> {
    const current = await this.sources()
    const existing = current.find((source) => source.id === sourceId)
    if (!existing) throw new Error('找不到这个网页跟踪项。')
    const url = validUrl(input?.url)
    if (current.some((source) => source.id !== sourceId && source.url === url)) throw new Error('这个网页已经在跟踪列表中。')
    const changedUrl = url !== existing.url
    const updated: WebTrackedSource = {
      ...existing,
      url,
      title: cleanText(input?.title, 500) || new URL(url).hostname,
      intervalMinutes: interval(input?.intervalMinutes, existing.intervalMinutes),
      updatedAt: Date.now(),
      ...(changedUrl ? {
        lastCheckedAt: undefined,
        lastChangedAt: undefined,
        lastHash: undefined,
        etag: undefined,
        lastModified: undefined,
        latestSnapshotPath: undefined,
        changeCount: 0,
        status: 'idle' as const,
        error: undefined
      } : {})
    }
    const normalized = normalizedSource(updated)
    if (!normalized) throw new Error('网页跟踪配置无效。')
    await this.save(current.map((source) => source.id === sourceId ? normalized : source))
    return normalized
  }

  async remove(sourceId: string): Promise<void> {
    const current = await this.sources()
    if (!current.some((source) => source.id === sourceId)) return
    await this.save(current.filter((source) => source.id !== sourceId))
  }

  private async fetchPage(source: WebTrackedSource): Promise<CapturedPage> {
    const headers: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      'User-Agent': 'CoScribe/2.2.0 WebTracker'
    }
    if (source.etag) headers['If-None-Match'] = source.etag
    if (source.lastModified) headers['If-Modified-Since'] = source.lastModified
    const response = await this.fetcher(source.url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow'
    })
    if (response.status === 304) return { title: source.title, text: '', notModified: true, etag: source.etag, lastModified: source.lastModified }
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}。`)
    const finalUrl = validUrl(response.url || source.url)
    if (!finalUrl) throw new Error('网页重定向地址无效。')
    const contentType = response.headers.get('content-type') ?? ''
    if (!/(?:text\/html|application\/xhtml\+xml|text\/plain)/iu.test(contentType)) throw new Error('网页跟踪只支持 HTML 或纯文本响应。')
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('网页内容超过 2 MB 上限。')
    const bytes = await boundedResponse(response)
    const captured = extractTrackedPage(bytes.toString('utf8'), contentType)
    if (!captured.text) throw new Error('没有从网页中提取到可跟踪的正文。')
    return {
      ...captured,
      notModified: false,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {})
    }
  }

  private async checkOne(source: WebTrackedSource, scope: ProjectWriteScope): Promise<WebTrackingCheckResult> {
    const checkedAt = Date.now()
    try {
      const page = await this.fetchPage(source)
      if (!this.sameScope(scope)) throw new Error('项目已切换，网页跟踪已取消。')
      if (page.notModified) {
        return { source: { ...source, lastCheckedAt: checkedAt, updatedAt: checkedAt, status: 'unchanged', error: undefined }, changed: false }
      }
      const hash = createHash('sha256').update(page.text).digest('hex')
      const changed = source.lastHash !== hash
      let snapshot
      if (changed) {
        const relative = path.join(
          '研究',
          '网页跟踪',
          safeSegment(page.title || source.title),
          `${new Date(checkedAt).toISOString().replace(/[:.]/gu, '-')}-${hash.slice(0, 8)}.md`
        )
        snapshot = await this.project.createMarkdown(relative, snapshotMarkdown(source, page, checkedAt, hash), scope)
      }
      const next: WebTrackedSource = {
        ...source,
        title: page.title || source.title,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
        lastHash: hash,
        ...(page.etag ? { etag: page.etag } : {}),
        ...(page.lastModified ? { lastModified: page.lastModified } : {}),
        ...(changed ? {
          lastChangedAt: checkedAt,
          changeCount: source.changeCount + 1,
          status: 'changed' as const,
          latestSnapshotPath: snapshot!.path
        } : { status: 'unchanged' as const }),
        error: undefined
      }
      return { source: next, changed, ...(snapshot ? { snapshot } : {}) }
    } catch (error) {
      if (!this.sameScope(scope)) throw error
      return {
        source: {
          ...source,
          lastCheckedAt: checkedAt,
          updatedAt: checkedAt,
          status: 'error',
          error: error instanceof Error ? error.message.slice(0, 4_000) : '网页检查失败。'
        },
        changed: false
      }
    }
  }

  async check(sourceId?: string): Promise<WebTrackingCheckResult[]> {
    if (this.checking) throw new Error('网页跟踪正在执行，请稍后再试。')
    this.checking = true
    const scope = this.project.captureWriteScope()
    try {
      let sources = await this.sources()
      const selected = sourceId ? sources.filter((source) => source.id === sourceId) : sources
      if (sourceId && !selected.length) throw new Error('找不到这个网页跟踪项。')
      const results: WebTrackingCheckResult[] = []
      for (const source of selected) {
        const result = await this.checkOne(source, scope)
        results.push(result)
        sources = sources.map((candidate) => candidate.id === source.id ? result.source : candidate)
        await this.save(sources, scope)
      }
      return results
    } finally {
      this.checking = false
    }
  }

  private async checkDue(): Promise<void> {
    if (this.checking) return
    try {
      if (!(await this.backgroundAllowed())) return
    } catch {
      return
    }
    let due: WebTrackedSource[]
    try {
      const now = Date.now()
      due = (await this.sources()).filter((source) => source.intervalMinutes > 0 && (!source.lastCheckedAt || now - source.lastCheckedAt >= source.intervalMinutes * 60_000))
    } catch {
      return
    }
    for (const source of due) {
      await this.check(source.id).catch(() => undefined)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.checkDue() }, SCHEDULER_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
