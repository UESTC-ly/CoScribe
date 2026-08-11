import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownContent } from './MarkdownMessage'

describe('MarkdownContent component stability', () => {
  it('uses stable component renderers across renders to preserve DOM identity', async () => {
    // Regression test: components object must be module-scoped, not inline.
    // An inline object gives `pre` a new identity on every render, causing
    // react-markdown to remount code blocks and drop live text selections.
    const { container, rerender } = render(
      <MarkdownContent content={'```js\nconst x = 1\n```'} />
    )

    await waitFor(() => {
      expect(container.querySelector('pre')).toBeTruthy()
    })
    const firstPre = container.querySelector('pre')

    rerender(<MarkdownContent content={'```js\nconst y = 2\n```'} />)
    await waitFor(() => {
      expect(container.textContent).toContain('const y = 2')
    })
    const secondPre = container.querySelector('pre')

    // If components were inline, firstPre would be unmounted (no longer in container).
    // With stable components, the same <pre> element stays mounted.
    expect(firstPre).toBe(secondPre)
    expect(container.contains(firstPre)).toBe(true)
  })

  it('preserves custom link renderer identity across content updates', async () => {
    const { container, rerender } = render(
      <MarkdownContent content="Visit [example](https://example.com)" />
    )

    await waitFor(() => {
      expect(container.querySelector('a')).toBeTruthy()
    })
    const firstLink = container.querySelector('a')
    expect(firstLink?.getAttribute('target')).toBe('_blank')
    expect(firstLink?.getAttribute('rel')).toBe('noreferrer noopener')

    rerender(<MarkdownContent content="Go to [another](https://other.com)" />)
    await waitFor(() => {
      expect(container.textContent).toContain('another')
    })
    const secondLink = container.querySelector('a')

    // Same renderer function, so the custom attributes stay consistent
    expect(secondLink?.getAttribute('target')).toBe('_blank')
    expect(secondLink?.getAttribute('rel')).toBe('noreferrer noopener')
  })
})
