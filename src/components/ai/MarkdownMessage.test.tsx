// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownMessage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MarkdownContent', () => {
  it('routes Mermaid fences to the diagram renderer', () => {
    render(<MarkdownContent content={'```mermaid\ngraph TD\n  A --> B\n```'} />)

    expect(screen.getByLabelText('Mermaid 图表')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /Mermaid 代码块/ })).not.toBeInTheDocument()
  })

  it('adds IDE-style tokens and a language label to supported code', () => {
    render(<MarkdownContent content={'```typescript\nconst answer: number = 42\n```'} />)

    const block = screen.getByRole('region', { name: 'TypeScript 代码块' })
    expect(block).toHaveTextContent('const answer: number = 42')
    expect(block.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(block.querySelector('.hljs-number')).toHaveTextContent('42')
  })

  it('copies the original code without highlight markup', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    render(<MarkdownContent content={'```python\nprint("CoScribe")\n```'} />)

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('print("CoScribe")'))
    expect(screen.getByRole('button', { name: '代码已复制' })).toBeInTheDocument()
  })

  it('renders unknown languages as safe plain text', () => {
    render(<MarkdownContent content={'```coscribe-lang\n<tag>& raw\n```'} />)

    const block = screen.getByRole('region', { name: 'coscribe-lang 代码块' })
    expect(block).toHaveTextContent('<tag>& raw')
    expect(block.querySelector('[class^="hljs-"]')).toBeNull()
    expect(block.querySelector('tag')).toBeNull()
  })
})
