import type { ResearchReference, ResearchReferenceType } from '../../src/shared/types'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

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
        throw new Error('Crossref 返回的数据超过 2 MB 上限。')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function text(value: unknown, maximum = 20_000): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
}

function crossrefType(value: unknown): ResearchReferenceType {
  if (value === 'book' || value === 'monograph' || value === 'reference-book') return 'book'
  if (value === 'book-chapter' || value === 'reference-entry') return 'chapter'
  if (value === 'proceedings-article' || value === 'proceedings') return 'conference'
  if (value === 'dissertation') return 'thesis'
  if (value === 'report' || value === 'report-series') return 'report'
  if (value === 'posted-content' || value === 'dataset') return 'web'
  return value === 'journal-article' ? 'article' : 'other'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function crossrefReference(value: unknown): Partial<ResearchReference> {
  const message = record(value)
  if (!message) throw new Error('Crossref 返回的文献元数据格式无效。')
  const title = Array.isArray(message.title) ? text(message.title[0], 4_000) : text(message.title, 4_000)
  if (!title) throw new Error('Crossref 记录缺少标题。')
  const authors = Array.isArray(message.author) ? message.author.flatMap((candidate): string[] => {
    const author = record(candidate)
    if (!author) return []
    const name = [text(author.given, 500), text(author.family, 500)].filter(Boolean).join(' ')
    return name ? [name] : []
  }) : []
  const dateParts = record(message.published)?.['date-parts'] ?? record(message['published-print'])?.['date-parts'] ?? record(message['published-online'])?.['date-parts']
  const rawYear = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0][0] : undefined
  const year = typeof rawYear === 'number' && Number.isInteger(rawYear) && rawYear >= 1000 && rawYear <= 3000 ? rawYear : undefined
  const doi = text(message.DOI, 500).replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
  const url = text(message.URL, 8_000)
  const journal = Array.isArray(message['container-title']) ? text(message['container-title'][0], 2_000) : ''
  return {
    type: crossrefType(message.type),
    title,
    authors,
    ...(year ? { year } : {}),
    ...(journal ? { journal } : {}),
    ...(text(message.publisher, 2_000) ? { publisher: text(message.publisher, 2_000) } : {}),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : doi ? { url: `https://doi.org/${doi}` } : {}),
    ...(text(message.abstract) ? { abstract: text(message.abstract) } : {}),
    tags: []
  }
}

export class ReferenceMetadataService {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async lookupDoi(rawDoi: string): Promise<Partial<ResearchReference>> {
    const doi = typeof rawDoi === 'string'
      ? rawDoi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi:\s*/iu, '')
      : ''
    if (!/^10\.\d{4,9}\/\S{1,450}$/iu.test(doi) || /[\s\u0000-\u001f]/u.test(doi)) throw new Error('请输入有效 DOI。')
    const response = await this.fetcher(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CoScribe/2.2.1 (https://github.com/UESTC-ly/CoScribe)'
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow'
    })
    if (!response.ok) {
      if (response.status === 404) throw new Error('Crossref 没有找到这个 DOI。')
      if (response.status === 429) throw new Error('Crossref 请求过于频繁，请稍后重试。')
      throw new Error(`Crossref 查询失败（HTTP ${response.status}）。`)
    }
    const bytes = await boundedResponse(response)
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) }
    catch { throw new Error('Crossref 返回的内容不是有效 JSON。') }
    const envelope = record(value)
    return crossrefReference(envelope?.message)
  }
}
