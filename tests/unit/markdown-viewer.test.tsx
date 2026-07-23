// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@uiw/react-codemirror', async () => {
  const { createElement } = await import('react')
  return {
    default: () => createElement('div', { 'data-testid': 'mock-markdown-editor' }),
  }
})

import { MarkdownViewer } from '../../src/components/viewers/MarkdownViewer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MarkdownViewer preview', () => {
  it('opens a new Markdown document in preview mode and highlights its fenced language', async () => {
    const onReadingStateChange = vi.fn()
    render(
      <MarkdownViewer
        value={'# 示例\n\n```typescript\nconst answer: number = 42\n```'}
        onReadingStateChange={onReadingStateChange}
      />,
    )

    expect(screen.getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Markdown 预览')).toBeInTheDocument()
    expect(screen.queryByLabelText('Markdown 源码编辑区')).not.toBeInTheDocument()

    const block = screen.getByRole('region', { name: 'TypeScript 代码块' })
    expect(block.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(block.querySelector('.hljs-number')).toHaveTextContent('42')
    await waitFor(() => expect(onReadingStateChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'preview' })))
  })

  it('keeps an explicitly restored edit mode', () => {
    render(<MarkdownViewer value="# 恢复编辑" mode="edit" />)

    expect(screen.getByRole('button', { name: '编辑' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Markdown 源码编辑区')).toBeInTheDocument()
    expect(screen.queryByLabelText('Markdown 预览')).not.toBeInTheDocument()
  })

  it('auto-detects an unlabeled fence and copies the original code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const code = 'def greet(name):\n    return f"Hello {name}"'
    render(<MarkdownViewer value={`\`\`\`\n${code}\n\`\`\``} />)

    const block = screen.getByRole('region', { name: 'Python · 自动识别 代码块' })
    expect(block.querySelector('.hljs-keyword')).toHaveTextContent('def')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code))
  })

  it('collapses and expands only descendants of the selected outline branch', () => {
    render(
      <MarkdownViewer
        value={[
          '# 指南',
          '## 安装',
          '### Windows',
          '## 使用',
          '# 附录',
        ].join('\n')}
      />,
    )
    const outline = within(screen.getByLabelText('Markdown 大纲'))
    const guideToggle = outline.getByRole('button', { name: '折叠“指南”下的标题' })

    expect(guideToggle).toHaveAttribute('aria-expanded', 'true')
    expect(outline.getByRole('button', { name: /安装 H2/ })).toBeVisible()
    expect(outline.getByRole('button', { name: /Windows H3/ })).toBeVisible()
    expect(outline.getByRole('button', { name: /使用 H2/ })).toBeVisible()

    fireEvent.click(guideToggle)

    expect(outline.getByRole('button', { name: '展开“指南”下的标题' })).toHaveAttribute('aria-expanded', 'false')
    expect(outline.queryByRole('button', { name: /安装 H2/ })).not.toBeInTheDocument()
    expect(outline.queryByRole('button', { name: /Windows H3/ })).not.toBeInTheDocument()
    expect(outline.queryByRole('button', { name: /使用 H2/ })).not.toBeInTheDocument()
    expect(outline.getByRole('button', { name: /附录 H1/ })).toBeVisible()

    fireEvent.click(outline.getByRole('button', { name: '展开“指南”下的标题' }))
    expect(outline.getByRole('button', { name: /Windows H3/ })).toBeVisible()
  })

  it('resizes the outline from its right boundary and exposes keyboard controls', async () => {
    const onReadingStateChange = vi.fn()
    render(
      <MarkdownViewer
        value={'# 一个足够长的文档标题用于验证可调整的大纲宽度\n\n正文'}
        onReadingStateChange={onReadingStateChange}
      />,
    )
    const separator = screen.getByRole('separator', { name: '调整 Markdown 大纲宽度' })
    const outline = screen.getByLabelText('Markdown 大纲')

    expect(separator).toHaveAttribute('aria-valuenow', '216')
    fireEvent(separator, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 216 }))
    fireEvent(window, new MouseEvent('pointermove', { bubbles: true, clientX: 336 }))
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true, clientX: 336 }))

    expect(separator).toHaveAttribute('aria-valuenow', '336')
    expect(outline).toHaveStyle({ width: '336px' })
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '520')
    await waitFor(() => expect(onReadingStateChange).toHaveBeenCalledWith(expect.objectContaining({ outlineWidth: 520 })))
  })

  it('keeps sibling branches visible and resets collapsed branches when the document changes', async () => {
    const content = '# 指南\n## 安装\n### Windows\n## 使用\n# 附录'
    const view = render(<MarkdownViewer documentId="guide-a" value={content} />)
    const outline = within(screen.getByLabelText('Markdown 大纲'))

    fireEvent.click(outline.getByRole('button', { name: '折叠“安装”下的标题' }))
    expect(outline.queryByRole('button', { name: /Windows H3/ })).not.toBeInTheDocument()
    expect(outline.getByRole('button', { name: /使用 H2/ })).toBeVisible()
    expect(outline.queryByRole('button', { name: /折叠“使用”/ })).not.toBeInTheDocument()

    view.rerender(<MarkdownViewer documentId="guide-b" value={content} />)
    await waitFor(() => expect(outline.getByRole('button', { name: /Windows H3/ })).toBeVisible())
    expect(outline.getByRole('button', { name: '折叠“安装”下的标题' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('publishes the new document context immediately when a reused viewer switches files', async () => {
    const onContextChange = vi.fn()
    const view = render(
      <MarkdownViewer documentId="note-a" value={'# Note A\n\nFIRST_DOCUMENT_CONTEXT'} onContextChange={onContextChange} />,
    )
    await waitFor(() => expect(onContextChange).toHaveBeenLastCalledWith(expect.objectContaining({
      documentText: expect.stringContaining('FIRST_DOCUMENT_CONTEXT'),
    })))

    onContextChange.mockClear()
    view.rerender(
      <MarkdownViewer documentId="note-b" value={'# Note B\n\nSECOND_DOCUMENT_CONTEXT'} onContextChange={onContextChange} />,
    )

    await waitFor(() => expect(onContextChange).toHaveBeenLastCalledWith(expect.objectContaining({
      documentText: expect.stringContaining('SECOND_DOCUMENT_CONTEXT'),
      visibleText: expect.stringContaining('SECOND_DOCUMENT_CONTEXT'),
    })))
    expect(onContextChange.mock.calls.at(-1)?.[0].documentText).not.toContain('FIRST_DOCUMENT_CONTEXT')
  })

  it('keeps a preview selection as persistent AI context after focus leaves the document', async () => {
    const ranges = new Map<string, unknown>()
    const set = vi.fn((name: string, value: unknown) => ranges.set(name, value))
    const remove = vi.fn((name: string) => ranges.delete(name))
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { highlights: { set, delete: remove } },
    })
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: class Highlight {
        constructor(..._ranges: Range[]) {}
      },
    })
    const onContextChange = vi.fn()
    const view = render(
      <MarkdownViewer
        documentId="selection-note"
        value={'# 选区测试\n\n路由把请求映射到处理函数。'}
        onContextChange={onContextChange}
        aiSelectionText="路由把请求映射到处理函数。"
        aiSelectionClearToken={0}
      />,
    )
    const preview = screen.getByLabelText('Markdown 预览')
    const paragraph = within(preview).getByText('路由把请求映射到处理函数。')
    const textNode = paragraph.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, textNode.data.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(preview)
    await waitFor(() => expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({
      selection: '路由把请求映射到处理函数。',
    })))
    expect(preview).toHaveAttribute('data-ai-context-selection', 'true')
    expect(set).toHaveBeenCalledWith('coscribe-ai-context-selection', expect.anything())

    fireEvent.blur(preview)
    expect(preview).toHaveAttribute('data-ai-context-selection', 'true')

    view.rerender(
      <MarkdownViewer
        documentId="selection-note"
        value={'# 选区测试\n\n路由把请求映射到处理函数。'}
        onContextChange={onContextChange}
        aiSelectionText=""
        aiSelectionClearToken={1}
      />,
    )
    await waitFor(() => expect(preview).not.toHaveAttribute('data-ai-context-selection'))
    expect(remove).toHaveBeenCalledWith('coscribe-ai-context-selection')
  })

  it('includes active keyboard shortcuts in Markdown toolbar hover titles', () => {
    render(<MarkdownViewer value="# 快捷键" onSave={vi.fn()} />)

    expect(screen.getByRole('button', { name: '查找' })).toHaveAttribute('title', expect.stringContaining('⌘F'))
    expect(screen.getByRole('button', { name: '撤销' })).toHaveAttribute('title', expect.stringContaining('⌘Z'))
    expect(screen.getByRole('button', { name: '重做' })).toHaveAttribute('title', expect.stringContaining('⇧⌘Z'))
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('title', expect.stringContaining('⌘S'))
  })
})
