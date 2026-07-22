// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent, MarkdownMessage } from './MarkdownMessage'

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

describe('MarkdownMessage images', () => {
  it('keeps a generated image downloadable from the conversation', () => {
    const dataUrl = 'data:image/jpeg;base64,ZmFrZS1pbWFnZQ=='
    render(
      <MarkdownMessage
        message={{
          id: 'generated-image',
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          attachments: [{
            id: 'image-1',
            name: 'coscribe-image.jpg',
            mimeType: 'image/jpeg',
            dataUrl,
            size: 10,
          }],
        }}
        onOpenSource={vi.fn()}
        onOpenContext={vi.fn()}
        onAcceptOperation={vi.fn()}
        onRejectOperation={vi.fn()}
      />,
    )

    expect(screen.getByRole('img', { name: 'coscribe-image.jpg' })).toHaveAttribute('src', dataUrl)
    const download = screen.getByRole('link', { name: '下载 coscribe-image.jpg' })
    expect(download).toHaveAttribute('href', dataUrl)
    expect(download).toHaveAttribute('download', 'coscribe-image.jpg')
  })
})
