import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ResearchCandidate, ResearchSource } from '../../../src/shared/research'
import { normalizeReference } from '../../../src/plugins/references/reference-utils'
import { crossrefReference } from '../references'
import type { McpService } from '../mcp'

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function clean(value: unknown, maximum = 4_000): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
}
export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }
export async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('下载内容超过大小上限。')
  }
  if (!response.body) throw new Error('来源返回空内容。')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new Error('下载内容超过大小上限。') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}
const HOSTS = new Set(['api.crossref.org', 'export.arxiv.org', 'arxiv.org', 'www.arxiv.org', 'api.github.com'])
export function sourceUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || (url.port && url.port !== '443') || url.username || url.password) throw new Error('研究来源地址不在允许的 HTTPS 来源中。')
  return url
}
function candidate(source: ResearchSource, sourceId: string, value: Parameters<typeof normalizeReference>[0]): ResearchCandidate {
  const id = `${source}-${hash(sourceId.toLowerCase())}`
  const reference = normalizeReference({ ...value, id: `reference-${id}` })
  reference.citeKey = `${reference.citeKey.slice(0, 100)}-${hash(sourceId).slice(0, 8)}`
  return { id, source, sourceId, reference }
}
function xmlText(value: string): string {
  return value.replace(/<[^>]*>/gu, ' ').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    if (named[entity]) return named[entity]
    const point = Number.parseInt(entity.startsWith('&#x') ? entity.slice(3, -1) : entity.slice(2, -1), entity.startsWith('&#x') ? 16 : 10)
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ''
  }).replace(/\s+/gu, ' ').trim()
}
export function arxivCandidates(xml: string, limit: number): ResearchCandidate[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || !/<(?:\w+:)?feed\b/u.test(xml)) throw new Error('arXiv 返回格式无效。')
  const entries = [...xml.matchAll(/<(?:\w+:)?entry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?entry>/gu)]
  const tag = (entry: string, name: string): string => xmlText(entry.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'u'))?.[1] ?? '')
  return entries.slice(0, limit).flatMap((match) => {
    const entry = match[1]
    const id = tag(entry, 'id').match(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)$/iu)?.[1]
    const title = tag(entry, 'title')
    if (!id || !title) return []
    const authors = [...entry.matchAll(/<(?:\w+:)?author\b[^>]*>([\s\S]*?)<\/(?:\w+:)?author>/gu)].map((author) => tag(author[1], 'name'))
    const result = candidate('arxiv', id, { title, authors, type: 'article', year: Number(tag(entry, 'published').slice(0, 4)), abstract: tag(entry, 'summary'), doi: tag(entry, 'doi'), url: `https://arxiv.org/abs/${id}`, journal: tag(entry, 'journal_ref'), tags: ['arXiv'] })
    result.pdfUrl = `https://arxiv.org/pdf/${id}`
    return [result]
  })
}
export function githubCandidates(value: unknown, limit: number): ResearchCandidate[] {
  const items = record(value).items
  if (!Array.isArray(items)) throw new Error('GitHub 检索结果缺少 items。')
  return items.slice(0, limit).flatMap((item) => {
    const repo = record(item)
    const name = clean(repo.full_name, 200)
    if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(name) || name.split('/').some((segment) => segment === '.' || segment === '..')) return []
    if (repo.html_url !== `https://github.com/${name}`) return []
    const result = candidate('github', name, { title: name, type: 'web', authors: [name.split('/')[0]], url: `https://github.com/${name}`, abstract: clean(repo.description, 20_000), tags: ['GitHub', clean(repo.language, 100)].filter(Boolean) })
    result.repository = name
    return [result]
  })
}
export class ResearchProviders {
  private nextArxiv = 0
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly mcp?: Pick<McpService, 'invoke'>) {}
  async fetch(url: string, signal: AbortSignal, maximum = 2 * 1024 * 1024): Promise<Buffer> {
    let current = sourceUrl(url)
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      signal.throwIfAborted()
      const response = await this.fetcher(current, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/json, application/atom+xml, application/pdf', 'User-Agent': 'CoScribe AutoResearch (https://github.com/UESTC-ly/CoScribe)', ...(current.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new Error('来源重定向缺少地址。')
        const next = sourceUrl(new URL(location, current).href)
        if (next.hostname !== current.hostname && !([current.hostname, next.hostname].every((host) => ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(host)))) throw new Error('来源重定向跨越了允许的服务边界。')
        current = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`来源请求失败（HTTP ${response.status}${response.status === 429 || response.status === 403 ? '；可能达到公开接口限额，请稍后重试' : ''}）。`)
      }
      return responseBytes(response, maximum)
    }
    throw new Error('来源重定向次数过多。')
  }
  async search(source: ResearchSource, query: string, limit: number, signal: AbortSignal, mcpServerId?: string): Promise<ResearchCandidate[]> {
    if (source === 'arxiv') {
      const wait = Math.max(0, this.nextArxiv - Date.now())
      this.nextArxiv = Math.max(Date.now(), this.nextArxiv) + 3_000
      if (wait) await delay(wait, undefined, { signal })
      const terms = query.replace(/["\\]/gu, '').split(/\s+/u).filter(Boolean).slice(0, 12).map((word) => `all:"${word}"`).join(' AND ')
      const url = new URL('https://export.arxiv.org/api/query')
      url.search = new URLSearchParams({ search_query: terms, start: '0', max_results: String(limit), sortBy: 'relevance' }).toString()
      return arxivCandidates((await this.fetch(url.href, signal)).toString('utf8'), limit)
    }
    if (source === 'github') {
      if (mcpServerId) {
        if (!this.mcp) throw new Error('MCP 服务不可用。')
        const result = await this.mcp.invoke({ serverId: mcpServerId, kind: 'tool', name: 'search_repositories', arguments: { query, perPage: limit, minimal_output: false } }, { readOnly: true, signal })
        signal.throwIfAborted()
        if (result.isError) throw new Error('GitHub MCP 检索失败。')
        return githubCandidates(result.structuredContent ?? JSON.parse(result.content), limit)
      }
      const url = new URL('https://api.github.com/search/repositories')
      url.search = new URLSearchParams({ q: query, per_page: String(limit) }).toString()
      return githubCandidates(JSON.parse((await this.fetch(url.href, signal)).toString('utf8')), limit)
    }
    const url = new URL('https://api.crossref.org/works')
    url.search = new URLSearchParams({ query, rows: String(limit) }).toString()
    const items = record(record(JSON.parse((await this.fetch(url.href, signal)).toString('utf8'))).message).items
    if (!Array.isArray(items)) throw new Error('Crossref 检索结果格式无效。')
    return items.slice(0, limit).flatMap((item) => {
      try {
        const metadata = crossrefReference(item)
        if (!metadata.doi) return []
        return [candidate('crossref', metadata.doi, metadata)]
      } catch { return [] }
    })
  }
  async readme(repository: string, signal: AbortSignal): Promise<{ content: string; sha: string }> {
    if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(repository) || repository.split('/').some((part) => part === '.' || part === '..')) throw new Error('仓库名称无效。')
    const result = record(JSON.parse((await this.fetch(`https://api.github.com/repos/${repository}/readme`, signal)).toString('utf8')))
    if (result.encoding !== 'base64' || typeof result.content !== 'string' || !/^[\da-f]{40,64}$/iu.test(String(result.sha))) throw new Error('GitHub 没有返回可验证的 README 内容。')
    const content = Buffer.from(result.content.replace(/\s/gu, ''), 'base64').toString('utf8')
    if (Buffer.byteLength(content) > 512 * 1024) throw new Error('README 超过 512 KB 上限。')
    return { content, sha: String(result.sha) }
  }
}
