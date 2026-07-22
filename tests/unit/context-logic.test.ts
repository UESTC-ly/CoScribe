import { describe, expect, it } from 'vitest'
import {
  captureContextSnapshot,
  choosePdfVisiblePages,
  getMarkdownHeadings,
  getMarkdownSection,
  resolveContextPriority
} from '../../src/lib'

describe('Markdown context boundaries', () => {
  it('returns the smallest nested section containing the cursor', () => {
    const markdown = [
      '# Guide',
      'intro',
      '## Setup',
      'setup text',
      '### Linux',
      'linux text',
      '## Usage',
      'usage text'
    ].join('\n')

    const section = getMarkdownSection(markdown, markdown.indexOf('linux text'))

    expect(section.heading).toBe('Linux')
    expect(section.text).toContain('linux text')
    expect(section.text).not.toContain('## Usage')
    expect(markdown.slice(section.start, section.end)).toBe(section.text)
  })

  it('treats text before the first heading as an untitled preamble', () => {
    const markdown = 'preface\nmore\n# First\nbody'
    const section = getMarkdownSection(markdown, 2)

    expect(section.heading).toBeUndefined()
    expect(section.text).toBe('preface\nmore\n')
  })

  it('supports Setext headings and ignores headings inside fenced code', () => {
    const markdown = 'Title\n=====\ntext\n```md\n# Not a heading\n```\n## Real\nbody'
    const headings = getMarkdownHeadings(markdown)

    expect(headings.map(({ text, level }) => [text, level])).toEqual([
      ['Title', 1],
      ['Real', 2]
    ])
  })

  it('does not treat a fenced code line with an info suffix as a closing fence', () => {
    const markdown = '```md\n```ts\n# Still code\n```\n# Real'
    expect(getMarkdownHeadings(markdown).map(({ text }) => text)).toEqual(['Real'])
  })
})

describe('AI context priority and snapshots', () => {
  it('uses selection before visible text and section text in automatic mode', () => {
    expect(resolveContextPriority({
      selection: ' selected ',
      visibleText: 'visible',
      sectionText: 'section',
      documentText: 'document'
    })).toMatchObject({ scope: 'selection', source: 'selection', text: ' selected ' })

    expect(resolveContextPriority({ visibleText: 'visible', sectionText: 'section' })).toMatchObject({
      scope: 'visible',
      source: 'visible',
      text: 'visible'
    })
    expect(resolveContextPriority({ sectionText: 'section' })).toMatchObject({
      scope: 'visible',
      source: 'section',
      text: 'section'
    })
  })

  it('does not start a project-wide search unless project scope is explicit', () => {
    expect(resolveContextPriority({ projectText: 'other files' })).toMatchObject({
      scope: 'general',
      source: 'general'
    })
    expect(resolveContextPriority({ projectText: 'other files' }, 'project')).toMatchObject({
      scope: 'project',
      source: 'project',
      text: 'other files'
    })
  })

  it('keeps an explicit document scope when its text is temporarily unavailable', () => {
    expect(resolveContextPriority({}, 'document')).toMatchObject({
      scope: 'document',
      source: 'document',
      text: undefined,
      usedFallback: true
    })

    expect(captureContextSnapshot({
      projectName: 'Study',
      projectPath: '/study',
      pane: 'primary',
      documentPath: '/study/notes/current.md'
    }, 'document')).toMatchObject({
      scope: 'document',
      documentPath: '/study/notes/current.md'
    })
  })

  it('deep-copies array context at send time', () => {
    const visiblePages = [16, 17]
    const referencedFiles = ['notes.md']
    const snapshot = captureContextSnapshot({
      projectName: 'Study',
      projectPath: '/study',
      pane: 'secondary',
      documentPath: '/study/book.pdf',
      documentName: 'book.pdf',
      kind: 'pdf',
      pdfPage: 17,
      visiblePages,
      selection: 'why persist?',
      referencedFiles,
      capturedAt: 123
    })

    visiblePages.push(18)
    referencedFiles[0] = 'changed.md'

    expect(snapshot.visiblePages).toEqual([16, 17])
    expect(snapshot.referencedFiles).toEqual(['notes.md'])
    expect(snapshot.scope).toBe('selection')
    expect(snapshot.capturedAt).toBe(123)
  })
})

describe('PDF visible page selection', () => {
  it('prefers visible pixel area and reports all auxiliary pages', () => {
    expect(choosePdfVisiblePages([
      { page: 16, visibleRatio: 0.9, visiblePixels: 500 },
      { page: 17, visibleRatio: 0.7, visiblePixels: 900 },
      { page: 18, visibleRatio: 0 }
    ])).toEqual({ primaryPage: 17, visiblePages: [16, 17] })
  })

  it('uses viewport center as a stable tie-breaker and can apply hysteresis', () => {
    const pages = [
      { page: 3, visibleRatio: 0.55, distanceToViewportCenter: 100 },
      { page: 4, visibleRatio: 0.6, distanceToViewportCenter: 200 }
    ]
    expect(choosePdfVisiblePages(pages).primaryPage).toBe(4)
    expect(choosePdfVisiblePages(pages, { previousPage: 3, hysteresis: 0.1 }).primaryPage).toBe(3)

    expect(choosePdfVisiblePages([
      { page: 8, visibleRatio: 0.5, distanceToViewportCenter: 80 },
      { page: 7, visibleRatio: 0.5, distanceToViewportCenter: 20 }
    ]).primaryPage).toBe(7)
  })

  it('returns an empty selection when nothing is visible', () => {
    expect(choosePdfVisiblePages([{ page: 1, visibleRatio: 0 }])).toEqual({
      primaryPage: null,
      visiblePages: []
    })
  })
})
