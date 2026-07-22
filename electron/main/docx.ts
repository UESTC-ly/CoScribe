import mammoth from 'mammoth'
import { createInflateRaw } from 'node:zlib'

export const MAX_DOCX_FILE_SIZE = 64 * 1024 * 1024
export const MAX_DOCX_ENTRY_COUNT = 10_000
export const MAX_DOCX_ENTRY_SIZE = 128 * 1024 * 1024
export const MAX_DOCX_UNCOMPRESSED_SIZE = 256 * 1024 * 1024
export const MAX_DOCX_HTML_CHARS = 16_000_000
export const MAX_DOCX_TEXT_CHARS = 8_000_000

const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_END_SIZE = 22
const ZIP_CENTRAL_HEADER_SIZE = 46
const ZIP_LOCAL_HEADER_SIZE = 30
const ZIP_MAX_COMMENT_SIZE = 0xffff
const ZIP16_SENTINEL = 0xffff
const ZIP32_SENTINEL = 0xffffffff
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8

export interface DocxContent {
  html: string
  text: string
  warnings: string[]
}

interface CachedDocxContent extends DocxContent {
  modifiedAt: number
  size: number
}

interface DocxArchiveEntry {
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  dataStart: number
}

function warningMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value)
  const message = (value as { message?: unknown }).message
  return (typeof message === 'string' ? message : String(value)).slice(0, 1_000)
}

function endOfCentralDirectory(buffer: Buffer): number {
  const firstCandidate = buffer.byteLength - ZIP_END_SIZE
  const lastCandidate = Math.max(0, firstCandidate - ZIP_MAX_COMMENT_SIZE)
  for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue
    const commentSize = buffer.readUInt16LE(offset + 20)
    if (offset + ZIP_END_SIZE + commentSize === buffer.byteLength) return offset
  }
  throw new Error('DOCX ZIP 目录无效或已损坏。')
}

/** Reads ZIP metadata without trusting or inflating user-controlled entries. */
export function assertSafeDocxArchive(buffer: Buffer): DocxArchiveEntry[] {
  if (buffer.byteLength < ZIP_END_SIZE) throw new Error('DOCX ZIP 目录无效或已损坏。')
  const endOffset = endOfCentralDirectory(buffer)
  const disk = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8)
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)

  if (
    disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === ZIP16_SENTINEL || centralSize === ZIP32_SENTINEL || centralOffset === ZIP32_SENTINEL
  ) {
    throw new Error('DOCX 不支持分卷或 ZIP64 格式。')
  }
  if (entryCount > MAX_DOCX_ENTRY_COUNT) {
    throw new Error(`DOCX 内部条目超过 ${MAX_DOCX_ENTRY_COUNT.toLocaleString('en-US')} 个，已拒绝打开。`)
  }
  const centralEnd = centralOffset + centralSize
  if (centralOffset > endOffset || centralEnd !== endOffset || centralEnd > buffer.byteLength) {
    throw new Error('DOCX ZIP 中央目录边界无效。')
  }

  let cursor = centralOffset
  let totalUncompressed = 0
  let hasContentTypes = false
  let hasDocument = false
  const entries: DocxArchiveEntry[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_SIZE > centralEnd || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('DOCX ZIP 中央目录条目无效。')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameSize = buffer.readUInt16LE(cursor + 28)
    const extraSize = buffer.readUInt16LE(cursor + 30)
    const commentSize = buffer.readUInt16LE(cursor + 32)
    const diskStart = buffer.readUInt16LE(cursor + 34)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const entryEnd = cursor + ZIP_CENTRAL_HEADER_SIZE + nameSize + extraSize + commentSize
    if (
      compressedSize === ZIP32_SENTINEL || uncompressedSize === ZIP32_SENTINEL ||
      localHeaderOffset === ZIP32_SENTINEL || diskStart !== 0 || entryEnd > centralEnd
    ) {
      throw new Error('DOCX ZIP 条目使用了不受支持的 ZIP64、分卷或损坏字段。')
    }
    if ((flags & 1) !== 0) throw new Error('DOCX 不支持加密 ZIP 条目。')
    if (compressionMethod !== ZIP_METHOD_STORED && compressionMethod !== ZIP_METHOD_DEFLATE) {
      throw new Error(`DOCX ZIP 使用了不支持的压缩方法 ${compressionMethod}。`)
    }
    if (uncompressedSize > MAX_DOCX_ENTRY_SIZE) {
      throw new Error('DOCX 内部单个条目解压后超过 128 MB，已拒绝打开。')
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_SIZE) {
      throw new Error('DOCX 解压后总大小超过 256 MB，已拒绝打开。')
    }

    const name = buffer.toString('utf8', cursor + ZIP_CENTRAL_HEADER_SIZE, cursor + ZIP_CENTRAL_HEADER_SIZE + nameSize)
      .replace(/\\/gu, '/')
    if (
      localHeaderOffset + ZIP_LOCAL_HEADER_SIZE > centralOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_SIGNATURE
    ) {
      throw new Error('DOCX ZIP 本地条目头无效。')
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6)
    const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8)
    const localNameSize = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraSize = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + ZIP_LOCAL_HEADER_SIZE + localNameSize + localExtraSize
    const dataEnd = dataStart + compressedSize
    if (
      (localFlags & 1) !== 0 || localCompressionMethod !== compressionMethod ||
      dataStart > centralOffset || dataEnd > centralOffset
    ) {
      throw new Error('DOCX ZIP 本地条目边界或压缩方法无效。')
    }
    if (name === '[Content_Types].xml') hasContentTypes = true
    if (name === 'word/document.xml') hasDocument = true
    entries.push({ compressedSize, uncompressedSize, compressionMethod, dataStart })
    cursor = entryEnd
  }
  if (cursor !== centralEnd || !hasContentTypes || !hasDocument) {
    throw new Error('文件不是结构完整的 DOCX 文档。')
  }
  return entries
}

