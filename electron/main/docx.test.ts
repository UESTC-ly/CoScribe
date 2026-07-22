import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  assertSafeDocxArchive,
  assertSafeDocxInflation,
  DocxService,
  inflatedSizeWithinLimit,
  MAX_DOCX_ENTRY_COUNT,
  MAX_DOCX_ENTRY_SIZE
} from './docx'

const fixturePath = path.resolve('node_modules/mammoth/test/test-data/single-paragraph.docx')
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50

describe('DOCX extraction safety', () => {
  it('extracts a normal DOCX after validating its archive', async () => {
    const buffer = await readFile(fixturePath)
    expect(() => assertSafeDocxArchive(buffer)).not.toThrow()

    const result = await new DocxService().extract(fixturePath, buffer, 1)
    expect(result.text).toContain('Walking on imported air')
    expect(result.html).toContain('<p>')
  })

  it('rejects an archive that declares too many entries before inflation', () => {
    const buffer = Buffer.alloc(22)
    buffer.writeUInt32LE(END_SIGNATURE, 0)
    buffer.writeUInt16LE(MAX_DOCX_ENTRY_COUNT + 1, 8)
    buffer.writeUInt16LE(MAX_DOCX_ENTRY_COUNT + 1, 10)

    expect(() => assertSafeDocxArchive(buffer)).toThrow('内部条目超过')
  })

  it('rejects a central-directory entry whose expanded size exceeds the limit', async () => {
    const buffer = Buffer.from(await readFile(fixturePath))
    let cursor = 0
    while (cursor + 46 <= buffer.byteLength) {
      if (buffer.readUInt32LE(cursor) === CENTRAL_SIGNATURE) {
        buffer.writeUInt32LE(MAX_DOCX_ENTRY_SIZE + 1, cursor + 24)
        break
      }
      cursor += 1
    }

    expect(() => assertSafeDocxArchive(buffer)).toThrow('单个条目解压后超过')
  })

  it('stops actual DEFLATE output when it exceeds the byte limit', async () => {
    const compressed = deflateRawSync(Buffer.alloc(2 * 1024 * 1024))
    await expect(inflatedSizeWithinLimit(compressed, 64 * 1024)).rejects.toThrow('实际解压数据超过')
  })

  it('rejects an entry whose declared size is smaller than its actual output', async () => {
    const buffer = Buffer.from(await readFile(fixturePath))
    let cursor = 0
    while (cursor + 46 <= buffer.byteLength) {
      if (buffer.readUInt32LE(cursor) === CENTRAL_SIGNATURE && buffer.readUInt32LE(cursor + 24) > 1) {
        buffer.writeUInt32LE(1, cursor + 24)
        break
      }
      cursor += 1
    }

    const entries = assertSafeDocxArchive(buffer)
    await expect(assertSafeDocxInflation(buffer, entries)).rejects.toThrow('实际解压数据超过安全上限')
  })
})
