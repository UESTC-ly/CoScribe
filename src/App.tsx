import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Columns2,
  Columns3,
  FileCheck2,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Settings as SettingsIcon
} from 'lucide-react'
import { AiWorkspace, type AiSendPayload } from './components/ai'
import {
  ActivityRail,
  ConfirmDialog,
  Dialog,
  EditorPane,
  HomeScreen,
  ModelSwitcher,
  ProjectNavigator,
  SettingsDialog
} from './components/shell'
import type { MarkdownSaveRequest, PdfTextSelection } from './components/viewers'
import {
  clampAiPanelWidth,
  clampProjectNavigatorWidth,
  maximumAiPanelWidth,
  PANEL_LAYOUT
} from './lib/panel-layout'
import {
  appStore,
  selectActiveDocument,
  selectActiveTab,
  selectCurrentSession,
  selectDirtyDocuments,
  useAppStore
} from './store'
import type {
  AiStreamEvent,
  Annotation,
  AppSettings,
  ChatMessage,
  ContextScope,
  ContextSnapshot,
  FileKind,
  FileNode,
  FileOperationProposal,
  OpenTab,
  PaneId,
  ProjectInfo,
  SearchResult,
  SourceRef
} from './shared/types'
import { DEFAULT_SETTINGS } from './shared/types'
import './styles/shell.css'

interface PromptState {
  title: string
  description: string
  label: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  onSubmit: (value: string) => Promise<void> | void
}

interface ConfirmState {
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}

