// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiWorkspaceProps } from './AiWorkspace'
import { AiWorkspace } from './AiWorkspace'
import { MarkdownOperationCard } from './MarkdownOperationCard'
import type {
  ChatImageAttachment,
  ChatMessage,
  ChatSession,
  ContextSnapshot,
  FileOperationProposal
} from '../../shared/types'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'coscribe', {
    configurable: true,
    value: {
      speech: {
        status: vi.fn().mockResolvedValue({ available: true, platform: 'darwin-arm64', model: 'test', modelInstalled: true }),
        start: vi.fn().mockResolvedValue(undefined),
        audio: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        onEvent: vi.fn().mockReturnValue(() => undefined)
      }
    }
  })
})

const context: ContextSnapshot = {
  projectName: 'LangGraph 学习',
  projectPath: '/projects/langgraph',
  pane: 'primary',
  documentPath: '/projects/langgraph/LangGraph.pdf',
  documentName: 'LangGraph.pdf',
  kind: 'pdf',
  pdfPage: 17,
  visiblePages: [17, 18],
  visibleText: 'PAGE_17_ONLY',
  scope: 'visible',
  referencedFiles: [],
  capturedAt: 1
}

const session: ChatSession = {
  id: 'session-1',
  title: 'Checkpointer',
  createdAt: 1,
  updatedAt: 2,
  messages: []
}

function buildProps(overrides: Partial<AiWorkspaceProps> = {}): AiWorkspaceProps {
  return {
    projectName: 'LangGraph 学习',
    sessions: [session],
    currentSessionId: session.id,
    context,
    contextScope: 'visible',
    referencedFiles: [],
    availableFiles: [
      { path: '/projects/langgraph/学习笔记.md', name: '学习笔记.md', kind: 'markdown' }
    ],
    isStreaming: false,
    isConfigured: true,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    onRenameSession: vi.fn(),
    onContextScopeChange: vi.fn(),
    onReferencedFilesChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenContext: vi.fn(),
    onAcceptOperation: vi.fn(),
    onRejectOperation: vi.fn(),
    ...overrides
  }
}

function pngFile(name = 'diagram.png'): File {
  return new File(
    [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    name,
    { type: 'image/png' }
  )
}

const conversationMessages: ChatMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: '解释 Checkpointer 如何保存状态',
    createdAt: 1
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Checkpointer 会在图运行期间保存状态快照。',
    createdAt: 2
  },
  {
    id: 'user-2',
    role: 'user',
    content: '它和普通数据库事务有什么区别？',
    createdAt: 3
  },
  {
    id: 'assistant-2',
    role: 'assistant',
    content: '两者解决的问题和生命周期不同。',
    createdAt: 4
  },
  {
    id: 'user-3',
    role: 'user',
    content: '请给出一个最小示例',
    createdAt: 5
  }
]

