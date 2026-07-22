import type { ResearchReference, ResearchReferenceType } from '../../shared/types'

const MAX_REFERENCE_TEXT = 20_000

interface ReferenceDraft {
  citeKey?: string
  type?: ResearchReferenceType
  title?: string
  authors?: string[]
  year?: number
  journal?: string
  publisher?: string
  doi?: string
  url?: string
  pdfPath?: string
  abstract?: string
  tags?: string[]
  notes?: string
}

function clean(value: unknown, maximum = MAX_REFERENCE_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
}

function cleanDoi(value: unknown): string {
  return clean(value, 500).replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi:\s*/iu, '')
}

function cleanUrl(value: unknown): string {
  const candidate = clean(value, 8_000)
  if (!candidate) return ''
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function titleWord(value: string): string {
  return value.normalize('NFKD').replace(/[^\p{Letter}\p{Number}\s-]/gu, ' ').split(/[\s-]+/u).find((word) => word.length > 2) ?? 'source'
}

function authorSurname(value: string): string {
  const author = value.split(',')[0]?.trim() || value.trim().split(/\s+/u).at(-1) || 'ref'
  return author.normalize('NFKD').replace(/[^\p{Letter}\p{Number}]/gu, '') || 'ref'
}

export function normalizeCiteKey(value: string, fallback: Pick<ReferenceDraft, 'authors' | 'year' | 'title'> = {}): string {
  const cleaned = clean(value, 160).normalize('NFKC').replace(/[^\p{Letter}\p{Number}_.:-]/gu, '')
  if (cleaned) return cleaned
  const author = authorSurname(fallback.authors?.[0] ?? 'ref')
  const year = fallback.year ? String(fallback.year) : 'nd'
  return `${author}${year}${titleWord(fallback.title ?? 'source')}`.slice(0, 160)
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((author): string[] => {
    const candidate = clean(author, 500)
    if (!candidate) return []
    const [family, given] = candidate.split(',').map((part) => part.trim())
    return [given ? `${given} ${family}` : candidate]
  }).slice(0, 100)
}

export function normalizeReference(value: Partial<ResearchReference> & ReferenceDraft, now = Date.now()): ResearchReference {
  const authors = normalizeAuthors(value.authors)
  const title = clean(value.title, 4_000) || '未命名文献'
  const year = typeof value.year === 'number' && Number.isInteger(value.year) && value.year >= 1000 && value.year <= 3000
    ? value.year
    : undefined
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : now
  const type: ResearchReferenceType = ['article', 'book', 'chapter', 'conference', 'thesis', 'report', 'web', 'other'].includes(value.type ?? '')
    ? value.type as ResearchReferenceType
    : 'article'
  const id = clean(value.id, 200) || `reference-${crypto.randomUUID()}`
  const doi = cleanDoi(value.doi)
  const url = cleanUrl(value.url) || (doi ? `https://doi.org/${doi}` : '')
  return {
    id,
    citeKey: normalizeCiteKey(value.citeKey ?? '', { authors, year, title }),
    type,
    title,
    authors,
    ...(year ? { year } : {}),
    ...(clean(value.journal, 2_000) ? { journal: clean(value.journal, 2_000) } : {}),
    ...(clean(value.publisher, 2_000) ? { publisher: clean(value.publisher, 2_000) } : {}),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(clean(value.pdfPath, 8_000) ? { pdfPath: clean(value.pdfPath, 8_000) } : {}),
    ...(clean(value.abstract) ? { abstract: clean(value.abstract) } : {}),
    tags: [...new Set((Array.isArray(value.tags) ? value.tags : []).map((tag) => clean(tag, 100)).filter(Boolean))].slice(0, 100),
    ...(clean(value.notes) ? { notes: clean(value.notes) } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now
  }
}

function bibType(value: string): ResearchReferenceType {
  if (/^(?:book|manual)$/iu.test(value)) return 'book'
  if (/^(?:inbook|incollection)$/iu.test(value)) return 'chapter'
  if (/^(?:inproceedings|conference)$/iu.test(value)) return 'conference'
  if (/^(?:phdthesis|mastersthesis)$/iu.test(value)) return 'thesis'
  if (/^(?:techreport|report)$/iu.test(value)) return 'report'
  if (/^(?:online|webpage|misc)$/iu.test(value)) return 'web'
  return value.toLocaleLowerCase() === 'article' ? 'article' : 'other'
}

function unbrace(value: string): string {
  let result = value.trim()
  while ((result.startsWith('{') && result.endsWith('}')) || (result.startsWith('"') && result.endsWith('"'))) {
    result = result.slice(1, -1).trim()
  }
  return result.replace(/[{}]/gu, '').replace(/\\&/gu, '&').replace(/\\_/gu, '_').trim()
}

function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let cursor = 0
  while (cursor < body.length) {
    while (cursor < body.length && /[\s,]/u.test(body[cursor] ?? '')) cursor += 1
    const nameStart = cursor
    while (cursor < body.length && /[A-Za-z0-9_-]/u.test(body[cursor] ?? '')) cursor += 1
    const name = body.slice(nameStart, cursor).toLocaleLowerCase()
    while (cursor < body.length && /\s/u.test(body[cursor] ?? '')) cursor += 1
    if (!name || body[cursor] !== '=') {
      cursor += 1
      continue
    }
    cursor += 1
    while (cursor < body.length && /\s/u.test(body[cursor] ?? '')) cursor += 1
    const opener = body[cursor]
    let value = ''
    if (opener === '{') {
      cursor += 1
      let depth = 1
      const start = cursor
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === '{') depth += 1
        else if (body[cursor] === '}') depth -= 1
        cursor += 1
      }
      value = body.slice(start, Math.max(start, cursor - 1))
    } else if (opener === '"') {
      cursor += 1
      const start = cursor
      while (cursor < body.length && (body[cursor] !== '"' || body[cursor - 1] === '\\')) cursor += 1
      value = body.slice(start, cursor)
      cursor += 1
    } else {
      const start = cursor
      while (cursor < body.length && body[cursor] !== ',') cursor += 1
      value = body.slice(start, cursor)
    }
    fields[name] = unbrace(value)
  }
  return fields
}