interface ActiveAiRequest {
  requestId: string
  sessionId: string
  assistantMessageId: string
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function inferKind(path: string): Exclude<FileKind, 'folder'> {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext ?? '')) return 'image'
  if (['txt', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml'].includes(ext ?? '')) return 'text'
  return 'unsupported'
}

function flattenFiles(nodes: readonly FileNode[]): FileNode[] {
  const result: FileNode[] = []
  const walk = (items: readonly FileNode[]): void => {
    for (const item of items) {
      if (item.kind !== 'folder') result.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(nodes)
  return result
}

function findNode(nodes: readonly FileNode[], path: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const nested = findNode(node.children, path)
      if (nested) return nested
    }
  }
  return undefined
}

function isAiConfigured(settings: AppSettings): boolean {
  if (!settings.baseUrl.trim() || !settings.model.trim()) return false
  try {
    const host = new URL(settings.baseUrl).hostname
    return settings.hasApiKey || host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

function resolvedTheme(settings: AppSettings): 'light' | 'dark' {
  if (settings.theme !== 'system') return settings.theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App(): React.JSX.Element {
  const state = useAppStore()
  const [booting, setBooting] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [streamingRequestId, setStreamingRequestId] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [applyingOperationId, setApplyingOperationId] = useState<string | null>(null)
  const [contextScope, setContextScope] = useState<ContextScope>(DEFAULT_SETTINGS.defaultContextScope)
  const [resizing, setResizing] = useState<'left' | 'ai' | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const activeRequests = useRef(new Map<string, ActiveAiRequest>())
  const hydratedProjectPath = useRef<string | null>(null)
  const refreshTimer = useRef<number | null>(null)

  const setStore = appStore.getState

  useEffect(() => {
    const updateViewportWidth = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  const hydrateProject = useCallback(async (project: ProjectInfo): Promise<void> => {
    setHydrated(false)
    setError(null)
    try {
      // Load the real file tree before mounting the workspace. A slow recursive
      // scan should not briefly look like an empty project, and a broken metadata
      // file must not hide otherwise readable user files.
      const [treeResult, workspaceResult, sessionsResult, annotationsResult] = await Promise.allSettled([
        window.coscribe.project.tree(),
        window.coscribe.project.getState(),
        window.coscribe.sessions.list(),
        window.coscribe.annotations.list()
      ])
      if (treeResult.status === 'rejected') throw treeResult.reason

      const tree = treeResult.value
      const store = setStore()
      store.setProject(project, tree)

      const warnings: string[] = []
      if (workspaceResult.status === 'fulfilled') {
        store.restoreWorkspace(workspaceResult.value, { existingPaths: flattenFiles(tree).map((item) => item.path) })
      } else {
        warnings.push('工作区状态无法恢复，已使用默认布局。')
      }
      if (sessionsResult.status === 'fulfilled') store.setSessions(sessionsResult.value)
      else warnings.push('会话历史无法恢复，文件内容不受影响。')
      if (annotationsResult.status === 'fulfilled') store.setAnnotations(annotationsResult.value)
      else warnings.push('标注无法恢复，文件内容不受影响。')

      const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : []
      if (!sessions.length) store.createSession()
      const activeTabs = store.workspace.tabs.filter((tab) => !tab.missing)
      await Promise.all(activeTabs.map(async (tab) => {
        try { store.loadDocument(await window.coscribe.file.read(tab.path)) } catch { store.markPathMissing(tab.path) }
      }))
      hydratedProjectPath.current = project.path
      setHydrated(true)
      if (warnings.length) setError(warnings.join(' '))
    } catch (reason) {
      await window.coscribe.project.close().catch(() => undefined)
      setStore().closeProject()
      hydratedProjectPath.current = null
      setError(reason instanceof Error ? reason.message : '无法恢复项目状态。原始文件不会受到影响。')
      setHydrated(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [recent, settings, initial] = await Promise.all([
          window.coscribe.project.recent(),
          window.coscribe.settings.get(),
          window.coscribe.project.initial()
        ])
        if (!alive) return
        setStore().setRecentProjects(recent)
        setStore().setSettings(settings)
        setContextScope(settings.defaultContextScope)
        if (initial) await hydrateProject(initial)
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : '应用初始化失败')
      } finally {
        if (alive) setBooting(false)
      }
    })()
    return () => { alive = false }
  }, [hydrateProject])

  useEffect(() => {
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = resolvedTheme(state.settings)
      document.documentElement.style.fontSize = `${state.settings.fontSize}px`
    }
    applyTheme()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [state.settings])

  useEffect(() => {
    if (!state.project || !hydrated || hydratedProjectPath.current !== state.project.path) return
    const timer = window.setTimeout(() => void window.coscribe.project.saveState(setStore().serializeWorkspace()).catch((reason) => setError(reason instanceof Error ? reason.message : '工作区状态保存失败')), 450)
    return () => window.clearTimeout(timer)
  }, [state.project, state.workspace, hydrated])

  useEffect(() => {
    if (!state.project || !hydrated) return
    const timer = window.setTimeout(() => void window.coscribe.sessions.save(appStore.getState().sessions).catch((reason) => setError(reason instanceof Error ? reason.message : '会话保存失败')), 350)
    return () => window.clearTimeout(timer)
  }, [state.project, state.sessions, hydrated])

  useEffect(() => {
    if (!state.project || !hydrated) return
    const timer = window.setTimeout(() => void window.coscribe.annotations.save(appStore.getState().annotations).catch((reason) => setError(reason instanceof Error ? reason.message : '标注保存失败')), 350)
    return () => window.clearTimeout(timer)
  }, [state.project, state.annotations, hydrated])

  const refreshTree = useCallback(async (): Promise<void> => {
    try { setStore().setFileTree(await window.coscribe.project.tree()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '文件树刷新失败') }
  }, [])

  useEffect(() => {
    if (!state.project) return
    return window.coscribe.project.onFilesChanged((events) => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => void refreshTree(), 120)
      for (const event of events) {
        if (event.type === 'unlink' || event.type === 'unlinkDir') setStore().markPathMissing(event.path)
        if (event.type === 'change' && appStore.getState().documents[event.path]) {
          void window.coscribe.file.read(event.path).then((result) => setStore().loadDocument(result)).catch(() => setStore().markPathMissing(event.path))
        }
      }
    })
  }, [state.project, refreshTree])

  useEffect(() => window.coscribe.search.onProgress((progress) => setStore().setSearchProgress(progress)), [])

  useEffect(() => window.coscribe.ai.onStream((event: AiStreamEvent) => {
    const request = activeRequests.current.get(event.requestId)
    if (!request) return
    const store = setStore()
    if (event.type === 'delta') {
      store.updateMessage(request.sessionId, request.assistantMessageId, (message) => ({ ...message, content: message.content + event.text }))
      return
    }
    if (event.type === 'done') {
      store.updateMessage(request.sessionId, request.assistantMessageId, { sources: event.sources, operation: event.operation })
      const session = appStore.getState().sessions.find((item) => item.id === request.sessionId)
      if (session?.title === '新会话' && appStore.getState().settings.autoTitle) {
        const firstQuestion = session.messages.find((message) => message.role === 'user')?.content ?? '学习会话'
        store.renameSession(session.id, firstQuestion.replace(/[#*_`]/g, '').slice(0, 20))
      }
    } else if (event.type === 'stopped') {
      store.updateMessage(request.sessionId, request.assistantMessageId, { stopped: true })
    } else if (event.type === 'error') {
      store.updateMessage(request.sessionId, request.assistantMessageId, { error: event.message })
      setAiError(event.message)
    }
    if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
      activeRequests.current.delete(event.requestId)
      setStreamingRequestId((current) => current === event.requestId ? null : current)
    }
  }), [])

  const openProject = useCallback(async (loader: () => Promise<ProjectInfo | null>): Promise<void> => {
    setBooting(true)
    try {
      const project = await loader()
      if (project) await hydrateProject(project)
      setStore().setRecentProjects(await window.coscribe.project.recent())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开项目')
    } finally {
      setBooting(false)
    }
  }, [hydrateProject])

  const ensureDocument = useCallback(async (tab: OpenTab): Promise<void> => {
    if (appStore.getState().documents[tab.path]) return
    try {
      setStore().loadDocument(await window.coscribe.file.read(tab.path))
    } catch (reason) {
      if ((reason as { code?: string })?.code === 'ENOENT' || /(?:不存在|移动或删除|ENOENT)/iu.test(String(reason))) {
        setStore().markPathMissing(tab.path)
      }
      setError(reason instanceof Error ? reason.message : `无法打开 ${tab.name}`)
    }
  }, [])

  const openNode = useCallback((node: FileNode, location?: { page?: number; line?: number }): void => {
    if (node.kind === 'folder') return
    const tab: OpenTab = { id: `tab:${node.path}`, path: node.path, name: node.name, kind: node.kind }
    setStore().openTab(tab)
    if (node.kind === 'pdf' && location?.page) setStore().updatePdfState(node.path, { page: location.page })
    if (node.kind === 'markdown' && location?.line) {
      const content = appStore.getState().documents[node.path]?.content
      if (content) {
        const lines = content.split('\n').slice(0, Math.max(0, location.line - 1))
        setStore().updateMarkdownState(node.path, { cursor: lines.join('\n').length + Math.max(0, lines.length - 1) })
      }
    }
    void ensureDocument(tab)
  }, [ensureDocument])

  const openPath = useCallback((path: string, kind?: Exclude<FileKind, 'folder'>, location?: { page?: number; line?: number }): void => {
    const node = findNode(appStore.getState().fileTree, path)
    openNode(node ?? { name: fileName(path), path, kind: kind ?? inferKind(path), size: 0, modifiedAt: 0 }, location)
  }, [openNode])

  const runPrompt = useCallback((config: PromptState): void => {
    setPromptValue(config.initialValue ?? '')
    setPrompt(config)
  }, [])

  const closeProjectNow = useCallback(async (): Promise<void> => {
    try {
      await Promise.all([
        window.coscribe.project.saveState(setStore().serializeWorkspace()),
        window.coscribe.sessions.save(appStore.getState().sessions),
        window.coscribe.annotations.save(appStore.getState().annotations)
      ])
      await window.coscribe.project.close()
      setStore().closeProject()
      hydratedProjectPath.current = null
      setHydrated(false)
      setStore().setRecentProjects(await window.coscribe.project.recent())
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法关闭项目') }
  }, [])

  const saveMarkdown = useCallback(async (tab: OpenTab, request: MarkdownSaveRequest) => {
    try {
      const result = await window.coscribe.file.saveMarkdown(tab.path, request.content, request.expectedModifiedAt)
      setStore().markDocumentSaved(result)
      return result
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存失败，当前修改仍保留在编辑器中。'
      setError(message)
      throw reason
    }
  }, [])

  const requestCloseProject = useCallback((): void => {
    const dirty = selectDirtyDocuments(appStore.getState())
    if (!dirty.length) { void closeProjectNow(); return }
    setConfirm({
      title: '保存修改并返回首页？',
      description: `${dirty.length} 个 Markdown 文件尚未保存。应用不会丢弃这些修改。`,
      confirmLabel: '保存并返回',
      onConfirm: async () => {
        for (const document of dirty) {
          await window.coscribe.file.saveMarkdown(document.path, document.content, document.modifiedAt).then((result) => setStore().markDocumentSaved(result))
        }
        setConfirm(null)
        await closeProjectNow()
      }
    })
  }, [closeProjectNow])

  const requestCloseTab = useCallback((tabId: string): void => {
    const store = appStore.getState()
    const tab = store.workspace.tabs.find((item) => item.id === tabId)
    const document = tab ? store.documents[tab.path] : undefined
    if (!tab || !document?.dirty) { store.closeTab(tabId); return }
    setConfirm({
      title: `保存 ${tab.name}？`,
      description: '关闭前会先保存到磁盘；如果磁盘文件已被外部修改，操作会被阻止。',
      confirmLabel: '保存并关闭',
      onConfirm: async () => {
        await window.coscribe.file.saveMarkdown(tab.path, document.content, document.modifiedAt).then((result) => setStore().markDocumentSaved(result))
        setStore().closeTab(tabId)
        setConfirm(null)
      }
    })
  }, [])

  const submitPrompt = async (): Promise<void> => {
    const active = prompt
    const value = promptValue.trim()
    if (!active || !value) return
    try { await active.onSubmit(value); setPrompt(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') }
  }

  const createMarkdown = (): void => runPrompt({
    title: '新建 Markdown', description: '文件会直接创建在当前项目中。可输入相对文件夹路径。', label: '文件路径', placeholder: '学习笔记.md', confirmLabel: '创建',
    onSubmit: async (value) => {
      const path = /\.md$/i.test(value) ? value : `${value}.md`
      const result = await window.coscribe.file.createMarkdown(path)
      await refreshTree()
      openPath(result.path, 'markdown')
    }
  })

  const createFolder = (): void => runPrompt({
    title: '新建文件夹', description: '可输入相对于项目根目录的路径。', label: '文件夹路径', placeholder: 'notes', confirmLabel: '创建',
    onSubmit: async (value) => { await window.coscribe.file.createFolder(value); await refreshTree() }
  })

  const renameNode = (node: FileNode): void => runPrompt({
    title: `重命名 ${node.name}`, description: '只修改名称，不会改变文件内容。', label: '新名称', initialValue: node.name, confirmLabel: '重命名',
    onSubmit: async (value) => { const nextPath = await window.coscribe.file.rename(node.path, value); setStore().markPathMissing(node.path); await refreshTree(); if (node.kind !== 'folder') openPath(nextPath, node.kind) }
  })

  const moveNode = (node: FileNode): void => runPrompt({
    title: `移动 ${node.name}`, description: '输入目标文件夹相对路径；留在项目内部。', label: '目标文件夹', placeholder: 'notes/chapters', confirmLabel: '移动',
    onSubmit: async (value) => { const nextPath = await window.coscribe.file.move(node.path, value); setStore().markPathMissing(node.path); await refreshTree(); if (node.kind !== 'folder') openPath(nextPath, node.kind) }
  })

  const trashNode = (node: FileNode): void => setConfirm({
    title: `将 ${node.name} 移到废纸篓？`,
    description: '文件不会被永久删除，可以从系统废纸篓恢复。已打开的标签会保留为失效状态。',
    confirmLabel: '移到废纸篓', danger: true,
    onConfirm: async () => { await window.coscribe.file.trash(node.path); setStore().markPathMissing(node.path); setConfirm(null); await refreshTree() }
  })

  const importFiles = useCallback(async (files: File[], targetFolder: string): Promise<void> => {
    try {
      const paths = files.map((file) => window.coscribe.file.pathForDroppedFile(file)).filter(Boolean)
      await window.coscribe.file.importFiles(paths, targetFolder)
      await refreshTree()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法导入文件') }
  }, [refreshTree])

  const movePath = useCallback(async (path: string, targetFolder: string): Promise<void> => {
    if (path === targetFolder || targetFolder.startsWith(`${path}/`)) return
    try { await window.coscribe.file.move(path, targetFolder); await refreshTree() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法移动文件') }
  }, [refreshTree])

  const search = useCallback(async (query: string): Promise<void> => {
    const previous = appStore.getState().searchProgress?.requestId
    if (previous) void window.coscribe.search.cancel(previous)
    const requestId = makeId('search')
    setStore().setSearchQuery(query)
    setStore().setSearchResults([])
    if (!query) { setStore().setSearchProgress(null); return }
    setStore().setSearchProgress({ requestId, scanned: 0, done: false })
    try { setStore().setSearchResults(await window.coscribe.search.query(requestId, query)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '搜索失败') }
  }, [])

  const openSearchResult = (result: SearchResult): void => {
    if (result.type === 'session' && result.sessionId) {
      setStore().setCurrentSession(result.sessionId)
      setStore().setAiVisible(true)
      return
    }
    if (result.path) openPath(result.path, result.kind === 'folder' ? undefined : result.kind, { page: result.page, line: result.line })
  }

  const openSource = (source: SourceRef): void => {
    if (source.kind === 'session') return
    if (source.kind === 'general') return
    openPath(
      source.path,
      source.kind === 'pdf' || source.kind === 'markdown' || source.kind === 'docx' || source.kind === 'image'
        ? source.kind
        : 'text',
      { page: source.page, line: source.line }
    )
  }

  const openContext = (context: ContextSnapshot): void => {
    if (!context.documentPath) return
    openPath(context.documentPath, context.kind === 'folder' ? undefined : context.kind, { page: context.pdfPage })
  }

  const sendAiMessage = useCallback(async (payload: AiSendPayload): Promise<void> => {
    const store = setStore()
    let sessionId = store.workspace.currentSessionId
    if (!sessionId) sessionId = store.createSession()
    store.setReferencedFiles(payload.referencedFiles)
    const context = setStore().captureActiveContext(payload.scope)
    if (!context || !state.project) return
    context.referencedFiles = [...payload.referencedFiles]
    const requestId = makeId('ai')
    const userMessage: ChatMessage = { id: makeId('message'), role: 'user', content: payload.content, createdAt: Date.now(), context }
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: Date.now() + 1 }
    const history = appStore.getState().sessions.find((session) => session.id === sessionId)?.messages ?? []
    store.addMessage(sessionId, userMessage)
    store.addMessage(sessionId, assistantMessage)
    activeRequests.current.set(requestId, { requestId, sessionId, assistantMessageId: assistantMessage.id })
    setStreamingRequestId(requestId)
    setAiError(null)
    try {
      await window.coscribe.ai.start({
        requestId,
        sessionId,
        messages: [...history, userMessage].filter((message) => message.role !== 'system').map(({ role, content }) => ({ role, content })),
        context,
        settings: { allowGeneralKnowledge: state.settings.allowGeneralKnowledge }
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'AI 请求无法启动'
      store.updateMessage(sessionId, assistantMessage.id, { error: message })
      activeRequests.current.delete(requestId)
      setStreamingRequestId(null)
      setAiError(message)
    }
  }, [state.project, state.settings.allowGeneralKnowledge])

  const stopAi = useCallback(async (): Promise<void> => {
    if (streamingRequestId) await window.coscribe.ai.stop(streamingRequestId)
  }, [streamingRequestId])

  const regenerateAiMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    if (streamingRequestId) return
    const store = setStore()
    const session = appStore.getState().sessions.find((item) => item.messages.some((candidate) => candidate.id === message.id))
    if (!session) return
    const messageIndex = session.messages.findIndex((candidate) => candidate.id === message.id)
    const history = session.messages.slice(0, messageIndex)
    const question = [...history].reverse().find((candidate) => candidate.role === 'user' && candidate.context)
    if (!question?.context) {
      setAiError('找不到这条回答发送时的上下文，无法重新生成。')
      return
    }

    const requestId = makeId('ai')
    store.updateMessage(session.id, message.id, {
      content: '',
      sources: undefined,
      operation: undefined,
      stopped: undefined,
      error: undefined
    })
    activeRequests.current.set(requestId, { requestId, sessionId: session.id, assistantMessageId: message.id })
    setStreamingRequestId(requestId)
    setAiError(null)
    try {
      await window.coscribe.ai.start({
        requestId,
        sessionId: session.id,
        messages: history
          .filter((candidate) => candidate.role !== 'system')
          .map(({ role, content }) => ({ role, content })),
        context: question.context,
        settings: { allowGeneralKnowledge: appStore.getState().settings.allowGeneralKnowledge }
      })
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : '无法重新生成回答'
      store.updateMessage(session.id, message.id, { error: errorMessage })
      activeRequests.current.delete(requestId)
      setStreamingRequestId(null)
      setAiError(errorMessage)
    }
  }, [streamingRequestId])

  const updateOperation = useCallback((operationId: string, patch: Partial<FileOperationProposal>): void => {
    const store = appStore.getState()
    for (const session of store.sessions) {
      const message = session.messages.find((item) => item.operation?.id === operationId)
      if (message?.operation) {
        store.updateMessage(session.id, message.id, { operation: { ...message.operation, ...patch } })
        return
      }
    }
  }, [])

  const acceptOperation = useCallback(async (operation: FileOperationProposal): Promise<void> => {
    setApplyingOperationId(operation.id)
    try {
      const result = await window.coscribe.file.applyAiOperation({ ...operation, status: 'accepted' })
      updateOperation(operation.id, { status: 'accepted' })
      setStore().markDocumentSaved(result)
      await refreshTree()
      openPath(result.path, 'markdown')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法应用文件修改'
      updateOperation(operation.id, { status: 'failed', error: message })
      setError(message)
    } finally { setApplyingOperationId(null) }
  }, [openPath, refreshTree, updateOperation])

  const rejectOperation = useCallback((operation: FileOperationProposal): void => updateOperation(operation.id, { status: 'rejected' }), [updateOperation])

  const saveSettings = useCallback(async (settings: AppSettings): Promise<void> => {
    const saved = await window.coscribe.settings.save(settings)
    setStore().setSettings(saved)
    setContextScope(saved.defaultContextScope)
  }, [])

  const saveQuickAiSettings = useCallback(async (
    patch: Partial<Pick<AppSettings, 'model' | 'reasoningEffort'>>
  ): Promise<void> => {
    const current = appStore.getState().settings
    try {
      const saved = await window.coscribe.settings.save({ ...current, ...patch })
      setStore().setSettings(saved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存 AI 模型设置')
    }
  }, [])

  const requestPdfComment = (path: string, selection: PdfTextSelection): void => runPrompt({
    title: '添加 PDF 批注', description: `第 ${selection.page} 页 · “${selection.text.slice(0, 80)}${selection.text.length > 80 ? '…' : ''}”`, label: '批注内容', placeholder: '记录你的理解或问题', confirmLabel: '添加批注',
    onSubmit: (value) => setStore().addAnnotation({ id: makeId('annotation'), path, page: selection.page, kind: 'comment', quote: selection.text, comment: value, color: 'amber', createdAt: Date.now() })
  })

  const openAnnotation = (annotation: Annotation): void => openPath(annotation.path, 'pdf', { page: annotation.page })

  const toggleSplit = (): void => {
    const store = setStore()
    if (store.workspace.split) {
      for (const tabId of [...store.workspace.panes.secondary.tabIds]) store.moveTab(tabId, 'primary')
      store.setSplit(false)
    } else store.setSplit(true)
  }

  const dropTab = (tabId: string, pane: PaneId, beforeTabId?: string): void => {
    const target = setStore().workspace.panes[pane].tabIds
    const index = beforeTabId ? Math.max(0, target.indexOf(beforeTabId)) : undefined
    setStore().moveTab(tabId, pane, index)
  }

  const beginResize = (side: 'left' | 'ai', event: React.PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const current = appStore.getState().workspace
    const maximum = maximumAiPanelWidth(window.innerWidth, current.leftWidth)
    const startWidth = side === 'left'
      ? clampProjectNavigatorWidth(current.leftWidth)
      : clampAiPanelWidth(current.aiWidth, maximum)
    setResizing(side)
    const move = (next: PointerEvent): void => {
      const delta = next.clientX - startX
      if (side === 'left') {
        setStore().setPanelWidths({ leftWidth: startWidth + delta })
      } else {
        const nextMaximum = maximumAiPanelWidth(window.innerWidth, appStore.getState().workspace.leftWidth)
        setStore().setPanelWidths({ aiWidth: clampAiPanelWidth(startWidth - delta, nextMaximum) })
      }
    }
    const end = (): void => { setResizing(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  const resizeAiFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = appStore.getState().workspace
    const maximum = maximumAiPanelWidth(window.innerWidth, current.leftWidth)
    const visibleWidth = clampAiPanelWidth(current.aiWidth, maximum)
    const step = event.shiftKey ? 64 : 24
    const nextWidth = event.key === 'Home'
      ? PANEL_LAYOUT.aiDefaultWidth
      : event.key === 'End'
        ? maximum
        : visibleWidth + (event.key === 'ArrowLeft' ? step : -step)
    setStore().setPanelWidths({ aiWidth: clampAiPanelWidth(nextWidth, maximum) })
  }

  if (booting && !state.project) return <div className="app-loading"><span className="viewer-spinner" /><strong>正在准备本地工作台…</strong></div>

  if (!state.project) {
    return <><HomeScreen recentProjects={state.recentProjects} defaultParentPath={state.settings.defaultProjectPath} busy={booting} error={error} onChooseLocation={() => window.coscribe.project.chooseLocation()} onCreate={(name, parentPath) => openProject(() => window.coscribe.project.create(name, parentPath))} onOpenFolder={() => openProject(() => window.coscribe.project.openDialog())} onOpenRecent={(path) => openProject(() => window.coscribe.project.openPath(path))} onOpenSettings={() => setSettingsOpen(true)} /><SettingsDialog open={settingsOpen} settings={state.settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} /></>
  }

  const primaryTabs = state.workspace.panes.primary.tabIds.map((id) => state.workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is OpenTab => Boolean(tab))
  const secondaryTabs = state.workspace.panes.secondary.tabIds.map((id) => state.workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is OpenTab => Boolean(tab))
  const activeTab = selectActiveTab(state)
  const activeDocument = selectActiveDocument(state)
  const currentSession = selectCurrentSession(state)
  const dirtyPaths = new Set(selectDirtyDocuments(state).map((document) => document.path))
  const activeContext = state.captureActiveContext(contextScope)
  const projectFiles = flattenFiles(state.fileTree)
  const visibleLeftWidth = clampProjectNavigatorWidth(state.workspace.leftWidth)
  const aiMaximumWidth = maximumAiPanelWidth(viewportWidth, visibleLeftWidth)
  const visibleAiWidth = clampAiPanelWidth(state.workspace.aiWidth, aiMaximumWidth)
  const isConfigured = isAiConfigured(state.settings)

  const paneProps = (pane: PaneId, tabs: OpenTab[]) => ({
    projectPath: state.project!.path,
    pane,
    tabs,
    activeTabId: state.workspace.panes[pane].activeTabId,
    focused: state.workspace.activePane === pane,
    workspace: state.workspace,
    documents: state.documents,
    annotations: state.annotations,
    settings: state.settings,
    dirtyPaths,
    onFocus: () => state.focusPane(pane),
    onActivate: (tabId: string) => state.setActiveTab(pane, tabId),
    onClose: requestCloseTab,
    onDropTab: dropTab,
    onEnsureDocument: ensureDocument,
    onUpdateDocument: state.updateDocument,
    onSaveMarkdown: saveMarkdown,
    onPdfState: (path: string, value: typeof state.workspace.pdf[string]) => state.updatePdfState(path, value),
    onMarkdownState: (path: string, value: typeof state.workspace.markdown[string]) => state.updateMarkdownState(path, value),
    onContext: state.setDocumentContext,
    onAddAnnotation: state.addAnnotation,
    onDeleteAnnotation: state.deleteAnnotation,
    onRequestComment: requestPdfComment,
    onReveal: (path: string) => void window.coscribe.file.reveal(path),
    onOpenProjectPath: (path: string) => openPath(path),
    onResolveConflict: (path: string, resolution: 'use-external' | 'keep-local') => state.resolveDocumentConflict(path, resolution === 'use-external' ? 'reload' : 'keep'),
    onError: setError
  })

  return (
    <div
      className={`app-shell ${resizing ? 'is-panel-resizing' : ''}`}
      style={{
        '--left-width': `${visibleLeftWidth}px`,
        '--ai-width': `${visibleAiWidth}px`,
        '--ai-max-width': `${aiMaximumWidth}px`
      } as React.CSSProperties}
    >
      <header className="app-titlebar">
        <div className="app-titlebar__project"><strong>{state.project.name}</strong><span>{activeTab?.path ?? state.project.path}</span></div>
        <div className="app-titlebar__center">{activeDocument?.dirty ? '未保存' : activeTab ? '本地文件' : '项目工作区'}</div>
        <div className="app-titlebar__actions">
          <button className={`icon-button ${state.workspace.split ? 'is-active' : ''}`} onClick={toggleSplit} title={state.workspace.split ? '关闭分屏' : '左右分屏'} aria-label={state.workspace.split ? '关闭分屏' : '左右分屏'}>{state.workspace.split ? <Columns3 size={16} /> : <Columns2 size={16} />}</button>
          <button className={`icon-button ${state.workspace.aiVisible ? 'is-active' : ''}`} onClick={() => state.setAiVisible(!state.workspace.aiVisible)} title={state.workspace.aiVisible ? '隐藏 AI' : '显示 AI'} aria-label={state.workspace.aiVisible ? '隐藏 AI' : '显示 AI'}>{state.workspace.aiVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置" aria-label="设置"><SettingsIcon size={16} /></button>
        </div>
      </header>
      <div className="app-body">
        <ActivityRail active={state.workspace.navSection} aiVisible={state.workspace.aiVisible} onChange={state.setNavSection} onToggleAi={() => state.setAiVisible(!state.workspace.aiVisible)} onSettings={() => setSettingsOpen(true)} />
        <ProjectNavigator
          section={state.workspace.navSection}
          projectName={state.project.name}
          projectPath={state.project.path}
          tree={state.fileTree}
          activePath={activeTab?.path}
          sessions={state.sessions}
          currentSessionId={state.workspace.currentSessionId}
          annotations={state.annotations}
          searchQuery={state.searchQuery}
          searchResults={state.searchResults}
          searchProgress={state.searchProgress}
          onCloseProject={requestCloseProject}
          onRefresh={() => void refreshTree()}
          onCreateMarkdown={createMarkdown}
          onCreateFolder={createFolder}
          onOpenNode={openNode}
          onRenameNode={renameNode}
          onMoveNode={moveNode}
          onTrashNode={trashNode}
          onRevealNode={(node) => void window.coscribe.file.reveal(node.path)}
          onImportFiles={(files, folder) => void importFiles(files, folder)}
          onMovePath={(path, folder) => void movePath(path, folder)}
          onNewSession={() => { state.createSession(); state.setAiVisible(true) }}
          onSelectSession={(id) => { state.setCurrentSession(id); state.setAiVisible(true) }}
          onRenameSession={state.renameSession}
          onDeleteSession={(id) => setConfirm({ title: '删除这个会话？', description: '只删除项目内的会话历史，不会删除任何文件。', confirmLabel: '删除会话', danger: true, onConfirm: () => { state.deleteSession(id); setConfirm(null) } })}
          onSearch={(query) => void search(query)}
          onOpenSearchResult={openSearchResult}
          onOpenAnnotation={openAnnotation}
          onDeleteAnnotation={(item) => state.deleteAnnotation(item.id)}
        />
        <div className={`resize-handle ${resizing === 'left' ? 'is-resizing' : ''}`} onPointerDown={(event) => beginResize('left', event)} role="separator" aria-orientation="vertical" aria-label="调整项目导航宽度" />
        <main className="workspace">
          <div className="editor-workbench">
            <EditorPane {...paneProps('primary', primaryTabs)} />
            {state.workspace.split && <EditorPane {...paneProps('secondary', secondaryTabs)} />}
          </div>
        </main>
        {state.workspace.aiVisible && <>
          <div
            className={`resize-handle ${resizing === 'ai' ? 'is-resizing' : ''}`}
            onPointerDown={(event) => beginResize('ai', event)}
            onDoubleClick={() => setStore().setPanelWidths({ aiWidth: PANEL_LAYOUT.aiDefaultWidth })}
            onKeyDown={resizeAiFromKeyboard}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 AI 面板宽度"
            aria-valuemin={PANEL_LAYOUT.aiMinWidth}
            aria-valuemax={aiMaximumWidth}
            aria-valuenow={visibleAiWidth}
            tabIndex={0}
            title="拖拽或使用方向键调整，双击恢复默认宽度"
          />
          <AiWorkspace
            projectName={state.project.name}
            sessions={state.sessions}
            currentSessionId={currentSession?.id ?? null}
            context={activeContext}
            contextScope={contextScope}
            referencedFiles={state.referencedFiles}
            availableFiles={projectFiles.map((file) => ({ path: file.path, name: file.name, kind: file.kind }))}
            isStreaming={Boolean(streamingRequestId)}
            isConfigured={isConfigured}
            error={aiError}
            applyingOperationId={applyingOperationId}
            onSelectSession={state.setCurrentSession}
            onNewSession={() => { state.createSession() }}
            onRenameSession={state.renameSession}
            onContextScopeChange={setContextScope}
            onReferencedFilesChange={state.setReferencedFiles}
            onSend={sendAiMessage}
            onStop={stopAi}
            onOpenSource={openSource}
            onOpenContext={openContext}
            onAcceptOperation={acceptOperation}
            onRejectOperation={rejectOperation}
            onRegenerateMessage={regenerateAiMessage}
            onOpenSettings={() => setSettingsOpen(true)}
            onDismissError={() => setAiError(null)}
          />
        </>}
      </div>
      <footer className="app-statusbar">
        <span className={`status-item ${activeDocument?.dirty ? 'is-warning' : 'is-ok'}`}>{activeDocument?.dirty ? <Save size={11} /> : <FileCheck2 size={11} />}{activeDocument?.dirty ? '尚未保存' : '文件已同步'}</span>
        {activeTab?.kind === 'pdf' && <span className="status-item">第 {state.workspace.pdf[activeTab.path]?.page ?? 1} 页</span>}
        {activeTab?.kind === 'markdown' && state.documentContexts[activeTab.path]?.markdownHeading && <span className="status-item">{state.documentContexts[activeTab.path].markdownHeading}</span>}
        <span className="app-statusbar__spacer" />
        {state.searchProgress && !state.searchProgress.done && <span className="status-item">正在搜索 {state.searchProgress.scanned}{state.searchProgress.total ? `/${state.searchProgress.total}` : ''}</span>}
        <ModelSwitcher
          model={state.settings.model}
          reasoningEffort={state.settings.reasoningEffort}
          isConfigured={isConfigured}
          onChange={saveQuickAiSettings}
        />
        <span className="status-item">UTF-8</span>
      </footer>

      {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}
      <SettingsDialog open={settingsOpen} settings={state.settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />
      <Dialog open={Boolean(prompt)} title={prompt?.title ?? ''} description={prompt?.description} onClose={() => setPrompt(null)} width={460} footer={<><button className="secondary-button" onClick={() => setPrompt(null)}>取消</button><button className="primary-button" disabled={!promptValue.trim()} onClick={() => void submitPrompt()}>{prompt?.confirmLabel ?? '确认'}</button></>}>
        <label className="field-label">{prompt?.label}<textarea className="field prompt-textarea" value={promptValue} onChange={(event) => setPromptValue(event.target.value)} placeholder={prompt?.placeholder} rows={prompt?.title.includes('批注') ? 5 : 2} /></label>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} title={confirm?.title ?? ''} description={confirm?.description ?? ''} confirmLabel={confirm?.confirmLabel} danger={confirm?.danger} onClose={() => setConfirm(null)} onConfirm={() => void confirm?.onConfirm()} />
    </div>
  )
}