export function inflatedSizeWithinLimit(compressed: Buffer, maximum: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw()
    let size = 0
    let settled = false
    inflater.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size <= maximum || settled) return
      settled = true
      inflater.destroy()
      reject(new Error('DOCX 实际解压数据超过安全上限，已停止解析。'))
    })
    inflater.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    inflater.once('end', () => {
      if (settled) return
      settled = true
      resolve(size)
    })
    inflater.end(compressed)
  })
}

export async function assertSafeDocxInflation(buffer: Buffer, entries: DocxArchiveEntry[]): Promise<void> {
  let totalUncompressed = 0
  for (const entry of entries) {
    const maximum = Math.min(
      entry.uncompressedSize,
      MAX_DOCX_ENTRY_SIZE,
      MAX_DOCX_UNCOMPRESSED_SIZE - totalUncompressed
    )
    let actualSize: number
    if (entry.compressionMethod === ZIP_METHOD_STORED) {
      actualSize = entry.compressedSize
      if (actualSize > maximum) throw new Error('DOCX 实际解压数据超过安全上限，已停止解析。')
    } else {
      actualSize = await inflatedSizeWithinLimit(
        buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize),
        maximum
      )
    }
    if (actualSize !== entry.uncompressedSize) {
      throw new Error('DOCX ZIP 条目的声明大小与实际解压大小不一致。')
    }
    totalUncompressed += actualSize
  }
}

function assertOutputSize(value: string, maximum: number, label: string): void {
  if (value.length > maximum) throw new Error(`${label}超过安全上限，已停止解析。`)
}

/** Local semantic DOCX extraction. HTML stays untrusted until DOMPurify runs in the renderer. */
export class DocxService {
  private readonly cache = new Map<string, CachedDocxContent>()

  invalidate(filePath?: string): void {
    if (filePath) this.cache.delete(filePath)
    else this.cache.clear()
  }

  async extract(filePath: string, buffer: Buffer, modifiedAt: number): Promise<DocxContent> {
    if (buffer.byteLength > MAX_DOCX_FILE_SIZE) {
      throw new Error('DOCX 文件超过 64 MB，无法直接打开。')
    }
    const cached = this.cache.get(filePath)
    if (cached && cached.modifiedAt === modifiedAt && cached.size === buffer.byteLength) {
      return { html: cached.html, text: cached.text, warnings: [...cached.warnings] }
    }

    try {
      const entries = assertSafeDocxArchive(buffer)
      await assertSafeDocxInflation(buffer, entries)
      const htmlResult = await mammoth.convertToHtml({ buffer })
      assertOutputSize(htmlResult.value, MAX_DOCX_HTML_CHARS, 'DOCX HTML 输出')
      const textResult = await mammoth.extractRawText({ buffer })
      assertOutputSize(textResult.value, MAX_DOCX_TEXT_CHARS, 'DOCX 正文输出')
      const warnings = [...htmlResult.messages, ...textResult.messages]
        .map(warningMessage)
        .filter((message, index, values) => message && values.indexOf(message) === index)
        .slice(0, 100)
      const value: CachedDocxContent = {
        html: htmlResult.value,
        text: textResult.value.replace(/\r\n?/gu, '\n').trim(),
        warnings,
        modifiedAt,
        size: buffer.byteLength
      }
      this.cache.set(filePath, value)
      return { html: value.html, text: value.text, warnings: [...value.warnings] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法解析 DOCX：${message}`)
    }
  }
}
