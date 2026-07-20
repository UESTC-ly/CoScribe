import clsx from 'clsx'
import {
  AlertTriangle,
  AtSign,
  ChevronDown,
  FileText,
  KeyRound,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatMessage,
  ChatSession,
  ContextScope,
  ContextSnapshot,
  FileKind,
  FileOperationProposal,
  SourceRef
} from '../../shared/types'
import { MarkdownMessage } from './MarkdownMessage'
import '../../styles/ai.css'

export interface AiProjectFileOption {
  path: string
  name: string
  kind?: FileKind
}

export interface AiSendPayload {
  content: string
  scope: ContextScope
  referencedFiles: string[]
}

export interface AiWorkspaceProps {
  projectName: string
  sessions: readonly ChatSession[]
  currentSessionId: string | null
  context: ContextSnapshot | null
  contextScope: ContextScope
  referencedFiles: readonly string[]
  availableFiles: readonly AiProjectFileOption[]
  isStreaming: boolean
  isConfigured: boolean
  error?: string | null
  applyingOperationId?: string | null
  draft?: string
  disabled?: boolean
  className?: string
  onDraftChange?: (draft: string) => void
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void | Promise<void>
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>
  onContextScopeChange: (scope: ContextScope) => void
  onReferencedFilesChange: (paths: string[]) => void
  onSend: (payload: AiSendPayload) => void | Promise<void>
  onStop: () => void | Promise<void>
  onOpenSource: (source: SourceRef) => void
  onOpenContext: (context: ContextSnapshot) => void
  onAcceptOperation: (operation: FileOperationProposal) => void | Promise<void>
  onRejectOperation: (operation: FileOperationProposal) => void | Promise<void>
  onOpenSettings?: () => void
  onDismissError?: () => void
  onRegenerateMessage?: (message: ChatMessage) => void | Promise<void>
}

const scopeOptions: Array<{
  value: ContextScope
  label: string
  description: string
}> = [
  { value: 'selection', label: '选中内容', description: '只读取当前选中的文字' },
  { value: 'visible', label: '当前内容', description: '当前页、章节或可见段落' },
  { value: 'document', label: '当前文档', description: '读取正在浏览的完整文档' },
  { value: 'project', label: '当前项目', description: '在项目中的相关文件里检索' },
  { value: 'general', label: '通用知识', description: '不以项目内容作为主要依据' }
]

function fileName(path?: string): string {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function activeContextLabel(
  context: ContextSnapshot | null,
  scope: ContextScope,
  projectName: string
): { title: string; detail: string; warning?: string } {
  if (scope === 'general') {
    return { title: '模型通用知识', detail: '回答可能没有项目内直接依据', warning: '非项目内容' }
  }
  if (scope === 'project') {
    return { title: projectName || context?.projectName || '当前项目', detail: '仅按需检索项目相关内容' }
  }

  const documentName = context?.documentName || fileName(context?.documentPath)
  if (!context || !documentName) {
    return {
      title: projectName || '当前项目',
      detail: scope === 'selection' ? '尚未选中内容' : '当前没有打开可读取的文档',
      warning: '上下文不足'
    }
  }

  if (scope === 'selection' || (scope === 'visible' && context.scope === 'selection')) {
    if (!context.selection) return { title: documentName, detail: '尚未选中内容', warning: '上下文不足' }
    return {
      title: documentName,
      detail: `已选 ${context.selection.trim().length} 字${context.pdfPage ? ` · 第 ${context.pdfPage} 页` : ''}`
    }
  }

  if (scope === 'document') {
    return { title: documentName, detail: '完整文档' }
  }

  if (context.pdfPage) {
    const visible = context.visiblePages?.filter((page) => page !== context.pdfPage)
    return {
      title: documentName,
      detail: `第 ${context.pdfPage} 页${visible?.length ? ` · 同屏 ${visible.map((page) => `第 ${page} 页`).join('、')}` : ''}`
    }
  }
  if (context.markdownHeading) return { title: documentName, detail: context.markdownHeading }
  return { title: documentName, detail: '当前可见内容' }
}

function useOutsideClose(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open, ref])
}

