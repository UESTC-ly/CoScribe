import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { extractPptxText, pptxSlideText } from './pptx'

interface TestZipEntry {
  name: string
  content: string
  deflate?: boolean
}

function testZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content)
    const compressed = entry.deflate ? deflateRawSync(content) : content
    const method = entry.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(compressed.length, 20)
    directory.writeUInt32LE(content.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(localOffset, 42)
    central.push(directory, name)
    localOffset += local.length + name.length + compressed.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

describe('PPTX text extraction', () => {
  it('keeps run order, paragraph boundaries, and XML characters', () => {
    expect(pptxSlideText([
      '<p:sp><a:p><a:r><a:t>Hello &amp; </a:t></a:r>',
      '<a:r><a:t>CoScribe</a:t></a:r></a:p>',
      '<a:p><a:r><a:t>第二行&#x3002;</a:t></a:r></a:p></p:sp>'
    ].join(''))).toBe('Hello & CoScribe\n第二行。')
  })

  it('extracts and orders stored and deflated slide XML entries', () => {
    const archive = testZip([
      { name: '[Content_Types].xml', content: '<Types />' },
      { name: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:t>第二页</a:t></a:p></p:sld>', deflate: true },
      { name: 'ppt/slides/slide1.xml', content: '<p:sld><a:p><a:t>First slide</a:t></a:p></p:sld>' }
    ])

    expect(extractPptxText(archive)).toEqual({
      text: '[幻灯片 1]\nFirst slide\n\n[幻灯片 2]\n第二页',
      slides: [
        { number: 1, text: 'First slide' },
        { number: 2, text: '第二页' }
      ],
      warnings: []
    })
  })

  it('uses the presentation relationship order for rearranged slides', () => {
    const archive = testZip([
      { name: '[Content_Types].xml', content: '<Types />' },
      {
        name: 'ppt/presentation.xml',
        content: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rIdSecond"/><p:sldId id="2" r:id="rIdFirst"/></p:sldIdLst></p:presentation>'
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        content: '<Relationships><Relationship Id="rIdFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rIdSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'
      },
      { name: 'ppt/slides/slide1.xml', content: '<p:sld><a:p><a:t>Physical first</a:t></a:p></p:sld>' },
      { name: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:t>Visible first</a:t></a:p></p:sld>' }
    ])

    expect(extractPptxText(archive).slides).toEqual([
      { number: 1, text: 'Visible first' },
      { number: 2, text: 'Physical first' }
    ])
  })

  it('rejects a non-ZIP payload instead of guessing text', () => {
    expect(() => extractPptxText(Buffer.from('not a presentation'))).toThrow('无法读取 PPTX')
  })
})
