// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { PAGE_CAPTURE_SCRIPT } from './web-page-capture'

interface CaptureResult {
  title: string
  url: string
  selection: string
  text: string
  markdown: string
}

function capture(html: string): CaptureResult {
  document.open()
  document.write(html)
  document.close()
  return window.eval(PAGE_CAPTURE_SCRIPT) as CaptureResult
}

describe('isolated webpage capture', () => {
  it('escapes hostile Markdown and chooses fences longer than page code', () => {
    const result = capture([
      '<!doctype html><title>Hostile page</title><article>',
      '<h1>Title [draft] #tag</h1>',
      '<p>before <strong>bold</strong> after</p>',
      '<p><a href="https://example.com/a_(b)?q=x">link [label]</a></p>',
      '<p><a href="javascript:alert(1)">unsafe [label]</a></p>',
      '<img alt="diagram [draft]" src="https://cdn.example.com/chart_(1).png">',
      '<pre><code class="language-js">const ticks = "```";</code></pre>',
      '</article>'
    ].join(''))

    expect(result.markdown).toContain('# Title \\[draft\\] \\#tag')
    expect(result.markdown).toContain('before **bold** after')
    expect(result.markdown).toContain('[link \\[label\\]](<https://example.com/a_(b)?q=x>)')
    expect(result.markdown).toContain('unsafe \\[label\\]')
    expect(result.markdown).not.toContain('javascript:')
    expect(result.markdown).toContain('![diagram \\[draft\\]](<https://cdn.example.com/chart_(1).png>)')
    expect(result.markdown).toContain('````js\nconst ticks = "```";\n````')
  })

  it('stops before cloning an excessively deep page', () => {
    const nested = `${'<div>'.repeat(82)}too deep${'</div>'.repeat(82)}`
    expect(() => capture(`<!doctype html><main>${nested}</main>`)).toThrow(/嵌套过深/u)
  })

  it('bounds generated AI context while retaining ordinary article structure', () => {
    const result = capture(`<article><h1>Research</h1><p>${'bounded text '.repeat(30_000)}</p></article>`)
    expect(result.text.length).toBeLessThanOrEqual(200_000)
    expect(result.markdown.length).toBeLessThanOrEqual(200_000)
    expect(result.markdown.startsWith('# Research')).toBe(true)
  })
})
