import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Columns2,
  Columns3,
  CircleHelp,
  FileCheck2,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Settings as SettingsIcon
} from 'lucide-react'
import type { AiSendPayload, ImageGenerationPayload } from './components/ai'
import {
  ActivityRail,
  ConfirmDialog,
  Dialog,
  HomeScreen,
  ModelSwitcher,
  ProjectNavigator,
  SettingsDialog
} from './components/shell'
import type { MarkdownSaveRequest, PdfTextSelection } from './components/viewers'
import { PLANNER_FILE_PATH } from './plugins/planner/planner-utils'
import { PLUGIN_PERMISSION_LABELS, trustedPlugin } from './plugins/registry'
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
  AiOperationHistoryEntry,
  Annotation,
  AppSettings,
  ChatImageAttachment,
  ChatMessage,
  ContextScope,
  ContextSnapshot,
  FileKind,
  FileNode,
  FileOperationProposal,
  FileReadResult,
  LiteratureMatrixRow,
  OpenTab,
  PaneId,
  ProjectInfo,
  ResearchBrowserExtractResult,
  ResearchBrowserState,
  ResearchReference,
  SearchResult,
  SourceRef
} from './shared/types'
import { DEFAULT_SETTINGS } from './shared/types'
import './styles/shell.css'

const AiWorkspace = lazy(() => import('./components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace })))
const BrowserWorkspace = lazy(() => import('./components/browser/BrowserWorkspace').then((module) => ({ default: module.BrowserWorkspace })))
const EditorPane = lazy(() => import('./components/shell/EditorPane').then((module) => ({ default: module.EditorPane })))
const PlannerWorkspace = lazy(() => import('./plugins/planner/PlannerWorkspace'))
const DailyNotesWorkspace = lazy(() => import('./plugins/daily-notes/DailyNotesWorkspace'))
const FlashcardsWorkspace = lazy(() => import('./plugins/flashcards/FlashcardsWorkspace'))
const BacklinksWorkspace = lazy(() => import('./plugins/backlinks/BacklinksWorkspace'))
const DiagnosticsWorkspace = lazy(() => import('./plugins/diagnostics/DiagnosticsWorkspace'))
const ReferencesWorkspace = lazy(() => import('./plugins/references/ReferencesWorkspace'))
const ReviewMatrixWorkspace = lazy(() => import('./plugins/review-matrix/ReviewMatrixWorkspace'))
const McpWorkspace = lazy(() => import('./plugins/mcp/McpWorkspace'))
const GitSnapshotsWorkspace = lazy(() => import('./plugins/git-snapshots/GitSnapshotsWorkspace'))
const WebTrackerWorkspace = lazy(() => import('./plugins/web-tracker/WebTrackerWorkspace'))
const UserGuideDialog = lazy(() => import('./components/shell/UserGuideDialog'))

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
  autoApplyOperation?: boolean
  operationMode?: AiSendPayload['operationMode']
}

interface AiSelectionCommand {
  path: string | null
  revealToken: number
  clearToken: number
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
  if (ext === 'pptx') return 'pptx'
  if (ext === 'ppt') return 'ppt'
  if (ext === 'mhtml' || ext === 'mht') return 'webarchive'
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

function hasRemoteCredential(url: string, hasApiKey: boolean): boolean {
  try {
    return hasApiKey || isLoopbackHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

function isAiConfigured(settings: AppSettings): boolean {
  return Boolean(settings.baseUrl.trim() && settings.model.trim()) && hasRemoteCredential(settings.baseUrl, settings.hasApiKey)
}

function isImageConfigured(settings: AppSettings): boolean {
  return Boolean(settings.imageBaseUrl.trim()) && hasRemoteCredential(settings.imageBaseUrl, settings.hasImageApiKey)
}

function resolvedTheme(settings: AppSettings): 'light' | 'dark' {
  if (settings.theme !== 'system') return settings.theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App(): React.JSX.Element {
  const state = useAppStore()
  const projectFiles = useMemo(() => flattenFiles(state.fileTree), [state.fileTree])
  const pluginFiles = useMemo(() => projectFiles.map((file) => ({ path: file.path, name: file.name, kind: file.kind })), [projectFiles])
  const [booting, setBooting] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [streamingRequestId, setStreamingRequestId] = useState<string | null>(null)
  const [imageGenerationRequestId, setImageGenerationRequestId] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [applyingOperationId, setApplyingOperationId] = useState<string | null>(null)
  const [capturedImage, setCapturedImage] = useState<ChatImageAttachment | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatDraftFocusToken, setChatDraftFocusToken] = useState(0)
  const [contextScope, setContextScope] = useState<ContextScope>(DEFAULT_SETTINGS.defaultContextScope)
  const [browserActive, setBrowserActive] = useState(false)
  const [activePluginId, setActivePluginId] = useState<string | null>(null)
  const [operationHistory, setOperationHistory] = useState<AiOperationHistoryEntry[]>([])
  const [undoingOperationId, setUndoingOperationId] = useState<string | null>(null)
  const [pendingWebContext, setPendingWebContext] = useState<ContextSnapshot | null>(null)
  const [aiSelectionCommand, setAiSelectionCommand] = useState<AiSelectionCommand>({
    path: null,
    revealToken: 0,
    clearToken: 0
  })
  const [resizing, setResizing] = useState<'left' | 'ai' | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const activeRequests = useRef(new Map<string, ActiveAiRequest>())
  const stoppedImageRequests = useRef(new Set<string>())
  const hydratedProjectPath = useRef<string | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const appShellRef = useRef<HTMLDivElement>(null)
  const panelResizeCleanupRef = useRef<((commit: boolean) => void) | null>(null)

  const setStore = appStore.getState

  useEffect(() => {
    const updateViewportWidth = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  useEffect(() => () => panelResizeCleanupRef.current?.(false), [])

  const hydrateProject = useCallback(async (project: ProjectInfo): Promise<void> => {
    setHydrated(false)
    setError(null)
    setActivePluginId(null)
    try {
      // Load the real file tree before mounting the workspace. A slow recursive
      // scan should not briefly look like an empty project, and a broken metadata
      // file must not hide otherwise readable user files.
      const [treeResult, workspaceResult, sessionsResult, annotationsResult, operationHistoryResult] = await Promise.allSettled([
        window.coscribe.project.tree(),
        window.coscribe.project.getState(),
        window.coscribe.sessions.list(),
        window.coscribe.annotations.list(),
        window.coscribe.project.operationHistory()
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
      if (operationHistoryResult.status === 'fulfilled') setOperationHistory(operationHistoryResult.value)
      else {
        setOperationHistory([])
        warnings.push('AI 操作历史无法恢复，文件内容不受影响。')
      }

      const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : []
      if (!sessions.length) store.createSession()
      const activeTabIds = new Set([
        store.workspace.panes.primary.activeTabId,
        ...(store.workspace.split ? [store.workspace.panes.secondary.activeTabId] : [])
      ].filter((id): id is string => Boolean(id)))
      const activeTabs = store.workspace.tabs.filter((tab) => !tab.missing && activeTabIds.has(tab.id))
      await Promise.all(activeTabs.map(async (tab) => {
        try { store.loadDocument(await window.coscribe.file.read(tab.path)) } catch { store.markPathMissing(tab.path) }
      }))
      hydratedProjectPath.current = project.path
      setHydrated(true)
      if (warnings.length) setError(warnings.join(' '))
    } catch (reason) {
      await window.coscribe.project.close().catch(() => undefined)
      setStore().closeProject()
      setOperationHistory([])
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

  const refreshOperationHistory = useCallback(async (): Promise<void> => {
    try { setOperationHistory(await window.coscribe.project.operationHistory()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'AI 操作历史刷新失败。') }
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

  useEffect(() => window.coscribe.screenshot.onResult((event) => {
    if (event.type === 'captured') {
      setCapturedImage(event.attachment)
      setStore().setAiVisible(true)
      return
    }
    setAiError(event.message)
    setStore().setAiVisible(true)
  }), [])

  useEffect(() => {
    const copySelectionToChat = (event: KeyboardEvent): void => {
      if (!(event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k')) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.ai-workspace, .project-navigator, .app-titlebar, .app-statusbar')) return
      event.preventDefault()
      const selection = appStore.getState().captureActiveContext('selection')?.selection?.trim()
      if (!selection) {
        setAiError('请先在当前文档中选中文字，再按 Command/Ctrl + Shift + K。')
        setStore().setAiVisible(true)
        return
      }
      setChatDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${selection}` : selection)
      setContextScope('selection')
      setStore().setAiVisible(true)
      setChatDraftFocusToken((token) => token + 1)
      setAiError(null)
    }
    window.addEventListener('keydown', copySelectionToChat)
    return () => window.removeEventListener('keydown', copySelectionToChat)
  }, [])

  useEffect(() => {
    // Rendering and persisting every token-sized delta makes long answers clone
    // the chat state hundreds of times per second. A short buffer keeps the UI
    // visibly live while bounding React/Zustand work.
    const pendingDeltas = new Map<string, string>()
    let flushTimer: number | null = null
    const flush = (requestId?: string): void => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      const entries = requestId
        ? [[requestId, pendingDeltas.get(requestId) ?? ''] as const]
        : [...pendingDeltas.entries()]
      for (const [id, text] of entries) {
        if (!text) continue
        pendingDeltas.delete(id)
        const request = activeRequests.current.get(id)
        if (!request) continue
        setStore().updateMessage(request.sessionId, request.assistantMessageId, (message) => ({ ...message, content: message.content + text }))
      }
      if (pendingDeltas.size && flushTimer === null) flushTimer = window.setTimeout(() => flush(), 40)
    }
    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = window.setTimeout(() => flush(), 40)
    }

    const unsubscribe = window.coscribe.ai.onStream((event: AiStreamEvent) => {
      const request = activeRequests.current.get(event.requestId)
      if (!request) return
      const store = setStore()
      if (event.type === 'delta') {
        pendingDeltas.set(event.requestId, `${pendingDeltas.get(event.requestId) ?? ''}${event.text}`)
        scheduleFlush()
        return
      }
      if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') flush(event.requestId)
      if (event.type === 'done') {
        store.updateMessage(request.sessionId, request.assistantMessageId, { sources: event.sources, operation: event.operation })
        const session = appStore.getState().sessions.find((item) => item.id === request.sessionId)
        if (session?.title === '新会话' && appStore.getState().settings.autoTitle) {
          const firstMessage = session.messages.find((message) => message.role === 'user')
          const firstQuestion = firstMessage?.content.trim() || firstMessage?.attachments?.[0]?.name || '图片提问'
          store.renameSession(session.id, firstQuestion.replace(/[#*_`]/g, '').slice(0, 20))
        }
        if (request.autoApplyOperation) {
          if (!event.operation) {
            const message = request.operationMode === 'generate-project-plan'
              ? 'AI 没有返回可写入的项目计划，请重新生成。'
              : 'AI 没有返回可写入的笔记文件，请重试“整理笔记”。'
            store.updateMessage(request.sessionId, request.assistantMessageId, { error: message })
            setAiError(message)
          } else {
            const operation = event.operation
            setApplyingOperationId(operation.id)
            void window.coscribe.file.applyAiOperation({ ...operation, status: 'accepted' }).then(async (result) => {
              store.updateMessage(request.sessionId, request.assistantMessageId, {
                operation: { ...operation, status: 'accepted' }
              })
              const files = result.files.length ? result.files : [result]
              for (const file of files) store.markDocumentSaved(file)
              store.setFileTree(await window.coscribe.project.tree())
              setOperationHistory(await window.coscribe.project.operationHistory())
              const first = files[0]
              if (first) {
                setBrowserActive(false)
                setActivePluginId(null)
                store.openTab({ id: `tab:${first.path}`, path: first.path, name: fileName(first.path), kind: 'markdown' })
              }
            }).catch((reason: unknown) => {
              const message = reason instanceof Error
                ? reason.message
                : request.operationMode === 'generate-project-plan'
                  ? '生成的项目计划无法写入本地。'
                  : '整理后的笔记无法写入本地。'
              store.updateMessage(request.sessionId, request.assistantMessageId, {
                operation: { ...operation, status: 'failed', error: message }
              })
              setAiError(message)
            }).finally(() => setApplyingOperationId(null))
          }
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
    })
    return () => {
      unsubscribe()
      if (flushTimer !== null) window.clearTimeout(flushTimer)
    }
  }, [])

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
    setBrowserActive(false)
    setActivePluginId(null)
    setPendingWebContext(null)
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

  const convertPowerPoint = useCallback(async (inputPath: string): Promise<void> => {
    const result = await window.coscribe.file.convertPowerPointToPdf(inputPath)
    setStore().markDocumentSaved(result)
    await refreshTree()
    openPath(result.path, 'pdf')
  }, [openPath, refreshTree])

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
      await window.coscribe.browser.close()
      await window.coscribe.project.close()
      setStore().closeProject()
      setBrowserActive(false)
      setActivePluginId(null)
      setOperationHistory([])
      setPendingWebContext(null)
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
    if (source.kind === 'web') {
      setBrowserActive(true)
      void window.coscribe.browser.navigate(source.path).catch((reason) => setError(reason instanceof Error ? reason.message : '无法重新打开网页来源'))
      return
    }
    openPath(
      source.path,
      source.kind === 'pdf' || source.kind === 'markdown' || source.kind === 'docx' || source.kind === 'ppt' || source.kind === 'pptx' || source.kind === 'image'
        ? source.kind
        : 'text',
      { page: source.page, line: source.line }
    )
  }

  const openContext = (context: ContextSnapshot): void => {
    if (context.webUrl) {
      setBrowserActive(true)
      void window.coscribe.browser.navigate(context.webUrl).catch((reason) => setError(reason instanceof Error ? reason.message : '无法重新打开网页上下文'))
      return
    }
    if (!context.documentPath) return
    openPath(context.documentPath, context.kind === 'folder' ? undefined : context.kind, { page: context.pdfPage })
  }

  const locateSelection = (context: ContextSnapshot): void => {
    if (context.documentPath) {
      setAiSelectionCommand((current) => ({
        path: context.documentPath!,
        revealToken: current.revealToken + 1,
        clearToken: current.clearToken
      }))
    }
    openContext(context)
  }

  const clearSelection = (context: ContextSnapshot): void => {
    if (context.documentPath) {
      setStore().setDocumentContext(context.documentPath, { selection: '' })
      setAiSelectionCommand((current) => ({
        path: context.documentPath!,
        revealToken: current.revealToken,
        clearToken: current.clearToken + 1
      }))
    }
    if (context.webUrl) setPendingWebContext(null)
    window.getSelection()?.removeAllRanges()
    setContextScope('visible')
  }

  const sendWebCaptureToAi = useCallback((capture: ResearchBrowserExtractResult): void => {
    const store = appStore.getState()
    if (!store.project) return
    const scope: ContextScope = capture.mode === 'selection' ? 'selection' : 'document'
    const context: ContextSnapshot = {
      projectName: store.project.name,
      projectPath: store.project.path,
      pane: store.workspace.activePane,
      documentName: capture.title || new URL(capture.url).hostname,
      webUrl: capture.url,
      ...(capture.mode === 'selection'
        ? { selection: capture.text, visibleText: capture.text }
        : { visibleText: capture.text.slice(0, 20_000), sectionText: capture.text, documentText: capture.text }),
      scope,
      referencedFiles: [...store.referencedFiles],
      capturedAt: Date.now()
    }
    const draft = capture.mode === 'selection'
      ? [`网页选中内容：[${context.documentName}](${capture.url})`, '', capture.text].join('\n')
      : `请基于这篇网页的完整正文回答：\n\n[${context.documentName}](${capture.url})`
    setPendingWebContext(context)
    setContextScope(scope)
    setChatDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft)
    setStore().setAiVisible(true)
    setChatDraftFocusToken((token) => token + 1)
    setAiError(null)
  }, [])

  const citeWebSource = useCallback((browserState: ResearchBrowserState): void => {
    if (!browserState.url) return
    const title = browserState.title || new URL(browserState.url).hostname
    const citation = `[${title}](${browserState.url})（访问于 ${new Intl.DateTimeFormat('zh-CN').format(new Date())}）`
    setChatDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${citation}` : citation)
    setStore().setAiVisible(true)
    setChatDraftFocusToken((token) => token + 1)
    setAiError(null)
  }, [])

  const browserFileSaved = useCallback(async (result: FileReadResult): Promise<void> => {
    setStore().markDocumentSaved(result)
    await refreshTree()
  }, [refreshTree])

  const sendAiMessage = useCallback(async (payload: AiSendPayload): Promise<void> => {
    const store = setStore()
    let sessionId = store.workspace.currentSessionId
    if (!sessionId) sessionId = store.createSession()
    store.setReferencedFiles(payload.referencedFiles)
    const context = payload.operationMode
      ? setStore().captureActiveContext('project')
      : pendingWebContext && pendingWebContext.projectPath === state.project?.path
        ? { ...pendingWebContext, referencedFiles: [...pendingWebContext.referencedFiles] }
        : setStore().captureActiveContext(payload.scope)
    if (!context || !state.project) return
    context.referencedFiles = [...payload.referencedFiles]
    const requestId = makeId('ai')
    const userMessage: ChatMessage = {
      id: makeId('message'),
      role: 'user',
      content: payload.content,
      createdAt: Date.now(),
      ...(payload.attachments.length ? { attachments: payload.attachments.map((attachment) => ({ ...attachment })) } : {}),
      context
    }
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: Date.now() + 1 }
    const history = appStore.getState().sessions.find((session) => session.id === sessionId)?.messages ?? []
    store.addMessage(sessionId, userMessage)
    store.addMessage(sessionId, assistantMessage)
    if (context.scope === 'selection') {
      if (context.documentPath) {
        store.setDocumentContext(context.documentPath, { selection: '' })
        setAiSelectionCommand((current) => ({
          path: context.documentPath!,
          revealToken: current.revealToken,
          clearToken: current.clearToken + 1
        }))
      }
      window.getSelection()?.removeAllRanges()
      setContextScope('visible')
    }
    setPendingWebContext(null)
    activeRequests.current.set(requestId, {
      requestId,
      sessionId,
      assistantMessageId: assistantMessage.id,
      ...(payload.autoApplyOperation ? { autoApplyOperation: true } : {}),
      ...(payload.operationMode ? { operationMode: payload.operationMode } : {})
    })
    setStreamingRequestId(requestId)
    setAiError(null)
    try {
      await window.coscribe.ai.start({
        requestId,
        sessionId,
        messages: [...history, userMessage]
          .filter((message) => message.role !== 'system')
          .map(({ role, content, attachments }) => ({
            role,
            content,
            ...(attachments?.length
              ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
              : {})
          })),
        context,
        ...(payload.operationMode ? { operationMode: payload.operationMode } : {}),
        settings: { allowGeneralKnowledge: state.settings.allowGeneralKnowledge }
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'AI 请求无法启动'
      store.updateMessage(sessionId, assistantMessage.id, { error: message })
      activeRequests.current.delete(requestId)
      setStreamingRequestId(null)
      setAiError(message)
    }
  }, [pendingWebContext, state.project, state.settings.allowGeneralKnowledge])

  const captureScreenshot = useCallback(async (): Promise<void> => {
    try {
      setAiError(null)
      const attachment = await window.coscribe.screenshot.capture()
      if (!attachment) return
      setCapturedImage(attachment)
      setStore().setAiVisible(true)
    } catch (reason) {
      setAiError(reason instanceof Error ? reason.message : '截图失败。')
    }
  }, [])

  const quickNote = useCallback(async (): Promise<void> => {
    const store = appStore.getState()
    await sendAiMessage({
      content: [
        '请把本次会话中有长期价值的知识整理为结构化 Markdown 笔记，并立即保存到本地项目。',
        '结合会话主题、项目目录结构和现有笔记命名，自主选择最合适的保存位置。',
        '当前打开文档仅供参考，不是默认写入目标；仅当主题明确匹配时才追加，否则创建合适的新笔记或目录。',
        '内容涉及多个独立主题时，可以一次创建多份互相链接的 Markdown 笔记。',
        '保留关键结论、解释、步骤、代码和来源；去掉寒暄、重复内容和过程性指令。',
        '必须调用 CoScribe 文件操作工具，不要只在聊天中返回笔记正文。'
      ].join('\n'),
      attachments: [],
      scope: 'project',
      referencedFiles: [...store.referencedFiles],
      operationMode: 'organize-project-notes',
      autoApplyOperation: true
    })
  }, [sendAiMessage])

  const generateProjectPlan = useCallback(async (goal: string, horizon: string): Promise<void> => {
    if (streamingRequestId || imageGenerationRequestId) {
      const message = '请等待当前 AI 任务结束后再生成计划。'
      setAiError(message)
      setStore().setAiVisible(true)
      throw new Error(message)
    }
    setStore().setAiVisible(true)
    await sendAiMessage({
      content: [
        `请为当前项目生成一份“${horizon}”尺度的可执行计划。`,
        `目标与约束：${goal}`,
        `必须写入项目内固定文件 ${PLANNER_FILE_PATH}。如果文件不存在就 create；如果已经存在就 replace 为完整更新后的文档，不要写入其他路径。`,
        '保留并使用 CoScribe Planner 的 Markdown 日程表标记：<!-- coscribe:planner:start --> 与 <!-- coscribe:planner:end -->。',
        '日程表列必须是：日期、时间、事项、状态、优先级、备注；日期使用 YYYY-MM-DD，状态使用待办/进行中/已完成，优先级使用低/中/高。',
        '同时补充“本周重点”和“里程碑”，任务要具体、可验证、有合理依赖与缓冲，不要虚构项目中不存在的事实。',
        '必须调用 CoScribe 文件操作工具并直接保存，不要只在聊天中返回计划正文。'
      ].join('\n'),
      attachments: [],
      scope: 'project',
      referencedFiles: [],
      operationMode: 'generate-project-plan',
      autoApplyOperation: true
    })
  }, [imageGenerationRequestId, sendAiMessage, streamingRequestId])

  const generateFlashcards = useCallback(async (topic: string): Promise<void> => {
    if (streamingRequestId || imageGenerationRequestId) throw new Error('请等待当前 AI 任务结束后再生成闪卡。')
    setStore().setAiVisible(true)
    await sendAiMessage({
      content: [
        `请基于当前项目的真实资料生成闪卡。学习主题或要求：${topic}`,
        '每张闪卡必须使用相邻两行“Q:: 问题”和“A:: 答案”，卡片之间空一行。',
        '问题用于主动回忆和理解检验；答案简洁、准确、能够独立理解，并避免重复。',
        '把候选卡片写入项目“闪卡”目录下命名清晰的 Markdown 文件。',
        '必须调用 CoScribe 文件操作工具生成预览；在用户接受预览前不要声称已经保存。'
      ].join('\n'),
      attachments: [],
      scope: 'project',
      referencedFiles: [],
      operationMode: 'generate-flashcards'
    })
  }, [imageGenerationRequestId, sendAiMessage, streamingRequestId])

  const generateLiteratureMatrix = useCallback(async (
    references: ResearchReference[],
    rows: LiteratureMatrixRow[]
  ): Promise<void> => {
    if (streamingRequestId || imageGenerationRequestId) throw new Error('请等待当前 AI 任务结束后再补全文献矩阵。')
    const referenceContext = references.slice(0, 300).map((reference) => [
      `- [${reference.citeKey}] ${reference.authors.join(', ') || '未知作者'} (${reference.year ?? 'n.d.'}). ${reference.title}`,
      reference.doi ? `  DOI: ${reference.doi}` : '',
      reference.abstract ? `  已录入摘要: ${reference.abstract.slice(0, 1_500)}` : '  摘要未录入；不得据题名猜测研究内容。',
      reference.pdfPath ? `  本地 PDF: ${reference.pdfPath}` : ''
    ].filter(Boolean).join('\n')).join('\n').slice(0, 70_000)
    const existingEvidence = rows.filter((row) => row.researchQuestion || row.method || row.findings || row.evidence).slice(0, 300)
      .map((row) => `${row.citeKey}: 研究问题=${row.researchQuestion}; 方法=${row.method}; 发现=${row.findings}; 证据=${row.evidence}`).join('\n').slice(0, 40_000)
    setStore().setAiVisible(true)
    await sendAiMessage({
      content: [
        '请基于当前项目中的真实文献资料，补全或整理文献综述矩阵。',
        '只能写入固定文件 研究/文献综述矩阵.md；不存在时 create，存在时 replace 完整文档。',
        '保留 <!-- coscribe:literature-matrix:start --> 与 <!-- coscribe:literature-matrix:end --> 标记，以及已有人工填写的有证据内容。',
        '矩阵列包含：文献、年份、状态、研究问题、方法、样本/数据、主要发现、局限、证据位置、标签。',
        '元数据与摘要只能支持有限判断；没有原文或项目证据的字段必须留空，不得猜测。证据位置应写具体文件、页码或章节。',
        `文献库（${references.length} 条，本次最多附 300 条）：\n${referenceContext}`,
        existingEvidence ? `已有矩阵证据摘要：\n${existingEvidence}` : '',
        '必须调用 CoScribe 文件操作工具生成预览；用户确认前不要声称已经保存。'
      ].filter(Boolean).join('\n\n'),
      attachments: [],
      scope: 'project',
      referencedFiles: references.flatMap((reference) => reference.pdfPath ? [reference.pdfPath] : []).slice(0, 20),
      operationMode: 'generate-literature-matrix'
    })
  }, [imageGenerationRequestId, sendAiMessage, streamingRequestId])

  const sendPluginTextToAi = useCallback((value: string): void => {
    setChatDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${value}` : value)
    setChatDraftFocusToken((token) => token + 1)
    setStore().setAiVisible(true)
  }, [])

  const stopAi = useCallback(async (): Promise<void> => {
    if (streamingRequestId) await window.coscribe.ai.stop(streamingRequestId)
  }, [streamingRequestId])

  const generateImage = useCallback(async (payload: ImageGenerationPayload): Promise<void> => {
    if (streamingRequestId || imageGenerationRequestId) return
    const store = setStore()
    let sessionId = store.workspace.currentSessionId
    if (!sessionId) sessionId = store.createSession()
    const requestId = makeId('image')
    const userMessage: ChatMessage = {
      id: makeId('message'),
      role: 'user',
      content: payload.prompt,
      createdAt: Date.now()
    }
    const assistantMessage: ChatMessage = {
      id: makeId('message'),
      role: 'assistant',
      content: '',
      createdAt: Date.now() + 1
    }
    store.addMessage(sessionId, userMessage)
    store.addMessage(sessionId, assistantMessage)
    setImageGenerationRequestId(requestId)
    setAiError(null)

    try {
      const result = await window.coscribe.images.generate({ requestId, ...payload })
      store.updateMessage(sessionId, assistantMessage.id, {
        attachments: [{ ...result.attachment }]
      })
      const session = appStore.getState().sessions.find((item) => item.id === sessionId)
      if (session?.title === '新会话' && appStore.getState().settings.autoTitle) {
        store.renameSession(sessionId, payload.prompt.replace(/[#*_`]/g, '').slice(0, 20) || '图片生成')
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '图片生成失败'
      if (stoppedImageRequests.current.has(requestId) || message.includes('已停止')) {
        store.updateMessage(sessionId, assistantMessage.id, { stopped: true })
      } else {
        store.updateMessage(sessionId, assistantMessage.id, { error: message })
        setAiError(message)
      }
    } finally {
      stoppedImageRequests.current.delete(requestId)
      setImageGenerationRequestId((current) => current === requestId ? null : current)
    }
  }, [imageGenerationRequestId, streamingRequestId])

  const stopImage = useCallback(async (): Promise<void> => {
    if (!imageGenerationRequestId) return
    stoppedImageRequests.current.add(imageGenerationRequestId)
    await window.coscribe.images.stop(imageGenerationRequestId)
  }, [imageGenerationRequestId])

  const regenerateAiMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    if (streamingRequestId || imageGenerationRequestId) return
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
          .map(({ role, content, attachments }) => ({
            role,
            content,
            ...(attachments?.length
              ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
              : {})
          })),
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
  }, [imageGenerationRequestId, streamingRequestId])

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
      const files = result.files.length ? result.files : [result]
      for (const file of files) setStore().markDocumentSaved(file)
      await refreshTree()
      await refreshOperationHistory()
      openPath(files[0]?.path ?? result.path, 'markdown')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法应用文件修改'
      updateOperation(operation.id, { status: 'failed', error: message })
      setError(message)
    } finally { setApplyingOperationId(null) }
  }, [openPath, refreshOperationHistory, refreshTree, updateOperation])

  const rejectOperation = useCallback((operation: FileOperationProposal): void => updateOperation(operation.id, { status: 'rejected' }), [updateOperation])

  const undoOperation = useCallback(async (entry: AiOperationHistoryEntry): Promise<void> => {
    setUndoingOperationId(entry.id)
    try {
      const result = await window.coscribe.project.undoOperation(entry.id)
      for (const file of result.files) setStore().markDocumentSaved(file)
      for (const deletedPath of result.deletedPaths) {
        setStore().markPathMissing(deletedPath)
        setStore().removeDocument(deletedPath)
      }
      await Promise.all([refreshTree(), refreshOperationHistory()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法撤销这次 AI 操作。')
    } finally {
      setUndoingOperationId(null)
    }
  }, [refreshOperationHistory, refreshTree])

  const saveSettings = useCallback(async (settings: AppSettings): Promise<void> => {
    const saved = await window.coscribe.settings.save(settings)
    setStore().setSettings(saved)
    setContextScope(saved.defaultContextScope)
  }, [])

  const openPlugin = useCallback((pluginId: string): void => {
    const plugin = trustedPlugin(pluginId)
    const settings = appStore.getState().settings
    if (!plugin || !settings.enabledPlugins.includes(pluginId)) return
    if (!plugin.permissions.every((permission) => (settings.pluginGrants[pluginId] ?? []).includes(permission))) {
      setError(`${plugin.name} 需要先在插件中心完成权限授权。`)
      return
    }
    setBrowserActive(false)
    setPendingWebContext(null)
    setActivePluginId(pluginId)
  }, [])

  const togglePlugin = useCallback(async (pluginId: string, enabled: boolean): Promise<void> => {
    const plugin = trustedPlugin(pluginId)
    if (!plugin) return
    const current = appStore.getState().settings
    const saveEnabled = async (): Promise<void> => {
      const latest = appStore.getState().settings
      const enabledPlugins = [...new Set([...latest.enabledPlugins, pluginId])]
      const pluginGrants = { ...latest.pluginGrants, [pluginId]: [...plugin.permissions, ...(plugin.optionalPermissions ?? [])] }
      const saved = await window.coscribe.settings.save({ ...latest, enabledPlugins, pluginGrants })
      setStore().setSettings(saved)
    }
    if (enabled) {
      setConfirm({
        title: `启用“${plugin.name}”？`,
        description: `这个内置插件将获得：${[...plugin.permissions, ...(plugin.optionalPermissions ?? [])].map((permission) => PLUGIN_PERMISSION_LABELS[permission]).join('；')}。权限仅作用于当前 CoScribe 功能边界，可随时停用。`,
        confirmLabel: '授权并启用',
        onConfirm: async () => {
          try { await saveEnabled(); setConfirm(null) }
          catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存插件授权') }
        }
      })
      return
    }
    try {
      const enabledPlugins = current.enabledPlugins.filter((id) => id !== pluginId)
      const pluginGrants = { ...current.pluginGrants }
      delete pluginGrants[pluginId]
      const saved = await window.coscribe.settings.save({ ...current, enabledPlugins, pluginGrants })
      setStore().setSettings(saved)
      setActivePluginId((active) => active === pluginId ? null : active)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存插件设置')
    }
  }, [])

  const plannerFileChanged = useCallback(async (result: FileReadResult): Promise<void> => {
    setStore().markDocumentSaved(result)
    await refreshTree()
  }, [refreshTree])

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
    panelResizeCleanupRef.current?.(true)
    const startX = event.clientX
    const current = appStore.getState().workspace
    const maximum = maximumAiPanelWidth(window.innerWidth, current.leftWidth)
    const startWidth = side === 'left'
      ? clampProjectNavigatorWidth(current.leftWidth)
      : clampAiPanelWidth(current.aiWidth, maximum)
    const handle = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const shell = appShellRef.current
    let latestWidth = startWidth
    let animationFrame: number | null = null
    let finished = false

    const paint = (): void => {
      animationFrame = null
      if (!shell) return
      if (side === 'left') {
        shell.style.setProperty('--left-width', `${latestWidth}px`)
        shell.style.setProperty('--ai-max-width', `${maximumAiPanelWidth(window.innerWidth, latestWidth)}px`)
      } else {
        shell.style.setProperty('--ai-width', `${latestWidth}px`)
      }
    }
    const schedulePaint = (): void => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(paint)
    }
    setResizing(side)
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      next.preventDefault()
      const delta = next.clientX - startX
      if (side === 'left') {
        latestWidth = clampProjectNavigatorWidth(startWidth + delta)
      } else {
        const nextMaximum = maximumAiPanelWidth(window.innerWidth, appStore.getState().workspace.leftWidth)
        latestWidth = clampAiPanelWidth(startWidth - delta, nextMaximum)
      }
      schedulePaint()
    }
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      paint()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', blur)
      handle.removeEventListener('lostpointercapture', lost)
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {
        // Chromium may already have released capture after pointerup/cancel.
      }
      if (!commit) {
        latestWidth = startWidth
        paint()
      } else if (side === 'left') {
        setStore().setPanelWidths({ leftWidth: latestWidth })
      } else {
        setStore().setPanelWidths({ aiWidth: latestWidth })
      }
      panelResizeCleanupRef.current = null
      setResizing(null)
    }
    const end = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) finish(true)
    }
    const cancel = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) finish(true)
    }
    const lost = (next: PointerEvent): void => {
      if (next.pointerId === pointerId && next.buttons === 0) finish(true)
    }
    const blur = (): void => finish(true)

    panelResizeCleanupRef.current = finish
    try { handle.setPointerCapture?.(pointerId) } catch { /* Window listeners remain as a fallback. */ }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
    handle.addEventListener('lostpointercapture', lost)
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
    return <><HomeScreen recentProjects={state.recentProjects} defaultParentPath={state.settings.defaultProjectPath} busy={booting} error={error} onChooseLocation={() => window.coscribe.project.chooseLocation()} onCreate={(name, parentPath) => openProject(() => window.coscribe.project.create(name, parentPath))} onOpenFolder={() => openProject(() => window.coscribe.project.openDialog())} onOpenRecent={(path) => openProject(() => window.coscribe.project.openPath(path))} onOpenGuide={() => setGuideOpen(true)} onOpenSettings={() => setSettingsOpen(true)} /><SettingsDialog open={settingsOpen} settings={state.settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />{guideOpen && <Suspense fallback={null}><UserGuideDialog onClose={() => setGuideOpen(false)} /></Suspense>}</>
  }

  const primaryTabs = state.workspace.panes.primary.tabIds.map((id) => state.workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is OpenTab => Boolean(tab))
  const secondaryTabs = state.workspace.panes.secondary.tabIds.map((id) => state.workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is OpenTab => Boolean(tab))
  const activeTab = selectActiveTab(state)
  const activeDocument = selectActiveDocument(state)
  const currentSession = selectCurrentSession(state)
  const dirtyPaths = new Set(selectDirtyDocuments(state).map((document) => document.path))
  const activeContext = pendingWebContext ?? state.captureActiveContext(contextScope)
  const visibleLeftWidth = clampProjectNavigatorWidth(state.workspace.leftWidth)
  const aiMaximumWidth = maximumAiPanelWidth(viewportWidth, visibleLeftWidth)
  const visibleAiWidth = clampAiPanelWidth(state.workspace.aiWidth, aiMaximumWidth)
  const isConfigured = isAiConfigured(state.settings)
  const imageConfigured = isImageConfigured(state.settings)
  const plannerAbsolutePath = `${state.project.path.replace(/\/+$/u, '')}/${PLANNER_FILE_PATH}`
  const hasUnsavedPlan = Boolean(state.documents[plannerAbsolutePath]?.dirty)
  const specialWorkspaceActive = browserActive || Boolean(activePluginId)
  const activePlugin = activePluginId ? trustedPlugin(activePluginId) : undefined

  const paneProps = (pane: PaneId, tabs: OpenTab[]) => {
    const paneActiveTab = tabs.find((tab) => tab.id === state.workspace.panes[pane].activeTabId)
    const selectionMatches = Boolean(paneActiveTab && aiSelectionCommand.path === paneActiveTab.path)
    return {
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
      onOpenExternal: (path: string) => void window.coscribe.file.openExternal(path).catch((reason) => setError(reason instanceof Error ? reason.message : '系统无法打开文件')),
      onOpenProjectPath: (path: string) => openPath(path),
      onConvertPowerPoint: convertPowerPoint,
      onResolveConflict: (path: string, resolution: 'use-external' | 'keep-local') => state.resolveDocumentConflict(path, resolution === 'use-external' ? 'reload' : 'keep'),
      onError: setError,
      aiSelectionText: paneActiveTab ? state.documentContexts[paneActiveTab.path]?.selection : undefined,
      aiSelectionRevealToken: selectionMatches ? aiSelectionCommand.revealToken : 0,
      aiSelectionClearToken: selectionMatches ? aiSelectionCommand.clearToken : 0
    }
  }

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${resizing ? 'is-panel-resizing' : ''}`}
      style={{
        '--left-width': `${visibleLeftWidth}px`,
        '--ai-width': `${visibleAiWidth}px`,
        '--ai-max-width': `${aiMaximumWidth}px`
      } as React.CSSProperties}
    >
      <header className="app-titlebar">
        <div className="app-titlebar__project"><strong>{state.project.name}</strong><span>{browserActive ? '资料浏览器 · 原网页' : activePlugin ? activePlugin.name : activeTab?.path ?? state.project.path}</span></div>
        <div className="app-titlebar__center">{browserActive ? '单标签资料浏览器' : activePlugin ? '按需加载的可信内置插件' : activeDocument?.dirty ? '未保存' : activeTab ? '本地文件' : '项目工作区'}</div>
        <div className="app-titlebar__actions">
          <button className={`icon-button ${state.workspace.split ? 'is-active' : ''}`} disabled={specialWorkspaceActive} onClick={toggleSplit} title={specialWorkspaceActive ? '当前工作区使用单内容区域' : state.workspace.split ? '关闭分屏' : '左右分屏'} aria-label={state.workspace.split ? '关闭分屏' : '左右分屏'}>{state.workspace.split ? <Columns3 size={16} /> : <Columns2 size={16} />}</button>
          <button className={`icon-button ${state.workspace.aiVisible ? 'is-active' : ''}`} onClick={() => state.setAiVisible(!state.workspace.aiVisible)} title={state.workspace.aiVisible ? '隐藏 AI' : '显示 AI'} aria-label={state.workspace.aiVisible ? '隐藏 AI' : '显示 AI'}>{state.workspace.aiVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
          <button className="icon-button" onClick={() => setGuideOpen(true)} title="使用指南" aria-label="使用指南"><CircleHelp size={16} /></button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置" aria-label="设置"><SettingsIcon size={16} /></button>
        </div>
      </header>
      <div className="app-body">
        <ActivityRail active={state.workspace.navSection} aiVisible={state.workspace.aiVisible} browserActive={browserActive} onChange={state.setNavSection} onToggleBrowser={() => setBrowserActive((active) => { const next = !active; if (next) setActivePluginId(null); return next })} onToggleAi={() => state.setAiVisible(!state.workspace.aiVisible)} onSettings={() => setSettingsOpen(true)} />
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
          onOpenMemory={(path) => openPath(path, 'markdown')}
          onMemorySaved={refreshTree}
          onSendMemoryToAi={(value) => {
            setChatDraft(value)
            setChatDraftFocusToken((token) => token + 1)
            state.setAiVisible(true)
          }}
          operationHistory={operationHistory}
          undoingOperationId={undoingOperationId}
          onUndoOperation={undoOperation}
          enabledPluginIds={state.settings.enabledPlugins}
          pluginGrants={state.settings.pluginGrants}
          activePluginId={activePluginId}
          onOpenPlugin={openPlugin}
          onTogglePlugin={togglePlugin}
        />
        <div className={`resize-handle ${resizing === 'left' ? 'is-resizing' : ''}`} onPointerDown={(event) => beginResize('left', event)} role="separator" aria-orientation="vertical" aria-label="调整项目导航宽度" />
        <main className="workspace">
          <Suspense fallback={<div className="workspace-loading"><span className="viewer-spinner" /><strong>正在载入工作区…</strong></div>}>
            {browserActive ? (
              <BrowserWorkspace
                suspended={settingsOpen || Boolean(prompt) || Boolean(confirm) || Boolean(resizing)}
                onClose={() => setBrowserActive(false)}
                onSendToAi={sendWebCaptureToAi}
                onCiteSource={citeWebSource}
                onSaved={browserFileSaved}
                onError={setError}
              />
            ) : activePluginId === 'planner' ? (
              <PlannerWorkspace
                projectName={state.project.name}
                aiConfigured={isConfigured}
                hasUnsavedPlan={hasUnsavedPlan}
                onOpenMarkdown={(path) => openPath(path, 'markdown')}
                onFileChanged={plannerFileChanged}
                onGenerateWithAi={generateProjectPlan}
                calendarGranted={(state.settings.pluginGrants.planner ?? []).includes('calendar:write')}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            ) : activePluginId === 'daily-notes' ? (
              <DailyNotesWorkspace projectName={state.project.name} onOpenMarkdown={(path) => openPath(path, 'markdown')} onFileChanged={plannerFileChanged} />
            ) : activePluginId === 'flashcards' ? (
              <FlashcardsWorkspace files={pluginFiles} aiConfigured={isConfigured} onOpenMarkdown={(path) => openPath(path, 'markdown')} onGenerateWithAi={generateFlashcards} onOpenSettings={() => setSettingsOpen(true)} />
            ) : activePluginId === 'backlinks' ? (
              <BacklinksWorkspace activePath={activeTab?.kind === 'markdown' ? activeTab.path : undefined} onOpenMarkdown={(path) => openPath(path, 'markdown')} />
            ) : activePluginId === 'diagnostics' ? (
              <DiagnosticsWorkspace />
            ) : activePluginId === 'references' ? (
              <ReferencesWorkspace
                files={pluginFiles}
                networkGranted={(state.settings.pluginGrants.references ?? []).includes('network:read')}
                onOpenFile={(path, kind) => openPath(path, kind ?? inferKind(path))}
                onProjectChanged={refreshTree}
                onSendToAi={sendPluginTextToAi}
              />
            ) : activePluginId === 'review-matrix' ? (
              <ReviewMatrixWorkspace
                aiConfigured={isConfigured}
                onOpenMarkdown={(path) => openPath(path, 'markdown')}
                onProjectChanged={refreshTree}
                onGenerateWithAi={generateLiteratureMatrix}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            ) : activePluginId === 'mcp-connectors' ? (
              <McpWorkspace onSendToAi={sendPluginTextToAi} />
            ) : activePluginId === 'git-snapshots' ? (
              <GitSnapshotsWorkspace />
            ) : activePluginId === 'web-tracker' ? (
              <WebTrackerWorkspace onOpenMarkdown={(path) => openPath(path, 'markdown')} onProjectChanged={refreshTree} onSendToAi={sendPluginTextToAi} />
            ) : (
              <div className="editor-workbench">
                <EditorPane {...paneProps('primary', primaryTabs)} />
                {state.workspace.split && <EditorPane {...paneProps('secondary', secondaryTabs)} />}
              </div>
            )}
          </Suspense>
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
          <Suspense fallback={<aside className="ai-workspace ai-workspace-loading"><span className="viewer-spinner" /><strong>正在载入 AI 工作区…</strong></aside>}><AiWorkspace
            projectName={state.project.name}
            sessions={state.sessions}
            currentSessionId={currentSession?.id ?? null}
            context={activeContext}
            contextScope={contextScope}
            referencedFiles={state.referencedFiles}
            availableFiles={projectFiles.map((file) => ({ path: file.path, name: file.name, kind: file.kind }))}
            isStreaming={Boolean(streamingRequestId)}
            isGeneratingImage={Boolean(imageGenerationRequestId)}
            isConfigured={isConfigured}
            isImageConfigured={imageConfigured}
            error={aiError}
            applyingOperationId={applyingOperationId}
            capturedImage={capturedImage}
            draft={chatDraft}
            draftFocusToken={chatDraftFocusToken}
            onSelectSession={state.setCurrentSession}
            onNewSession={() => { state.createSession() }}
            onRenameSession={state.renameSession}
            onContextScopeChange={(scope) => {
              if (scope !== 'selection') {
                const selected = appStore.getState().captureActiveContext('selection')
                if (selected?.selection?.trim() && selected.documentPath) {
                  setStore().setDocumentContext(selected.documentPath, { selection: '' })
                  setAiSelectionCommand((current) => ({
                    path: selected.documentPath!,
                    revealToken: current.revealToken,
                    clearToken: current.clearToken + 1
                  }))
                  window.getSelection()?.removeAllRanges()
                }
              }
              setContextScope(scope)
              if (pendingWebContext && scope !== pendingWebContext.scope) setPendingWebContext(null)
            }}
            onDraftChange={(value) => {
              setChatDraft(value)
              if (!value.trim()) setPendingWebContext(null)
            }}
            onReferencedFilesChange={state.setReferencedFiles}
            onSend={sendAiMessage}
            onStop={stopAi}
            onGenerateImage={generateImage}
            onStopImage={stopImage}
            onCaptureScreenshot={captureScreenshot}
            onCapturedImageHandled={() => setCapturedImage(null)}
            onQuickNote={quickNote}
            onOpenSource={openSource}
            onOpenContext={openContext}
            onLocateSelection={locateSelection}
            onClearSelection={clearSelection}
            onAcceptOperation={acceptOperation}
            onRejectOperation={rejectOperation}
            onRegenerateMessage={regenerateAiMessage}
            onOpenSettings={() => setSettingsOpen(true)}
            onDismissError={() => setAiError(null)}
          /></Suspense>
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
      {guideOpen && <Suspense fallback={null}><UserGuideDialog onClose={() => setGuideOpen(false)} /></Suspense>}
      <SettingsDialog open={settingsOpen} settings={state.settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />
      <Dialog open={Boolean(prompt)} title={prompt?.title ?? ''} description={prompt?.description} onClose={() => setPrompt(null)} width={460} footer={<><button className="secondary-button" onClick={() => setPrompt(null)}>取消</button><button className="primary-button" disabled={!promptValue.trim()} onClick={() => void submitPrompt()}>{prompt?.confirmLabel ?? '确认'}</button></>}>
        <label className="field-label">{prompt?.label}<textarea className="field prompt-textarea" value={promptValue} onChange={(event) => setPromptValue(event.target.value)} placeholder={prompt?.placeholder} rows={prompt?.title.includes('批注') ? 5 : 2} /></label>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} title={confirm?.title ?? ''} description={confirm?.description ?? ''} confirmLabel={confirm?.confirmLabel} danger={confirm?.danger} onClose={() => setConfirm(null)} onConfirm={() => void confirm?.onConfirm()} />
    </div>
  )
}