export function parseBibTeX(input: string, now = Date.now()): ResearchReference[] {
  const source = input.slice(0, 2 * 1024 * 1024)
  const references: ResearchReference[] = []
  const entry = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/gu
  let match: RegExpExecArray | null
  while ((match = entry.exec(source))) {
    let cursor = entry.lastIndex
    let depth = 1
    let quoted = false
    while (cursor < source.length && depth > 0) {
      const character = source[cursor]
      if (character === '"' && source[cursor - 1] !== '\\') quoted = !quoted
      if (!quoted && character === '{') depth += 1
      if (!quoted && character === '}') depth -= 1
      cursor += 1
    }
    const fields = parseBibFields(source.slice(entry.lastIndex, Math.max(entry.lastIndex, cursor - 1)))
    const authors = (fields.author ?? '').split(/\s+and\s+/iu).map((author) => author.trim()).filter(Boolean)
    const year = Number.parseInt(fields.year ?? '', 10)
    references.push(normalizeReference({
      citeKey: match[2],
      type: bibType(match[1] ?? ''),
      title: fields.title,
      authors,
      ...(Number.isInteger(year) ? { year } : {}),
      journal: fields.journal || fields.booktitle,
      publisher: fields.publisher,
      doi: fields.doi,
      url: fields.url,
      abstract: fields.abstract,
      tags: (fields.keywords ?? '').split(/[;,]/u).map((tag) => tag.trim()).filter(Boolean)
    }, now))
    entry.lastIndex = cursor
  }
  return references
}

function risType(value: string): ResearchReferenceType {
  if (/^(?:BOOK|EBOOK)$/u.test(value)) return 'book'
  if (/^(?:CHAP|ECHAP)$/u.test(value)) return 'chapter'
  if (/^(?:CONF|CPAPER)$/u.test(value)) return 'conference'
  if (/^(?:THES)$/u.test(value)) return 'thesis'
  if (/^(?:RPRT)$/u.test(value)) return 'report'
  if (/^(?:ELEC|WEB)$/u.test(value)) return 'web'
  return /^(?:JOUR|EJOUR)$/u.test(value) ? 'article' : 'other'
}

