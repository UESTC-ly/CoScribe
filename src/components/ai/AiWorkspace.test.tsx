// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiWorkspaceProps } from './AiWorkspace'
import { AiWorkspace } from './AiWorkspace'
import { MarkdownOperationCard } from './MarkdownOperationCard'
import type { ChatSession, ContextSnapshot, FileOperationProposal } from '../../shared/types'

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
      scope: 'document',
      referencedFiles: ['/projects/langgraph/学习笔记.md']
    })
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
})