export function AiWorkspace({
  projectName,
  sessions,
  currentSessionId,
  context,
  contextScope,
  referencedFiles,
  availableFiles,
  isStreaming,
  isConfigured,
  error = null,
  applyingOperationId = null,
  draft,
  disabled = false,
  className,
  onDraftChange,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onContextScopeChange,
  onReferencedFilesChange,
  onSend,
  onStop,
  onOpenSource,
  onOpenContext,
  onAcceptOperation,
  onRejectOperation,
  onOpenSettings,
  onDismissError,
  onRegenerateMessage
}: AiWorkspaceProps): React.JSX.Element {
  const [localDraft, setLocalDraft] = useState('')
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false)
  const [referenceQuery, setReferenceQuery] = useState('')
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const referenceMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeSession = sessions.find((session) => session.id === currentSessionId) ?? null
  const currentDraft = draft ?? localDraft

  useOutsideClose(sessionMenuOpen, sessionMenuRef, () => setSessionMenuOpen(false))
  useOutsideClose(referenceMenuOpen, referenceMenuRef, () => setReferenceMenuOpen(false))

  const contextSummary = activeContextLabel(context, contextScope, projectName)
  const selectionAvailable = Boolean(context?.selection?.trim())
  const documentAvailable = Boolean(context?.documentPath || context?.documentName)
  const sortedSessions = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions]
  )
  const filteredFiles = useMemo(() => {
    const query = referenceQuery.trim().toLocaleLowerCase('zh-CN')
    if (!query) return availableFiles
    return availableFiles.filter((file) =>
      `${file.name} ${file.path}`.toLocaleLowerCase('zh-CN').includes(query)
    )
  }, [availableFiles, referenceQuery])

  const updateDraft = (value: string): void => {
    if (draft === undefined) setLocalDraft(value)
    onDraftChange?.(value)
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 46), 180)}px`
  }, [currentDraft])

  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [currentSessionId])

  const lastMessage = activeSession?.messages.at(-1)
  useEffect(() => {
    const container = messagesRef.current
    if (!container || !isStreaming) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom < 160 && typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [isStreaming, lastMessage?.content])

  const submit = (): void => {
    const content = currentDraft.trim()
    if (!content || isStreaming || disabled || !isConfigured || !activeSession) return
    updateDraft('')
    void onSend({ content, scope: contextScope, referencedFiles: [...referencedFiles] })
  }

  const beginRename = (session: ChatSession): void => {
    setRenamingId(session.id)
    setRenameDraft(session.title)
  }

  const commitRename = (): void => {
    if (!renamingId) return
    const title = renameDraft.trim()
    if (title) void onRenameSession(renamingId, title)
    setRenamingId(null)
  }

  const toggleReference = (path: string): void => {
    onReferencedFilesChange(
      referencedFiles.includes(path)
        ? referencedFiles.filter((candidate) => candidate !== path)
        : [...referencedFiles, path]
    )
  }

  return (
    <aside className={clsx('ai-workspace', className)} aria-label="AI 学习助手">
      <header className="ai-workspace__header">
        <div className="ai-workspace__identity">
          <span className="ai-workspace__mark"><Sparkles aria-hidden="true" /></span>
          <span><strong>学习助手</strong><small>AI · 当前项目</small></span>
        </div>
        <div className="ai-session-switcher" ref={sessionMenuRef}>
          <button
            className="ai-session-switcher__trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={sessionMenuOpen}
            onClick={() => setSessionMenuOpen((open) => !open)}
          >
            <span>{activeSession?.title ?? '选择会话'}</span>
            <ChevronDown aria-hidden="true" />
          </button>
          <button
            className="ai-icon-button"
            type="button"
            title="新建 AI 会话"
            aria-label="新建 AI 会话"
            onClick={() => void onNewSession()}
          >
            <Plus aria-hidden="true" />
          </button>

          {sessionMenuOpen && (
            <div className="ai-session-menu" role="menu" aria-label="切换会话">
              <div className="ai-session-menu__topline">
                <span>项目会话</span>
                <span>{sessions.length}</span>
              </div>
              <div className="ai-session-menu__list">
                {sortedSessions.map((session) => (
                  <div
                    className={clsx('ai-session-row', session.id === currentSessionId && 'is-active')}
                    key={session.id}
                    role="none"
                  >
                    {renamingId === session.id ? (
                      <form
                        className="ai-session-row__rename"
                        onSubmit={(event) => { event.preventDefault(); commitRename() }}
                      >
                        <input
                          value={renameDraft}
                          maxLength={60}
                          autoFocus
                          aria-label="会话标题"
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenamingId(null)
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <button
                        className="ai-session-row__select"
                        type="button"
                        role="menuitemradio"
                        aria-checked={session.id === currentSessionId}
                        onClick={() => { onSelectSession(session.id); setSessionMenuOpen(false) }}
                      >
                        <span>{session.title || '新会话'}</span>
                        <small>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(session.updatedAt)}</small>
                      </button>
                    )}
                    {renamingId !== session.id && (
                      <button
                        className="ai-session-row__edit"
                        type="button"
                        title="重命名会话"
                        aria-label={`重命名会话：${session.title}`}
                        onClick={() => beginRename(session)}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
                {sessions.length === 0 && <p className="ai-session-menu__empty">还没有会话</p>}
              </div>
              <button
                className="ai-session-menu__new"
                type="button"
                onClick={() => { setSessionMenuOpen(false); void onNewSession() }}
              >
                <MessageSquarePlus aria-hidden="true" /> 新建独立会话
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="ai-context" aria-label="当前 AI 上下文">
        <div className="ai-context__scope">
          <label htmlFor="ai-context-scope">基于</label>
          <select
            id="ai-context-scope"
            value={contextScope}
            disabled={disabled || isStreaming}
            onChange={(event) => onContextScopeChange(event.target.value as ContextScope)}
          >
            {scopeOptions.map((option) => (
              <option
                value={option.value}
                key={option.value}
                disabled={
                  (option.value === 'selection' && !selectionAvailable) ||
                  (option.value === 'document' && !documentAvailable)
                }
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className="ai-context__snapshot"
          type="button"
          disabled={!context || contextScope === 'general' || contextScope === 'project'}
          onClick={() => context && onOpenContext(context)}
          title={context ? '返回当前上下文' : undefined}
        >
          <span className="ai-context__pulse" aria-hidden="true" />
          <span><strong>{contextSummary.title}</strong><small>{contextSummary.detail}</small></span>
          {contextSummary.warning && <em>{contextSummary.warning}</em>}
        </button>
        <p className="ai-context__explain">
          {scopeOptions.find((option) => option.value === contextScope)?.description}
        </p>
      </section>

      {error && (
        <div className="ai-banner ai-banner--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>本次请求未完成</strong><small>{error}</small></span>
          {onDismissError && (
            <button type="button" aria-label="关闭错误提示" onClick={onDismissError}><X aria-hidden="true" /></button>
          )}
        </div>
      )}

      {!isConfigured && (
        <div className="ai-banner ai-banner--setup" role="status">
          <KeyRound aria-hidden="true" />
          <span><strong>尚未配置 AI</strong><small>添加 API 地址、密钥和模型后即可开始。</small></span>
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings}><Settings2 aria-hidden="true" /> 配置</button>
          )}
        </div>
      )}

      <div className="ai-messages" ref={messagesRef} aria-live="polite" aria-busy={isStreaming}>
        {!activeSession ? (
          <div className="ai-empty">
            <span className="ai-empty__glyph"><MessageSquarePlus aria-hidden="true" /></span>
            <h2>开始一个独立会话</h2>
            <p>每个会话拥有独立历史，但都能读取当前项目中你明确指定的内容。</p>
            <button className="ai-button ai-button--primary" type="button" onClick={() => void onNewSession()}>
              <Plus aria-hidden="true" /> 新建会话
            </button>
          </div>
        ) : activeSession.messages.length === 0 ? (
          <div className="ai-empty ai-empty--session">
            <span className="ai-empty__eyebrow">新会话 · {projectName}</span>
            <h2>从正在看的内容开始</h2>
            <p>可以直接问“这里是什么意思”，也可以指定文件后跨资料对比。</p>
            <div className="ai-empty__prompts">
              {['解释当前内容的核心概念', '总结这一页并列出疑问', '把学到的内容整理成笔记'].map((prompt) => (
                <button type="button" key={prompt} onClick={() => { updateDraft(prompt); textareaRef.current?.focus() }}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          activeSession.messages.map((message, index) => (
            <MarkdownMessage
              key={message.id}
              message={message}
              streaming={
                isStreaming && index === activeSession.messages.length - 1 && message.role === 'assistant'
              }
              operationBusy={message.operation?.id === applyingOperationId}
              onOpenSource={onOpenSource}
              onOpenContext={onOpenContext}
              onAcceptOperation={onAcceptOperation}
              onRejectOperation={onRejectOperation}
              onRegenerate={onRegenerateMessage}
            />
          ))
        )}
        {isStreaming && lastMessage?.role !== 'assistant' && (
          <div className="ai-stream-status" role="status">
            <Loader2 className="ai-spin" aria-hidden="true" /> 正在读取上下文并组织回答…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="ai-composer-wrap">
        {referencedFiles.length > 0 && (
          <div className="ai-references-selected" aria-label="已引用的项目文件">
            {referencedFiles.map((path) => {
              const option = availableFiles.find((file) => file.path === path)
              return (
                <span key={path} title={path}>
                  <FileText aria-hidden="true" />
                  {option?.name || fileName(path)}
                  <button type="button" aria-label={`移除引用：${option?.name || fileName(path)}`} onClick={() => toggleReference(path)}>
                    <X aria-hidden="true" />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        <div className={clsx('ai-composer', !isConfigured && 'is-disabled')}>
          <textarea
            ref={textareaRef}
            value={currentDraft}
            rows={1}
            disabled={disabled || !isConfigured || !activeSession}
            placeholder={!isConfigured ? '请先配置 AI' : activeSession ? '针对当前内容提问…' : '请先新建会话'}
            aria-label="向 AI 提问"
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="ai-composer__toolbar">
            <div className="ai-reference-picker" ref={referenceMenuRef}>
              <button
                className={clsx('ai-composer__tool', referencedFiles.length > 0 && 'is-active')}
                type="button"
                disabled={disabled || !activeSession}
                aria-haspopup="dialog"
                aria-expanded={referenceMenuOpen}
                onClick={() => setReferenceMenuOpen((open) => !open)}
              >
                <AtSign aria-hidden="true" />
                引用文件
                {referencedFiles.length > 0 && <b>{referencedFiles.length}</b>}
              </button>
              {referenceMenuOpen && (
                <div className="ai-reference-menu" role="dialog" aria-label="引用项目文件">
                  <div className="ai-reference-menu__header">
                    <strong>引用项目文件</strong>
                    <small>只会加入这一次提问的上下文</small>
                  </div>
                  <label className="ai-reference-menu__search">
                    <Search aria-hidden="true" />
                    <input
                      value={referenceQuery}
                      autoFocus
                      placeholder="按文件名或路径搜索"
                      onChange={(event) => setReferenceQuery(event.target.value)}
                    />
                  </label>
                  <div className="ai-reference-menu__list">
                    {filteredFiles.map((file) => (
                      <label className="ai-reference-option" key={file.path} title={file.path}>
                        <input
                          type="checkbox"
                          checked={referencedFiles.includes(file.path)}
                          onChange={() => toggleReference(file.path)}
                        />
                        <FileText aria-hidden="true" />
                        <span><strong>{file.name}</strong><small>{file.path}</small></span>
                      </label>
                    ))}
                    {filteredFiles.length === 0 && (
                      <p className="ai-reference-menu__empty">没有匹配的可读文件</p>
                    )}
                  </div>
                </div>
              )}
            </div>
            <span className="ai-composer__hint">Enter 发送 · Shift Enter 换行</span>
            {isStreaming ? (
              <button className="ai-composer__stop" type="button" onClick={() => void onStop()}>
                <Square aria-hidden="true" /> 停止
              </button>
            ) : (
              <button
                className="ai-composer__send"
                type="button"
                aria-label="发送消息"
                title="发送消息"
                disabled={!currentDraft.trim() || disabled || !isConfigured || !activeSession}
                onClick={submit}
              >
                <Send aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <p className="ai-composer-wrap__notice">AI 可能出错；项目来源可点击核对，文件修改需由你确认。</p>
      </footer>
    </aside>
  )
}
