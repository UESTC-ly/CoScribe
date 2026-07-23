import clsx from 'clsx'
import {
  AlertTriangle,
  AtSign,
  ChevronDown,
  CornerDownLeft,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  LocateFixed,
  Loader2,
  Gauge,
  Mic,
  MessageSquarePlus,
  MessageSquareCode,
  Minimize2,
  NotebookPen,
  PanelRightClose,
  Pencil,
  Plus,
  ScanLine,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  TextQuote,
  WandSparkles,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiOperationMode,
  ChatMessage,
  ChatImageAttachment,
  ChatSession,
  ContextScope,
  ContextSnapshot,
  ContextWindowUsage,
  FileKind,
  FileOperationProposal,
  SourceRef
} from '../../shared/types'
import {
  CHAT_IMAGE_MIME_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  MAX_CHAT_IMAGE_TOTAL_BYTES,
  isChatImageMimeType,
  normalizeChatImageAttachments
} from '../../shared/chat-images'
import { ConversationTurnNavigator } from './ConversationTurnNavigator'
import { MarkdownMessage } from './MarkdownMessage'
import { useLocalSpeechInput } from './useLocalSpeechInput'
import '../../styles/ai.css'

export interface AiProjectFileOption {
  path: string
  name: string
  kind?: FileKind
}

export interface AiSendPayload {
  content: string
  attachments: ChatImageAttachment[]
  scope: ContextScope
  referencedFiles: string[]
  operationMode?: AiOperationMode
  autoApplyOperation?: boolean
}

export interface ImageGenerationPayload {
  prompt: string
  size: '1024x1024' | '1536x1024' | '1024x1536'
  quality: 'low' | 'medium' | 'high'
}

export interface AiWorkspaceProps {
  projectName: string
  sessions: readonly ChatSession[]
  currentSessionId: string | null
  context: ContextSnapshot | null
  contextScope: ContextScope
  contextUsage?: ContextWindowUsage
  manualContextCompression?: boolean
  referencedFiles: readonly string[]
  availableFiles: readonly AiProjectFileOption[]
  isStreaming: boolean
  isGeneratingImage?: boolean
  isConfigured: boolean
  isImageConfigured?: boolean
  error?: string | null
  applyingOperationId?: string | null
  capturedImage?: ChatImageAttachment | null
  draftFocusToken?: number
  draft?: string
  disabled?: boolean
  className?: string
  onDraftChange?: (draft: string) => void
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void | Promise<void>
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>
  onContextScopeChange: (scope: ContextScope) => void
  onCompactContext?: () => void
  onReferencedFilesChange: (paths: string[]) => void
  onSend: (payload: AiSendPayload) => void | Promise<void>
  onStop: () => void | Promise<void>
  onGenerateImage?: (payload: ImageGenerationPayload) => void | Promise<void>
  onStopImage?: () => void | Promise<void>
  onCaptureScreenshot?: () => void | Promise<void>
  onCapturedImageHandled?: () => void
  onQuickNote?: () => void | Promise<void>
  onOpenSource: (source: SourceRef) => void
  onOpenContext: (context: ContextSnapshot) => void
  onLocateSelection?: (context: ContextSnapshot) => void
  onClearSelection?: (context: ContextSnapshot) => void
  onAcceptOperation: (operation: FileOperationProposal) => void | Promise<void>
  onRejectOperation: (operation: FileOperationProposal) => void | Promise<void>
  onOpenSettings?: () => void
  onDismissError?: () => void
  onRegenerateMessage?: (message: ChatMessage) => void | Promise<void>
  onClose?: () => void
}

function attachmentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function extensionForMime(mimeType: ChatImageAttachment['mimeType']): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType.slice('image/'.length)
}