describe('AiWorkspace', () => {
  it('sends the question with the controlled scope and referenced files', () => {
    const onSend = vi.fn()
    render(
      <AiWorkspace
        {...buildProps({
          contextScope: 'document',
          referencedFiles: ['/projects/langgraph/学习笔记.md'],
          onSend
        })}
      />
    )

    const textbox = screen.getByRole('textbox', { name: '向 AI 提问' })
    fireEvent.change(textbox, { target: { value: '这里为什么需要持久化？' } })
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith({
      content: '这里为什么需要持久化？',
      attachments: [],
      scope: 'document',
      referencedFiles: ['/projects/langgraph/学习笔记.md']
    })
  })

  it('selects an image file and sends it without requiring text', async () => {
    const onSend = vi.fn()
    const { container } = render(<AiWorkspace {...buildProps({ onSend })} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, { target: { files: [pngFile('selected.png')] } })

    expect(await screen.findByRole('img', { name: 'selected.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith({
      content: '',
      attachments: [expect.objectContaining({
        name: 'selected.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        size: 8
      })],
      scope: 'visible',
      referencedFiles: []
    }))
  })

  it('accepts pasted images and lets the user remove them before sending', async () => {
    const onSend = vi.fn()
    render(<AiWorkspace {...buildProps({ onSend })} />)
    const textbox = screen.getByRole('textbox', { name: '向 AI 提问' })
    const file = pngFile('pasted.png')

    const dispatched = fireEvent.paste(textbox, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: () => ''
      }
    })

    expect(dispatched).toBe(false)
    expect(await screen.findByRole('img', { name: 'pasted.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除图片：pasted.png' }))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'pasted.png' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('captures the screen and places the returned image in the pending composer', async () => {
    const onCaptureScreenshot = vi.fn()
    const onCapturedImageHandled = vi.fn()
    const attachment: ChatImageAttachment = {
      id: 'screenshot-1',
      name: 'CoScribe-screenshot.jpg',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      size: 4
    }
    const { rerender } = render(<AiWorkspace {...buildProps({ onCaptureScreenshot, onCapturedImageHandled })} />)

    fireEvent.click(screen.getByRole('button', { name: '截图' }))
    expect(onCaptureScreenshot).toHaveBeenCalledOnce()

    rerender(<AiWorkspace {...buildProps({ capturedImage: attachment, onCaptureScreenshot, onCapturedImageHandled })} />)
    expect(await screen.findByRole('img', { name: 'CoScribe-screenshot.jpg' })).toBeInTheDocument()
    expect(onCapturedImageHandled).toHaveBeenCalledOnce()
  })

  it('offers one-click note organization for a non-empty conversation', () => {
    const onQuickNote = vi.fn()
    const sessionWithContent: ChatSession = {
      ...session,
      messages: [{ id: 'message-1', role: 'assistant', content: '关于状态持久化的解释', createdAt: 3 }]
    }
    render(<AiWorkspace {...buildProps({ sessions: [sessionWithContent], onQuickNote })} />)

    fireEvent.click(screen.getByRole('button', { name: '整理笔记' }))
    expect(onQuickNote).toHaveBeenCalledOnce()
  })

  it('shows context-window usage and offers non-destructive request compression', () => {
    const onCompactContext = vi.fn()
    const sessionWithHistory: ChatSession = {
      ...session,
      messages: conversationMessages
    }
    render(<AiWorkspace {...buildProps({
      sessions: [sessionWithHistory],
      contextUsage: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        windowTokens: 200_000,
        maximumInputTokens: 190_000,
        outputReserveTokens: 10_000,
        estimatedInputTokens: 142_500,
        estimatedSystemTokens: 12_000,
        estimatedMessageTokens: 130_500,
        percent: 75,
        status: 'watch',
        compactedMessageCount: 3,
        truncated: false,
        forced: false
      },
      onCompactContext
    })} />)

    expect(screen.getByRole('progressbar', { name: '上下文窗口占用' })).toHaveAttribute('aria-valuenow', '75')
    expect(screen.getByText('请求快照已压缩 3 条早期消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '压缩早期历史' }))
    expect(onCompactContext).toHaveBeenCalledOnce()
  })

  it('places the AI collapse control inside the AI panel header', () => {
    const onClose = vi.fn()
    render(<AiWorkspace {...buildProps({ onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: '收起 AI 侧栏' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not intercept an ordinary text-only paste', () => {
    const onDraftChange = vi.fn()
    render(<AiWorkspace {...buildProps({ onDraftChange })} />)
    const textbox = screen.getByRole('textbox', { name: '向 AI 提问' })

    const dispatched = fireEvent.paste(textbox, {
      clipboardData: {
        items: [],
        getData: (type: string) => type === 'text/plain' ? '普通文本' : ''
      }
    })

    expect(dispatched).toBe(true)
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('switches to GPT-Image 2 mode and sends the selected generation options', () => {
    const onSend = vi.fn()
    const onGenerateImage = vi.fn()
    render(<AiWorkspace {...buildProps({
      isImageConfigured: true,
      onSend,
      onGenerateImage
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '生成图片' }))
    fireEvent.change(screen.getByLabelText('图片尺寸'), { target: { value: '1024x1536' } })
    fireEvent.change(screen.getByLabelText('图片质量'), { target: { value: 'high' } })
    const textbox = screen.getByRole('textbox', { name: '向 AI 提问' })
    fireEvent.change(textbox, { target: { value: '生成一张知识图谱插图' } })
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter' })

    expect(onGenerateImage).toHaveBeenCalledWith({
      prompt: '生成一张知识图谱插图',
      size: '1024x1536',
      quality: 'high'
    })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the exact visible-document context and exposes scope changes', () => {
    const onContextScopeChange = vi.fn()
    render(<AiWorkspace {...buildProps({ onContextScopeChange })} />)

    expect(screen.getByText('LangGraph.pdf')).toBeInTheDocument()
    expect(screen.getByText(/第 17 页/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('基于'), { target: { value: 'project' } })
    expect(onContextScopeChange).toHaveBeenCalledWith('project')
  })

  it('keeps a captured selection visible beside the composer and exposes locate, insert, and clear actions', () => {
    const onLocateSelection = vi.fn()
    const onClearSelection = vi.fn()
    const selectionContext: ContextSnapshot = {
      ...context,
      scope: 'selection',
      selection: '路由把请求映射到处理函数。',
    }
    render(<AiWorkspace {...buildProps({
      context: selectionContext,
      contextScope: 'selection',
      onLocateSelection,
      onClearSelection,
    })} />)

    const card = screen.getByRole('region', { name: '已捕获的 AI 选中内容' })
    expect(card.querySelector('blockquote')).toHaveTextContent('路由把请求映射到处理函数。')
    expect(within(card).getByText(/LangGraph\.pdf · 13 字/u)).toBeVisible()

    const textbox = screen.getByRole('textbox', { name: '向 AI 提问' })
    fireEvent.focus(textbox)
    expect(card).toBeVisible()

    const insert = within(card).getByRole('button', { name: '将选中内容加入输入框' })
    expect(insert).toHaveAttribute('title', expect.stringContaining('⌘⇧K'))
    fireEvent.click(insert)
    expect(textbox).toHaveValue('路由把请求映射到处理函数。')

    fireEvent.click(within(card).getByRole('button', { name: '定位选中内容' }))
    expect(onLocateSelection).toHaveBeenCalledWith(selectionContext)
    fireEvent.click(within(card).getByRole('button', { name: '清除选中内容' }))
    expect(onClearSelection).toHaveBeenCalledWith(selectionContext)
  })

  it('shows keyboard shortcuts in hover titles for composer actions', () => {
    render(<AiWorkspace {...buildProps({ onCaptureScreenshot: vi.fn() })} />)

    expect(screen.getByRole('button', { name: '截图' })).toHaveAttribute('title', expect.stringContaining('⌘⇧8'))
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveAttribute('title', expect.stringContaining('Enter'))
  })

  it('keeps an unconfigured AI visibly disabled while retaining the setup action', () => {
    const onOpenSettings = vi.fn()
    render(<AiWorkspace {...buildProps({ isConfigured: false, onOpenSettings })} />)

    expect(screen.getByText('尚未配置 AI')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /配置/ }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('switches, creates and renames project-scoped sessions through callbacks', () => {
    const onSelectSession = vi.fn()
    const onNewSession = vi.fn()
    const onRenameSession = vi.fn()
    const anotherSession: ChatSession = {
      id: 'session-2',
      title: '整体理解',
      createdAt: 3,
      updatedAt: 4,
      messages: []
    }
    render(
      <AiWorkspace
        {...buildProps({
          sessions: [session, anotherSession],
          onSelectSession,
          onNewSession,
          onRenameSession
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '新建 AI 会话' }))
    expect(onNewSession).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: /Checkpointer/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /整体理解/ }))
    expect(onSelectSession).toHaveBeenCalledWith('session-2')

    fireEvent.click(screen.getByRole('button', { name: /Checkpointer/ }))
    fireEvent.click(screen.getByRole('button', { name: '重命名会话：Checkpointer' }))
    const titleInput = screen.getByRole('textbox', { name: '会话标题' })
    fireEvent.change(titleInput, { target: { value: '持久化机制' } })
    fireEvent.submit(titleInput.closest('form') as HTMLFormElement)
    expect(onRenameSession).toHaveBeenCalledWith('session-1', '持久化机制')
  })

  it('shows one low-profile navigation marker per user request with prompt summaries', () => {
    const multiTurnSession: ChatSession = { ...session, messages: conversationMessages }
    render(<AiWorkspace {...buildProps({ sessions: [multiTurnSession] })} />)

    const navigator = screen.getByRole('navigation', { name: '对话请求导航' })
    const markers = within(navigator).getAllByRole('button')

    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAccessibleName('跳转到第 1 次请求：解释 Checkpointer 如何保存状态')
    expect(markers[1]).toHaveAccessibleName('跳转到第 2 次请求：它和普通数据库事务有什么区别？')
    expect(within(navigator).getByText('第 3 次请求')).toBeInTheDocument()
  })

  it('hides request navigation until a conversation has at least two user turns', () => {
    const singleTurnSession: ChatSession = {
      ...session,
      messages: conversationMessages.slice(0, 2)
    }
    render(<AiWorkspace {...buildProps({ sessions: [singleTurnSession] })} />)

    expect(screen.queryByRole('navigation', { name: '对话请求导航' })).not.toBeInTheDocument()
  })

  it('scrolls to a request start and tracks the turn nearest the viewport top', async () => {
    const multiTurnSession: ChatSession = { ...session, messages: conversationMessages }
    const { container } = render(<AiWorkspace {...buildProps({ sessions: [multiTurnSession] })} />)
    const messages = container.querySelector('.ai-messages') as HTMLDivElement
    const first = container.querySelector('[data-message-id="user-1"]') as HTMLElement
    const second = container.querySelector('[data-message-id="user-2"]') as HTMLElement
    const third = container.querySelector('[data-message-id="user-3"]') as HTMLElement
    const scrollTo = vi.fn()

    Object.defineProperty(messages, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(first, 'offsetTop', { configurable: true, value: 40 })
    Object.defineProperty(second, 'offsetTop', { configurable: true, value: 420 })
    Object.defineProperty(third, 'offsetTop', { configurable: true, value: 820 })

    fireEvent.click(screen.getByRole('button', { name: /跳转到第 2 次请求/ }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 408, behavior: 'smooth' })

    messages.scrollTop = 440
    fireEvent.scroll(messages)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /跳转到第 2 次请求/ })).toHaveAttribute(
        'aria-current',
        'step'
      )
      expect(screen.getByRole('button', { name: /跳转到第 3 次请求/ })).not.toHaveAttribute(
        'aria-current'
      )
    })
  })
})

describe('MarkdownOperationCard', () => {
  const operation: FileOperationProposal = {
    id: 'operation-1',
    kind: 'replace',
    targetPath: 'notes/学习笔记.md',
    originalContent: '## Checkpointer\n\n旧说明',
    proposedContent: '## Checkpointer\n\n新的清晰说明',
    summary: '澄清 Checkpointer 的职责',
    status: 'pending'
  }

  it('renders target and old/new diff, and writes only after an explicit accept callback', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render(<MarkdownOperationCard operation={operation} onAccept={onAccept} onReject={onReject} />)

    const card = screen.getByRole('region', { name: 'Markdown 修改差异' }).closest('section')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByText('notes/学习笔记.md')).toBeInTheDocument()
    expect(within(card as HTMLElement).getByText('旧说明')).toBeInTheDocument()
    expect(within(card as HTMLElement).getByText('新的清晰说明')).toBeInTheDocument()
    expect(screen.getByText('确认前不会修改磁盘文件')).toBeInTheDocument()
    expect(onAccept).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '接受并写入' }))
    expect(onAccept).toHaveBeenCalledWith(operation)
  })

  it('previews every file in a multi-file note project and accepts it as one operation', () => {
    const onAccept = vi.fn()
    const batch: FileOperationProposal = {
      id: 'operation-batch',
      kind: 'create',
      targetPath: '/projects/langgraph/notes/index.md',
      proposedContent: '# LangGraph 学习项目',
      operations: [
        { kind: 'create', targetPath: '/projects/langgraph/notes/index.md', proposedContent: '# LangGraph 学习项目' },
        { kind: 'create', targetPath: '/projects/langgraph/notes/checkpointer.md', proposedContent: '# Checkpointer\n\n持久化状态。' }
      ],
      summary: '创建完整学习笔记项目',
      status: 'pending'
    }
    render(<MarkdownOperationCard operation={batch} onAccept={onAccept} onReject={vi.fn()} />)

    expect(screen.getByText('创建笔记项目 · 2 个文件')).toBeInTheDocument()
    expect(screen.getByText('index.md')).toBeInTheDocument()
    expect(screen.getByText('checkpointer.md')).toBeInTheDocument()
    expect(screen.getByText('一次确认后写入整组文件')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '接受并写入' }))
    expect(onAccept).toHaveBeenCalledWith(batch)
  })
})