export function parseRis(input: string, now = Date.now()): ResearchReference[] {
  const records = input.replace(/\r\n?/gu, '\n').slice(0, 2 * 1024 * 1024).split(/^ER\s+-.*$/gmu)
  return records.flatMap((record): ResearchReference[] => {
    const fields = new Map<string, string[]>()
    for (const line of record.split('\n')) {
      const match = line.match(/^([A-Z0-9]{2})\s+-\s?(.*)$/u)
      if (!match) continue
      fields.set(match[1], [...(fields.get(match[1]) ?? []), match[2].trim()])
    }
    const title = fields.get('TI')?.[0] || fields.get('T1')?.[0]
    if (!title) return []
    const year = Number.parseInt(fields.get('PY')?.[0] || fields.get('Y1')?.[0] || '', 10)
    return [normalizeReference({
      type: risType(fields.get('TY')?.[0] ?? ''),
      title,
      authors: [...(fields.get('AU') ?? []), ...(fields.get('A1') ?? [])],
      ...(Number.isInteger(year) ? { year } : {}),
      journal: fields.get('JO')?.[0] || fields.get('JF')?.[0] || fields.get('T2')?.[0],
      publisher: fields.get('PB')?.[0],
      doi: fields.get('DO')?.[0],
      url: fields.get('UR')?.[0],
      abstract: fields.get('AB')?.[0],
      tags: fields.get('KW') ?? []
    }, now)]
  })
}

export function mergeReferences(current: ResearchReference[], incoming: ResearchReference[]): ResearchReference[] {
  const result = current.map((reference) => normalizeReference(reference))
  for (const reference of incoming) {
    const normalized = normalizeReference(reference)
    const match = result.findIndex((candidate) =>
      Boolean(normalized.doi && candidate.doi?.toLocaleLowerCase() === normalized.doi.toLocaleLowerCase()) ||
      candidate.citeKey.toLocaleLowerCase() === normalized.citeKey.toLocaleLowerCase()
    )
    if (match >= 0) result[match] = normalizeReference({ ...result[match], ...normalized, id: result[match].id, createdAt: result[match].createdAt })
    else result.push(normalized)
  }
  return result.slice(0, 5_000)
}

export function citationToken(reference: Pick<ResearchReference, 'citeKey'>): string {
  return `[@${normalizeCiteKey(reference.citeKey)}]`
}

export function formattedReference(reference: ResearchReference): string {
  const authors = reference.authors.length ? reference.authors.join(', ') : '未知作者'
  const year = reference.year ?? 'n.d.'
  const container = reference.journal || reference.publisher
  const location = reference.doi ? `https://doi.org/${reference.doi}` : reference.url
  return `${authors} (${year}). ${reference.title}.${container ? ` ${container}.` : ''}${location ? ` ${location}` : ''}`
}

function yaml(value: string): string {
  return JSON.stringify(value.replace(/\r\n?/gu, '\n'))
}

export function referenceNotePath(reference: ResearchReference): string {
  return `研究/文献笔记/${normalizeCiteKey(reference.citeKey)}.md`
}

export function referenceNoteMarkdown(reference: ResearchReference): string {
  return [
    '---',
    `citekey: ${yaml(reference.citeKey)}`,
    `title: ${yaml(reference.title)}`,
    `authors: [${reference.authors.map(yaml).join(', ')}]`,
    ...(reference.year ? [`year: ${reference.year}`] : []),
    ...(reference.doi ? [`doi: ${yaml(reference.doi)}`] : []),
    ...(reference.url ? [`url: ${yaml(reference.url)}`] : []),
    `tags: [${reference.tags.map(yaml).join(', ')}]`,
    '---',
    '',
    `# ${reference.title}`,
    '',
    `> 引用：${formattedReference(reference)}`,
    `> 文内引用：${citationToken(reference)}`,
    ...(reference.pdfPath ? [`> 本地 PDF：[打开文献](${reference.pdfPath})`] : []),
    '',
    '## 核心问题',
    '',
    '',
    '## 方法与数据',
    '',
    '',
    '## 主要发现',
    '',
    '',
    '## 局限与可迁移结论',
    '',
    '',
    '## 我的批注',
    '',
    reference.notes ?? '',
    ''
  ].join('\n')
}

export function bibTeXFor(reference: ResearchReference): string {
  const type = reference.type === 'conference' ? 'inproceedings' : reference.type === 'web' ? 'misc' : reference.type === 'other' ? 'misc' : reference.type
  const fields = [
    `  title = {${reference.title}}`,
    ...(reference.authors.length ? [`  author = {${reference.authors.join(' and ')}}`] : []),
    ...(reference.year ? [`  year = {${reference.year}}`] : []),
    ...(reference.journal ? [`  journal = {${reference.journal}}`] : []),
    ...(reference.publisher ? [`  publisher = {${reference.publisher}}`] : []),
    ...(reference.doi ? [`  doi = {${reference.doi}}`] : []),
    ...(reference.url ? [`  url = {${reference.url}}`] : [])
  ]
  return `@${type}{${normalizeCiteKey(reference.citeKey)},\n${fields.join(',\n')}\n}`
}
