import { stat } from 'node:fs/promises'

import type { PdfPageText, PdfSearchMatch } from '../../src/shared/types'
import type { ProjectPathGuard } from './security'

interface PdfCacheEntry {
  signature: string
  pages: PdfPageText[]
  touchedAt: number
}

const MAX_CACHED_PDFS = 6

function normalizeExtractedText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let value = ''
  for (const item of items) {
    if (!item.str) continue
    value += item.str
    value += item.hasEOL ? '\n' : ' '
  }
  return value
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + length + 120)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`
}

export class PdfTextService {
  private readonly cache = new Map<string, PdfCacheEntry>()

  constructor(private readonly getGuard: () => ProjectPathGuard) {}

  private prune(): void {
    if (this.cache.size <= MAX_CACHED_PDFS) return
    const oldest = [...this.cache.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
    if (oldest) this.cache.delete(oldest[0])
  }

  private async extract(inputPath: string): Promise<{ path: string; pages: PdfPageText[] }> {
    const guard = this.getGuard()
    const canonical = await guard.existing(inputPath, 'file')
    if (!canonical.toLowerCase().endsWith('.pdf')) throw new Error('目标文件不是 PDF。')

    const info = await stat(canonical)
    const signature = `${info.size}:${info.mtimeMs}`
    const cached = this.cache.get(canonical)
    if (cached?.signature === signature) {
      cached.touchedAt = Date.now()
      return { path: canonical, pages: cached.pages }
    }

    const descriptor = await guard.openReadOnly(canonical)
    let data: Uint8Array
    try {
      data = new Uint8Array(await descriptor.readFile())
    } finally {
      await descriptor.close()
    }

    let loadingTask: { promise: Promise<any>; destroy: () => Promise<void> } | undefined
    let document: { numPages: number; getPage: (page: number) => Promise<any>; destroy: () => Promise<void> } | undefined
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      loadingTask = pdfjs.getDocument({ data, useSystemFonts: true })
      const pdfDocument = await loadingTask.promise
      document = pdfDocument
      const pages: PdfPageText[] = []
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber)
        try {
          const content = await page.getTextContent()
          const text = normalizeExtractedText(content.items as Array<{ str?: string; hasEOL?: boolean }>)
          pages.push({ page: pageNumber, text, readable: text.length > 0 })
        } finally {
          page.cleanup?.()
        }
      }
      this.cache.set(canonical, { signature, pages, touchedAt: Date.now() })
      this.prune()
      return { path: canonical, pages }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`PDF 无法解析或提取正文：${message}`)
    } finally {
      await document?.destroy().catch(() => undefined)
      await loadingTask?.destroy().catch(() => undefined)
    }
  }

  async pageText(inputPath: string, page: number): Promise<PdfPageText> {
    if (!Number.isInteger(page) || page < 1) throw new Error('PDF 页码必须是大于 0 的整数。')
    const { pages } = await this.extract(inputPath)
    const result = pages[page - 1]
    if (!result) throw new Error(`PDF 不包含第 ${page} 页。`)
    return result
  }

  async allPages(inputPath: string): Promise<PdfPageText[]> {
    return (await this.extract(inputPath)).pages
  }

  async search(inputPath: string, query: string): Promise<PdfSearchMatch[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const { pages } = await this.extract(inputPath)
    const matches: PdfSearchMatch[] = []
    for (const page of pages) {
      const haystack = page.text.toLocaleLowerCase()
      let cursor = 0
      let count = 0
      let first = -1
      while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
        if (first === -1) first = cursor
        count += 1
        cursor += Math.max(needle.length, 1)
      }
      if (count > 0) {
        matches.push({ page: page.page, excerpt: excerptAround(page.text, first, needle.length), count })
      }
    }
    return matches
  }

  invalidate(filePath?: string): void {
    if (filePath) this.cache.delete(filePath)
    else this.cache.clear()
  }
}