function fileAsAttachment(file: File, index: number): Promise<ChatImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name || index + 1}。`))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`无法读取图片 ${file.name || index + 1}。`))
        return
      }
      const mimeType = file.type as ChatImageAttachment['mimeType']
      const name = file.name.trim() || `粘贴图片-${index + 1}.${extensionForMime(mimeType)}`
      try {
        const [attachment] = normalizeChatImageAttachments([{
          id: attachmentId(),
          name,
          mimeType,
          dataUrl: reader.result,
          size: file.size
        }], { strict: true })
        resolve(attachment)
      } catch (error) {
        reject(error)
      }
    }
    reader.readAsDataURL(file)
  })
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

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return value.toLocaleString('zh-CN')
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
  contextUsage,
  manualContextCompression = false,
  referencedFiles,
  availableFiles,
  isStreaming,
  isGeneratingImage = false,
  isConfigured,
  isImageConfigured = false,
  error = null,
  applyingOperationId = null,
  capturedImage = null,
  draftFocusToken = 0,
  draft,
  disabled = false,
  className,
  onDraftChange,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onContextScopeChange,
  onCompactContext,
  onReferencedFilesChange,
  onSend,
  onStop,
  onGenerateImage,
  onStopImage,
  onCaptureScreenshot,
  onCapturedImageHandled,
  onQuickNote,
  onOpenSource,
  onOpenContext,
  onLocateSelection,
  onClearSelection,
  onAcceptOperation,
  onRejectOperation,
  onOpenSettings,
  onDismissError,
  onRegenerateMessage,
  onClose
}: AiWorkspaceProps): React.JSX.Element {
  const [localDraft, setLocalDraft] = useState('')
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false)
  const [referenceQuery, setReferenceQuery] = useState('')
  const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([])
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerMode, setComposerMode] = useState<'chat' | 'image'>('chat')
  const [imageSize, setImageSize] = useState<ImageGenerationPayload['size']>('1024x1024')
  const [imageQuality, setImageQuality] = useState<ImageGenerationPayload['quality']>('medium')
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const referenceMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeSession = sessions.find((session) => session.id === currentSessionId) ?? null
  const hasTurnNavigation = (activeSession?.messages.filter((message) => message.role === 'user').length ?? 0) >= 2
  const currentDraft = draft ?? localDraft
  const isBusy = isStreaming || isGeneratingImage

  useOutsideClose(sessionMenuOpen, sessionMenuRef, () => setSessionMenuOpen(false))
  useOutsideClose(referenceMenuOpen, referenceMenuRef, () => setReferenceMenuOpen(false))

  const contextSummary = activeContextLabel(context, contextScope, projectName)
  const capturedSelection = context?.scope === 'selection' ? context.selection?.trim() ?? '' : ''
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
  const insertCapturedSelection = (): void => {
    if (!capturedSelection) return
    updateDraft(currentDraft.trim()
      ? `${currentDraft.trimEnd()}\n\n${capturedSelection}`
      : capturedSelection)
    textareaRef.current?.focus()
  }
  const speech = useLocalSpeechInput({
    draft: currentDraft,
    onDraftChange: updateDraft,
    onError: (message) => setComposerError(message)
  })

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 46), 180)}px`
  }, [currentDraft])

  useEffect(() => {
    if (draftFocusToken > 0) textareaRef.current?.focus()
  }, [draftFocusToken])

  useEffect(() => {
    setPendingImages([])
    setComposerError(null)
    setComposerMode('chat')
  }, [currentSessionId])

  useEffect(() => {
    if (!capturedImage) return
    try {
      const next = normalizeChatImageAttachments([...pendingImages, capturedImage], { strict: true })
      setPendingImages(next)
      setComposerMode('chat')
      setComposerError(null)
      textareaRef.current?.focus()
    } catch (reason) {
      setComposerError(reason instanceof Error ? reason.message : '截图无法加入聊天。')
    } finally {
      onCapturedImageHandled?.()
    }
  // The parent clears capturedImage after delivery; pendingImages is intentionally a snapshot here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedImage?.id, onCapturedImageHandled])

  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [currentSessionId])

  const lastMessage = activeSession?.messages.at(-1)
  useEffect(() => {
    const container = messagesRef.current
    if (!container || !isBusy) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom < 160 && typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ block: 'end' })
    }
  }, [isBusy, lastMessage?.attachments?.length, lastMessage?.content])

  const submit = (): void => {
    const content = currentDraft.trim()
    if (isBusy || speech.active || disabled || !activeSession) return
    if (composerMode === 'image') {
      if (!content || !isImageConfigured || !onGenerateImage) return
      updateDraft('')
      setComposerError(null)
      void onGenerateImage({ prompt: content, size: imageSize, quality: imageQuality })
      return
    }
    if ((!content && pendingImages.length === 0) || !isConfigured) return
    const attachments = pendingImages.map((attachment) => ({ ...attachment }))
    updateDraft('')
    setPendingImages([])
    setComposerError(null)
    void onSend({ content, attachments, scope: contextScope, referencedFiles: [...referencedFiles] })
  }

  const addImages = async (files: readonly File[]): Promise<void> => {
    const imageFiles = files.filter((file) => isChatImageMimeType(file.type))
    if (imageFiles.length !== files.length) {
      setComposerError('仅支持 PNG、JPEG、WebP 和非动态 GIF 图片。')
      return
    }
    if (pendingImages.length + imageFiles.length > MAX_CHAT_IMAGES_PER_MESSAGE) {
      setComposerError(`每条消息最多发送 ${MAX_CHAT_IMAGES_PER_MESSAGE} 张图片。`)
      return
    }
    const oversized = imageFiles.find((file) => file.size > MAX_CHAT_IMAGE_BYTES)
    if (oversized) {
      setComposerError(`单张图片不能超过 ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB：${oversized.name || '粘贴图片'}`)
      return
    }
    try {
      const attachments = await Promise.all(imageFiles.map(fileAsAttachment))
      const nextImages = [...pendingImages, ...attachments]
      const total = nextImages.reduce((sum, attachment) => sum + attachment.size, 0)
      if (total > MAX_CHAT_IMAGE_TOTAL_BYTES) {
        setComposerError(`每条消息的图片总大小不能超过 ${MAX_CHAT_IMAGE_TOTAL_BYTES / 1024 / 1024} MB。`)
        return
      }
      setPendingImages(nextImages)
      setComposerError(null)
      setComposerMode('chat')
      textareaRef.current?.focus()
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : '图片读取失败。')
    }
  }

  const pasteImages = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => item.getAsFile() ?? [])
    if (!files.length) return
    event.preventDefault()
    const pastedText = event.clipboardData.getData('text/plain')
    if (pastedText) {
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      updateDraft(`${currentDraft.slice(0, start)}${pastedText}${currentDraft.slice(end)}`)
    }
    void addImages(files)
  }

  const toggleImageMode = (): void => {
    if (composerMode === 'image') {
      setComposerMode('chat')
      setComposerError(null)
      return
    }
    if (!isImageConfigured || !onGenerateImage) {
      setComposerError('请先在设置中配置 GPT-Image 2 的请求地址和 API Key。')
      onOpenSettings?.()
      return
    }
    if (pendingImages.length) {
      setComposerError('请先发送或移除已粘贴的图片，再切换到生成图片模式。')
      return
    }
    setComposerMode('image')
    setComposerError(null)
    textareaRef.current?.focus()
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
          <button
            className="ai-icon-button"
            type="button"
            title="编辑系统提示词"
            aria-label="编辑系统提示词"
            onClick={() => onOpenSettings?.()}
          >
            <MessageSquareCode aria-hidden="true" />
          </button>
          {onClose && (
            <button
              className="ai-icon-button"
              type="button"
              title="收起 AI 侧栏"
              aria-label="收起 AI 侧栏"
              onClick={onClose}
            >
              <PanelRightClose aria-hidden="true" />
            </button>
          )}

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
            disabled={disabled || isBusy}
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
        {contextUsage && (
          <div className={clsx('ai-context-budget', `is-${contextUsage.status}`)}>
            <div className="ai-context-budget__header">
              <span>
                <Gauge aria-hidden="true" />
                <strong>{formatTokenCount(contextUsage.estimatedInputTokens)}</strong>
                <small>/ {formatTokenCount(contextUsage.maximumInputTokens)} 预估输入</small>
              </span>
              {onCompactContext && activeSession && activeSession.messages.length > 2 && (
                <button
                  type="button"
                  className={clsx(manualContextCompression && 'is-active')}
                  disabled={isBusy}
                  onClick={onCompactContext}
                  title="只压缩下次发送给模型的早期会话；界面原始聊天不会删除"
                >
                  <Minimize2 aria-hidden="true" />
                  {manualContextCompression ? '已启用压缩' : '压缩早期历史'}
                </button>
              )}
            </div>
            <div
              className="ai-context-budget__track"
              role="progressbar"
              aria-label="上下文窗口占用"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextUsage.percent}
            >
              <span style={{ width: `${contextUsage.percent}%` }} />
            </div>
            <p>
              {contextUsage.compactedMessageCount > 0
                ? `请求快照已压缩 ${contextUsage.compactedMessageCount} 条早期消息`
                : `为回答预留 ${formatTokenCount(contextUsage.outputReserveTokens)} tokens`}
              {contextUsage.truncated ? ' · 超长内容已安全截断' : ''}
            </p>
          </div>
        )}
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

      <div className={clsx('ai-messages-shell', hasTurnNavigation && 'ai-messages-shell--navigable')}>
        <div className="ai-messages" ref={messagesRef} aria-live="polite" aria-busy={isBusy}>
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
          {isGeneratingImage && (
            <div className="ai-stream-status" role="status">
              <Loader2 className="ai-spin" aria-hidden="true" />
              GPT-Image 2 正在生成图片…
            </div>
          )}
          {isStreaming && lastMessage?.role !== 'assistant' && (
            <div className="ai-stream-status" role="status">
              <Loader2 className="ai-spin" aria-hidden="true" />
              正在读取上下文并组织回答…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {activeSession && (
          <ConversationTurnNavigator
            key={activeSession.id}
            messages={activeSession.messages}
            scrollContainerRef={messagesRef}
          />
        )}
      </div>

      <footer className="ai-composer-wrap">
        {composerMode === 'chat' && context && capturedSelection && (
          <section className="ai-selection-context" role="region" aria-label="已捕获的 AI 选中内容">
            <header>
              <span className="ai-selection-context__icon"><TextQuote aria-hidden="true" /></span>
              <span className="ai-selection-context__identity">
                <strong>AI 选中内容</strong>
                <small>{context.documentName || fileName(context.documentPath) || '当前内容'} · {capturedSelection.length} 字</small>
              </span>
              <span className="ai-selection-context__actions">
                <button
                  type="button"
                  aria-label="定位选中内容"
                  title="定位到原文"
                  onClick={() => (onLocateSelection ?? onOpenContext)(context)}
                >
                  <LocateFixed aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="将选中内容加入输入框"
                  title="将选中内容加入输入框（⌘⇧K / Ctrl+Shift+K）"
                  onClick={insertCapturedSelection}
                >
                  <CornerDownLeft aria-hidden="true" />
                </button>
                {onClearSelection && (
                  <button
                    type="button"
                    aria-label="清除选中内容"
                    title="清除此条 AI 上下文"
                    onClick={() => onClearSelection(context)}
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </span>
            </header>
            <blockquote>“{capturedSelection.slice(0, 180)}{capturedSelection.length > 180 ? '…' : ''}”</blockquote>
          </section>
        )}
        {pendingImages.length > 0 && (
          <div className="ai-images-selected" aria-label="待发送图片">
            {pendingImages.map((attachment) => (
              <figure key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} />
                <figcaption title={attachment.name}>{attachment.name}</figcaption>
                <button
                  type="button"
                  aria-label={`移除图片：${attachment.name}`}
                  onClick={() => setPendingImages((current) => current.filter((item) => item.id !== attachment.id))}
                >
                  <X aria-hidden="true" />
                </button>
              </figure>
            ))}
          </div>
        )}
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

        {composerError && <p className="ai-composer__error" role="alert">{composerError}</p>}
        <div className={clsx('ai-composer', composerMode === 'image' && 'is-image-mode', composerMode === 'chat' && !isConfigured && 'is-disabled')}>
          {composerMode === 'image' && (
            <div className="ai-image-options" aria-label="图片生成选项">
              <span><WandSparkles aria-hidden="true" /> GPT-Image 2</span>
              <label>
                <span className="sr-only">图片尺寸</span>
                <select value={imageSize} onChange={(event) => setImageSize(event.target.value as ImageGenerationPayload['size'])}>
                  <option value="1024x1024">方形 · 1024</option>
                  <option value="1536x1024">横向 · 1536×1024</option>
                  <option value="1024x1536">纵向 · 1024×1536</option>
                </select>
              </label>
              <label>
                <span className="sr-only">图片质量</span>
                <select value={imageQuality} onChange={(event) => setImageQuality(event.target.value as ImageGenerationPayload['quality'])}>
                  <option value="low">草稿</option>
                  <option value="medium">标准</option>
                  <option value="high">高质量</option>
                </select>
              </label>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={currentDraft}
            rows={1}
            disabled={disabled || !activeSession || (composerMode === 'chat' ? !isConfigured : !isImageConfigured)}
            readOnly={speech.active}
            placeholder={
              composerMode === 'image'
                ? (isImageConfigured ? '描述想生成的图片…' : '请先配置 GPT-Image 2')
                : speech.active ? '正在本地实时转写；再次点击麦克风结束…' : !isConfigured ? '请先配置 AI' : activeSession ? '针对当前内容提问，也可直接粘贴图片…' : '请先新建会话'
            }
            aria-label="向 AI 提问"
            onChange={(event) => updateDraft(event.target.value)}
            onPaste={pasteImages}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="ai-composer__toolbar">
            <input
              ref={imageInputRef}
              className="sr-only"
              type="file"
              accept={CHAT_IMAGE_MIME_TYPES.join(',')}
              multiple
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length) void addImages(files)
              }}
            />
            <button
              className={clsx('ai-composer__tool', speech.active && 'is-active is-recording')}
              type="button"
              disabled={disabled || !activeSession || isBusy || composerMode === 'image' || speech.phase === 'stopping'}
              aria-label={speech.active ? '停止语音输入' : '开始语音输入'}
              aria-pressed={speech.active}
              title={speech.active ? '停止本地语音转写' : '本地实时语音转文字'}
              onClick={() => void (speech.active ? speech.stop() : speech.start())}
            >
              {speech.active && speech.phase !== 'listening' ? <Loader2 className="ai-spin" aria-hidden="true" /> : <Mic aria-hidden="true" />}
              <span className="ai-composer__tool-label">{speech.phase === 'listening' ? '聆听中' : '语音'}</span>
            </button>
            <button
              className={clsx('ai-composer__tool', pendingImages.length > 0 && 'is-active')}
              type="button"
              disabled={disabled || !activeSession || isBusy || speech.active}
              aria-label="添加图片"
              title="添加图片（也可直接粘贴）"
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus aria-hidden="true" />
              <span className="ai-composer__tool-label">图片</span>
              {pendingImages.length > 0 && <b>{pendingImages.length}</b>}
            </button>
            <button
              className="ai-composer__tool"
              type="button"
              disabled={disabled || !activeSession || isBusy || speech.active}
              aria-label="截图"
              title="框选屏幕区域并加入聊天（⌘⇧8 / Ctrl+Shift+8；Esc 取消）"
              onClick={() => void onCaptureScreenshot?.()}
            >
              <ScanLine aria-hidden="true" />
              <span className="ai-composer__tool-label">截图</span>
            </button>
            <button
              className={clsx('ai-composer__tool', composerMode === 'image' && 'is-active')}
              type="button"
              disabled={disabled || !activeSession || isBusy || speech.active}
              aria-label="生成图片"
              aria-pressed={composerMode === 'image'}
              title="切换到 GPT-Image 2 图片生成"
              onClick={toggleImageMode}
            >
              <ImageIcon aria-hidden="true" />
              <span className="ai-composer__tool-label">生成图片</span>
            </button>
            <div className="ai-reference-picker" ref={referenceMenuRef}>
              <button
                className={clsx('ai-composer__tool', referencedFiles.length > 0 && 'is-active')}
                type="button"
                disabled={disabled || !activeSession || isBusy || speech.active || composerMode === 'image'}
                aria-label="引用文件"
                aria-haspopup="dialog"
                aria-expanded={referenceMenuOpen}
                title="引用当前项目中的文件"
                onClick={() => setReferenceMenuOpen((open) => !open)}
              >
                <AtSign aria-hidden="true" />
                <span className="ai-composer__tool-label">引用文件</span>
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
            <button
              className="ai-composer__tool ai-composer__tool--note"
              type="button"
              disabled={disabled || !activeSession || activeSession.messages.length === 0 || isBusy || speech.active || !isConfigured || composerMode === 'image'}
              aria-label="整理笔记"
              title="将当前会话整理成 Markdown 笔记并保存到本地"
              onClick={() => void onQuickNote?.()}
            >
              <NotebookPen aria-hidden="true" />
              <span className="ai-composer__tool-label">整理笔记</span>
            </button>
            <span className="ai-composer__hint">{composerMode === 'image' ? 'Enter 生成 · Shift Enter 换行' : 'Enter 发送 · Shift Enter 换行'}</span>
            {isBusy ? (
              <button className="ai-composer__stop" type="button" onClick={() => void (isGeneratingImage ? onStopImage?.() : onStop())}>
                <Square aria-hidden="true" /> 停止
              </button>
            ) : (
              <button
                className="ai-composer__send"
                type="button"
                aria-label={composerMode === 'image' ? '生成图片' : '发送消息'}
                title={composerMode === 'image' ? '生成图片（Enter）' : '发送消息（Enter）'}
                disabled={
                  disabled || !activeSession || speech.active ||
                  (composerMode === 'image'
                    ? !currentDraft.trim() || !isImageConfigured
                    : (!currentDraft.trim() && pendingImages.length === 0) || !isConfigured)
                }
                onClick={submit}
              >
                {composerMode === 'image' ? <WandSparkles aria-hidden="true" /> : <Send aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>
        <p className="ai-composer-wrap__notice">
          {composerMode === 'image' ? '图片生成会消耗独立的 GPT-Image 2 额度。' : '普通文件修改需确认；点击“整理笔记”会在生成后直接保存。'}
        </p>
      </footer>
    </aside>
  )
}
