import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_SLIDE_XML_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_SLIDE_XML_BYTES = 64 * 1024 * 1024

interface ZipEntry {
  name: string
  flags: number
  compression: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface PptxSlideText {
  number: number
  text: string
}

export interface PptxTextResult {
  text: string
  slides: PptxSlideText[]
  warnings: string[]
}

function archiveError(detail: string): Error {
  return new Error(`无法读取 PPTX：${detail}`)
}

function findEndOfCentralDirectory(input: Buffer): number {
  const minimum = 22
  const maximumComment = 0xffff
  for (let offset = input.length - minimum; offset >= Math.max(0, input.length - minimum - maximumComment); offset -= 1) {
    if (
      input.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + minimum + input.readUInt16LE(offset + 20) === input.length
    ) return offset
  }
  throw archiveError('文件不是有效的 Office Open XML 压缩包。')
}

function zipEntries(input: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(input)
  if (eocd + 22 > input.length) throw archiveError('ZIP 目录尾部不完整。')
  const disk = input.readUInt16LE(eocd + 4)
  const centralDisk = input.readUInt16LE(eocd + 6)
  const entriesOnDisk = input.readUInt16LE(eocd + 8)
  const entryCount = input.readUInt16LE(eocd + 10)
  const centralSize = input.readUInt32LE(eocd + 12)
  const centralOffset = input.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw archiveError('不支持分卷 ZIP。')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError('不支持 ZIP64 格式的超大演示文稿。')
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw archiveError('压缩包条目过多。')
  if (centralOffset + centralSize > input.length) throw archiveError('ZIP 中央目录越界。')

  const entries: ZipEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > input.length || input.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw archiveError('ZIP 中央目录损坏。')
    }
    const flags = input.readUInt16LE(cursor + 8)
    const compression = input.readUInt16LE(cursor + 10)
    const compressedSize = input.readUInt32LE(cursor + 20)
    const uncompressedSize = input.readUInt32LE(cursor + 24)
    const nameLength = input.readUInt16LE(cursor + 28)
    const extraLength = input.readUInt16LE(cursor + 30)
    const commentLength = input.readUInt16LE(cursor + 32)
    const localHeaderOffset = input.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralOffset + centralSize) throw archiveError('ZIP 条目名称或附加数据越界。')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw archiveError('不支持 ZIP64 条目。')
    }
    const name = input.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/gu, '/')
    if (name.includes('\0') || name.split('/').some((segment) => segment === '..')) {
      throw archiveError('ZIP 包含不安全的条目路径。')
    }
    entries.push({ name, flags, compression, compressedSize, uncompressedSize, localHeaderOffset })
    cursor = next
  }
  return entries
}

function entryBytes(input: Buffer, entry: ZipEntry): Buffer {
  if ((entry.flags & 0x1) !== 0) throw archiveError('不支持加密的 PPTX。')
  if (entry.uncompressedSize > MAX_SLIDE_XML_BYTES) throw archiveError('单页幻灯片 XML 过大。')
  const offset = entry.localHeaderOffset
  if (offset + 30 > input.length || input.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw archiveError('ZIP 本地文件头损坏。')
  }
  const nameLength = input.readUInt16LE(offset + 26)
  const extraLength = input.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > input.length) throw archiveError('ZIP 条目内容越界。')
  const compressed = input.subarray(dataStart, dataEnd)
  let output: Buffer
  if (entry.compression === 0) output = Buffer.from(compressed)
  else if (entry.compression === 8) {
    try {
      output = inflateRawSync(compressed, { maxOutputLength: MAX_SLIDE_XML_BYTES })
    } catch {
      throw archiveError('幻灯片 XML 解压失败。')
    }
  }
  else throw archiveError(`不支持 ZIP 压缩方式 ${entry.compression}。`)
  if (output.length !== entry.uncompressedSize) throw archiveError('ZIP 条目解压后的长度不一致。')
  return output
}

function xmlCharacter(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return fallback
  return String.fromCodePoint(value)
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (entity, digits: string) => xmlCharacter(Number.parseInt(digits, 16), entity))
    .replace(/&#([0-9]+);/gu, (entity, digits: string) => xmlCharacter(Number.parseInt(digits, 10), entity))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

export function pptxSlideText(xml: string): string {
  const parts: string[] = []
  const tokenPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>|<a:br\b[^>]*\/?\s*>|<\/a:p\s*>/giu
  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1] !== undefined) parts.push(decodeXmlText(match[1]))
    else parts.push('\n')
  }
  return parts
    .join('')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\u00a0]+\n/gu, '\n')
    .replace(/\n[ \t\u00a0]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function xmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/gu)) {
    attributes.set(match[1], decodeXmlText(match[3]))
  }
  return attributes
}

function presentationSlideOrder(input: Buffer, entries: ZipEntry[]): string[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const presentation = byName.get('ppt/presentation.xml')
  const relationships = byName.get('ppt/_rels/presentation.xml.rels')
  if (!presentation || !relationships) return []

  const targets = new Map<string, string>()
  const relationshipXml = entryBytes(input, relationships).toString('utf8')
  for (const match of relationshipXml.matchAll(/<Relationship\b[^>]*\/?>/giu)) {
    const attributes = xmlAttributes(match[0])
    const id = attributes.get('Id')
    const target = attributes.get('Target')
    const type = attributes.get('Type')
    if (!id || !target || !type?.endsWith('/slide') || attributes.get('TargetMode') === 'External') continue
    const normalized = target.startsWith('/')
      ? path.posix.normalize(target.slice(1))
      : path.posix.normalize(path.posix.join('ppt', target))
    if (/^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(normalized)) targets.set(id, normalized)
  }

  const order: string[] = []
  const presentationXml = entryBytes(input, presentation).toString('utf8')
  for (const match of presentationXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sldId\b[^>]*\/?>/giu)) {
    const id = xmlAttributes(match[0]).get('r:id')
    const target = id ? targets.get(id) : undefined
    if (target && byName.has(target) && !order.includes(target)) order.push(target)
  }
  return order
}

export function extractPptxText(input: Buffer): PptxTextResult {
  const slides: PptxSlideText[] = []
  const entries = zipEntries(input)
  const numericSlideEntries = entries
    .flatMap((entry): Array<{ entry: ZipEntry; number: number }> => {
      const match = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(entry.name)
      return match ? [{ entry, number: Number.parseInt(match[1], 10) }] : []
    })
    .sort((left, right) => left.number - right.number)
  if (!numericSlideEntries.length) throw archiveError('没有找到幻灯片页面。')

  const requestedOrder = presentationSlideOrder(input, entries)
  const byName = new Map(numericSlideEntries.map(({ entry }) => [entry.name, entry]))
  const slideEntries = requestedOrder.length === numericSlideEntries.length
    ? requestedOrder.map((name, index) => ({ entry: byName.get(name)!, number: index + 1 }))
    : numericSlideEntries

  let totalBytes = 0
  for (const { entry, number } of slideEntries) {
    totalBytes += entry.uncompressedSize
    if (totalBytes > MAX_TOTAL_SLIDE_XML_BYTES) throw archiveError('幻灯片文本数据过大。')
    slides.push({ number, text: pptxSlideText(entryBytes(input, entry).toString('utf8')) })
  }
  const warnings = slides.some((slide) => !slide.text)
    ? ['部分幻灯片没有可提取文字；图片和图形中的文字需要 OCR。']
    : []
  return {
    text: slides.map((slide) => `[幻灯片 ${slide.number}]${slide.text ? `\n${slide.text}` : ''}`).join('\n\n'),
    slides,
    warnings
  }
}
