import { describe, expect, it } from 'vitest'

import {
  buildWebClipMarkdown,
  normalizeBrowserInput,
  safeCaptureFileBase,
  shouldUseSystemBrowser,
  validatedHttpUrl
} from './web-clip'

describe('research browser URL boundaries', () => {
  it('normalizes hosts and search terms without allowing privileged schemes', () => {
    expect(normalizeBrowserInput('example.com/guide')).toBe('https://example.com/guide')
    expect(normalizeBrowserInput('localhost:4173/article')).toBe('http://localhost:4173/article')
    expect(normalizeBrowserInput('knowledge graph')).toBe('https://www.google.com/search?q=knowledge%20graph')
    expect(() => validatedHttpUrl('file:///tmp/secret')).toThrow(/HTTP/u)
    expect(() => normalizeBrowserInput('javascript:alert(1)')).toThrow(/HTTP/u)
    expect(() => validatedHttpUrl('https://user:secret@example.com')).toThrow(/账号或密码/u)
  })

  it('delegates known video and direct media URLs to the system browser', () => {
    expect(shouldUseSystemBrowser('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(shouldUseSystemBrowser('https://cdn.example.com/demo.mp4')).toBe(true)
    expect(shouldUseSystemBrowser('https://example.com/article')).toBe(false)
  })
})

describe('web clipping output', () => {
  it('creates portable names and source-grounded Markdown', () => {
    expect(safeCaptureFileBase('A / B: <Guide>.')).toBe('A B Guide')
    expect(safeCaptureFileBase('CON')).toBe('网页资料')
    expect(safeCaptureFileBase('CON.md')).toBe('网页资料')
    expect(safeCaptureFileBase('AUX.notes')).toBe('网页资料')
    expect(safeCaptureFileBase('LPT9.archive')).toBe('网页资料')
    expect(safeCaptureFileBase('CON.notes')).toBe('网页资料')
    expect(buildWebClipMarkdown({
      title: 'Research note',
      url: 'https://example.com/article',
      markdown: '## Finding\n\nUseful text.',
      text: '',
      capturedAt: new Date('2026-07-22T00:00:00.000Z')
    })).toContain([
      '# Research note',
      '',
      '> 来源：[https://example.com/article](<https://example.com/article>)',
      '> 保存时间：2026-07-22T00:00:00.000Z',
      '',
      '## Finding'
    ].join('\n'))
  })

  it('escapes hostile titles and uses an angle-bracket URL destination', () => {
    const output = buildWebClipMarkdown({
      title: '# [Injected](javascript:alert(1))',
      url: 'https://example.com/a_(b)?q=x#part',
      markdown: '',
      text: '# not a heading\n- not a list',
      capturedAt: new Date('2026-07-22T00:00:00.000Z')
    })
    expect(output).toContain('# \\# \\[Injected\\](javascript:alert(1))')
    expect(output).toContain('(<https://example.com/a_(b)?q=x#part>)')
    expect(output).toContain('\\# not a heading\n\\- not a list')
  })
})
