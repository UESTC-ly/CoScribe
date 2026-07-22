// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiWorkspaceProps } from './AiWorkspace'
import { AiWorkspace } from './AiWorkspace'
import { MarkdownOperationCard } from './MarkdownOperationCard'
import type { ChatImageAttachment, ChatSession, ContextSnapshot, FileOperationProposal } from '../../shared/types'

afterEach(cleanup)

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
