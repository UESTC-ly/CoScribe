import { useStore } from 'zustand'
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'
import {
  DEFAULT_SETTINGS,
  type Annotation,
  type AppSettings,
  type ChatMessage,
  type ChatSession,
  type ContextScope,
  type ContextSnapshot,
  type FileNode,
  type FileReadResult,
  type MarkdownReadingState,
  type OpenTab,
  type PaneId,
  type PdfReadingState,
  type ProjectInfo,
  type ProjectRef,
  type SearchProgress,
  type SearchResult,
  type WorkspaceState
} from '../shared/types'
import { captureContextSnapshot, cloneContextSnapshot } from '../lib/context'
import { clampAiPanelWidth, clampProjectNavigatorWidth } from '../lib/panel-layout'
import {
  cloneWorkspaceState,
  createDefaultWorkspaceState,
  findPaneForTab,
  markMissingWorkspaceTabs,
  restoreWorkspaceState,
  serializeWorkspaceState,
  type WorkspaceRestoreOptions
} from '../lib/workspace-state'
import { normalizePortablePath, samePortablePath } from '../lib/path-utils'

export interface ExternalDocumentVersion {
  content: string
  modifiedAt: number
  size: number
  url?: string
}

export interface DocumentBuffer {
  path: string
  kind: FileReadResult['kind']
  content: string
  savedContent: string
  modifiedAt: number
  size: number
  url?: string
  dirty: boolean
  externalVersion?: ExternalDocumentVersion
}

export interface DocumentContextState {
  selection?: string
  visibleText?: string
  sectionText?: string
  documentText?: string
  projectText?: string
  markdownHeading?: string
  pdfPage?: number
  visiblePages?: number[]
  updatedAt: number
}

export interface RendererStoreState {
  project: ProjectInfo | null
  recentProjects: ProjectRef[]
  fileTree: FileNode[]
  workspace: WorkspaceState
  documents: Record<string, DocumentBuffer>
  documentContexts: Record<string, DocumentContextState>
  referencedFiles: string[]
  sessions: ChatSession[]
  annotations: Annotation[]
  searchQuery: string
  searchResults: SearchResult[]
  searchProgress: SearchProgress | null
  settings: AppSettings
}

export interface RendererStoreActions {
  setProject: (project: ProjectInfo, fileTree?: FileNode[]) => void
  closeProject: () => void
  setRecentProjects: (projects: ProjectRef[]) => void
  setFileTree: (tree: FileNode[]) => void

  openTab: (tab: OpenTab, pane?: PaneId, index?: number) => void
  closeTab: (tabId: string) => void
  setActiveTab: (pane: PaneId, tabId: string) => void
  focusPane: (pane: PaneId) => void
  moveTab: (tabId: string, targetPane: PaneId, index?: number) => void
  reorderTab: (pane: PaneId, tabId: string, index: number) => void
  setSplit: (split: boolean) => void
  markPathMissing: (path: string, missing?: boolean) => void
  updatePdfState: (path: string, patch: Partial<PdfReadingState>) => void
  updateMarkdownState: (path: string, patch: Partial<MarkdownReadingState>) => void
  setNavSection: (section: WorkspaceState['navSection']) => void
  setAiVisible: (visible: boolean) => void
  setPanelWidths: (widths: { leftWidth?: number; aiWidth?: number }) => void
  restoreWorkspace: (persisted: unknown, options?: WorkspaceRestoreOptions) => void
  serializeWorkspace: () => WorkspaceState

  loadDocument: (result: FileReadResult, force?: boolean) => void
  updateDocument: (path: string, content: string) => void
  markDocumentSaved: (result: FileReadResult) => void
  discardDocumentChanges: (path: string) => void
  resolveDocumentConflict: (path: string, resolution: 'reload' | 'keep') => void
  removeDocument: (path: string) => void

  setDocumentContext: (
    path: string,
    patch: Partial<Omit<DocumentContextState, 'updatedAt'>>,
    updatedAt?: number
  ) => void
  clearDocumentContext: (path: string) => void
  setReferencedFiles: (paths: string[]) => void
  captureActiveContext: (scope?: ContextScope, capturedAt?: number) => ContextSnapshot | null

  setSessions: (sessions: ChatSession[]) => void
  createSession: (title?: string, id?: string, now?: number) => string
  setCurrentSession: (sessionId: string | null, now?: number) => void
  renameSession: (sessionId: string, title: string, now?: number) => void
  deleteSession: (sessionId: string) => void
  addMessage: (sessionId: string, message: ChatMessage) => void
  updateMessage: (
    sessionId: string,
    messageId: string,
    patch: Partial<ChatMessage> | ((message: ChatMessage) => ChatMessage),
    now?: number
  ) => void

  setAnnotations: (annotations: Annotation[]) => void
  addAnnotation: (annotation: Annotation) => void
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void
  deleteAnnotation: (id: string) => void

  setSearchQuery: (query: string) => void
  setSearchResults: (results: SearchResult[]) => void
  setSearchProgress: (progress: SearchProgress | null) => void
  resetSearch: () => void
  setSettings: (settings: AppSettings | Partial<AppSettings>) => void
}

export type AppStore = RendererStoreState & RendererStoreActions

function cloneFileNode(node: FileNode): FileNode {
  return { ...node, children: node.children?.map(cloneFileNode) }
}

function cloneFileTree(tree: readonly FileNode[]): FileNode[] {
  return tree.map(cloneFileNode)
}

function treeFilePaths(tree: readonly FileNode[]): string[] {
  const paths: string[] = []
  const visit = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      paths.push(node.path)
      if (node.children) visit(node.children)
    }
  }
  visit(tree)
  return paths
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    context: message.context ? cloneContextSnapshot(message.context) : undefined,
    sources: message.sources?.map((source) => ({ ...source })),
    operation: message.operation ? { ...message.operation } : undefined
  }
}

function cloneSession(session: ChatSession): ChatSession {
  return { ...session, messages: session.messages.map(cloneMessage) }
}

function sortedSessions(sessions: ChatSession[]): ChatSession[] {
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

function cloneAnnotation(annotation: Annotation): Annotation {
  return { ...annotation }
}

function uniqueId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId ? `${prefix}-${randomId}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizedKey(path: string): string {
  return normalizePortablePath(path)
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length
  return Math.max(0, Math.min(Math.trunc(index), length))
}

function activeTabFor(state: Pick<RendererStoreState, 'workspace'>): OpenTab | undefined {
  const pane = state.workspace.panes[state.workspace.activePane]
  return state.workspace.tabs.find((tab) => tab.id === pane.activeTabId)
}

function createInitialState(): RendererStoreState {
  return {
    project: null,
    recentProjects: [],
    fileTree: [],
    workspace: createDefaultWorkspaceState(),
    documents: {},
    documentContexts: {},
    referencedFiles: [],
    sessions: [],
    annotations: [],
    searchQuery: '',
    searchResults: [],
    searchProgress: null,
    settings: { ...DEFAULT_SETTINGS }
  }
}

export const appStoreCreator: StateCreator<AppStore> = (set, get) => ({
  ...createInitialState(),

  setProject: (project, fileTree = []) => {
    const nextTree = cloneFileTree(fileTree)
    set((state) => ({
      project: { ...project },
      recentProjects: [
        { ...project },
        ...state.recentProjects
          .filter((recent) => !samePortablePath(recent.path, project.path))
          .map((recent) => ({ ...recent }))
      ],
      fileTree: nextTree,
      workspace: createDefaultWorkspaceState(),
      documents: {},
      documentContexts: {},
      referencedFiles: [],
      sessions: [],
      annotations: [],
      searchQuery: '',
      searchResults: [],
      searchProgress: null
    }))
  },

  closeProject: () => set({
    project: null,
    fileTree: [],
    workspace: createDefaultWorkspaceState(),
    documents: {},
    documentContexts: {},
    referencedFiles: [],
    sessions: [],
    annotations: [],
    searchQuery: '',
    searchResults: [],
    searchProgress: null
  }),

  setRecentProjects: (projects) => set({ recentProjects: projects.map((project) => ({ ...project })) }),

  setFileTree: (tree) => {
    const nextTree = cloneFileTree(tree)
    const existingPaths = treeFilePaths(nextTree)
    set((state) => ({
      fileTree: nextTree,
      workspace: markMissingWorkspaceTabs(state.workspace, existingPaths)
    }))
  },

  openTab: (tab, pane, index) => set((state) => {
    const workspace = cloneWorkspaceState(state.workspace)
    const existing = workspace.tabs.find((candidate) => samePortablePath(candidate.path, tab.path))
    if (existing) {
      const existingPane = findPaneForTab(workspace, existing.id) ?? pane ?? workspace.activePane
      if (!workspace.panes[existingPane].tabIds.includes(existing.id)) {
        workspace.panes[existingPane].tabIds.push(existing.id)
      }
      workspace.panes[existingPane].activeTabId = existing.id
      workspace.activePane = existingPane
      if (existingPane === 'secondary') workspace.split = true
      existing.missing = tab.missing
      existing.name = tab.name
      existing.kind = tab.kind
      return { workspace }
    }

    let id = tab.id || uniqueId('tab')
    if (workspace.tabs.some((candidate) => candidate.id === id)) id = uniqueId('tab')
    const targetPane = pane ?? workspace.activePane
    const newTab: OpenTab = { ...tab, id, path: normalizedKey(tab.path) }
    workspace.tabs.push(newTab)
    const targetIds = workspace.panes[targetPane].tabIds
    targetIds.splice(clampIndex(index, targetIds.length), 0, id)
    workspace.panes[targetPane].activeTabId = id
    workspace.activePane = targetPane
    if (targetPane === 'secondary') workspace.split = true
    return { workspace }
  }),

  closeTab: (tabId) => set((state) => {
    if (!state.workspace.tabs.some((tab) => tab.id === tabId)) return state
    const workspace = cloneWorkspaceState(state.workspace)
    workspace.tabs = workspace.tabs.filter((tab) => tab.id !== tabId)
    for (const paneId of ['primary', 'secondary'] as const) {
      const pane = workspace.panes[paneId]
      const oldIndex = pane.tabIds.indexOf(tabId)
      if (oldIndex < 0) continue
      pane.tabIds.splice(oldIndex, 1)
      if (pane.activeTabId === tabId) {
        pane.activeTabId = pane.tabIds[Math.min(oldIndex, pane.tabIds.length - 1)] ?? null
      }
    }
    if (!workspace.split && workspace.activePane === 'secondary') workspace.activePane = 'primary'
    if (!workspace.panes[workspace.activePane].activeTabId) {
      const otherPane: PaneId = workspace.activePane === 'primary' ? 'secondary' : 'primary'
      if (workspace.split && workspace.panes[otherPane].activeTabId) workspace.activePane = otherPane
    }
    return { workspace }
  }),

  setActiveTab: (pane, tabId) => set((state) => {
    if (!state.workspace.panes[pane].tabIds.includes(tabId)) return state
    const workspace = cloneWorkspaceState(state.workspace)
    workspace.panes[pane].activeTabId = tabId
    workspace.activePane = pane
    if (pane === 'secondary') workspace.split = true
    return { workspace }
  }),

  focusPane: (pane) => set((state) => {
    if (pane === 'secondary' && !state.workspace.split) return state
    return { workspace: { ...state.workspace, activePane: pane } }
  }),

  moveTab: (tabId, targetPane, index) => set((state) => {
    if (!state.workspace.tabs.some((tab) => tab.id === tabId)) return state
    const workspace = cloneWorkspaceState(state.workspace)
    let sourcePane: PaneId | null = null
    for (const paneId of ['primary', 'secondary'] as const) {
      const pane = workspace.panes[paneId]
      const oldIndex = pane.tabIds.indexOf(tabId)
      if (oldIndex < 0) continue
      sourcePane = paneId
      pane.tabIds.splice(oldIndex, 1)
      if (pane.activeTabId === tabId) {
        pane.activeTabId = pane.tabIds[Math.min(oldIndex, pane.tabIds.length - 1)] ?? null
      }
    }
    const target = workspace.panes[targetPane]
    target.tabIds.splice(clampIndex(index, target.tabIds.length), 0, tabId)
    target.activeTabId = tabId
    workspace.activePane = targetPane
    if (targetPane === 'secondary') workspace.split = true
    if (sourcePane === targetPane && target.tabIds.filter((id) => id === tabId).length > 1) {
      target.tabIds = target.tabIds.filter((id, position) => id !== tabId || position === target.tabIds.indexOf(id))
    }
    return { workspace }
  }),

  reorderTab: (pane, tabId, index) => get().moveTab(tabId, pane, index),

  setSplit: (split) => set((state) => ({
    workspace: {
      ...state.workspace,
      split,
      activePane: split ? state.workspace.activePane : 'primary'
    }
  })),

  markPathMissing: (path, missing = true) => set((state) => ({
    workspace: {
      ...state.workspace,
      tabs: state.workspace.tabs.map((tab) => samePortablePath(tab.path, path)
        ? { ...tab, missing: missing || undefined }
        : tab)
    }
  })),

  updatePdfState: (path, patch) => set((state) => {
    const key = normalizedKey(path)
    const current = state.workspace.pdf[key] ?? { page: 1, scale: 1, fit: 'width', scrollTop: 0 }
    return {
      workspace: {
        ...state.workspace,
        pdf: { ...state.workspace.pdf, [key]: { ...current, ...patch } }
      }
    }
  }),

  updateMarkdownState: (path, patch) => set((state) => {
    const key = normalizedKey(path)
    const current = state.workspace.markdown[key] ?? { scrollTop: 0, cursor: 0, mode: 'both' }
    return {
      workspace: {
        ...state.workspace,
        markdown: { ...state.workspace.markdown, [key]: { ...current, ...patch } }
      }
    }
  }),

  setNavSection: (navSection) => set((state) => ({ workspace: { ...state.workspace, navSection } })),
  setAiVisible: (aiVisible) => set((state) => ({ workspace: { ...state.workspace, aiVisible } })),
  setPanelWidths: ({ leftWidth, aiWidth }) => set((state) => ({
    workspace: {
      ...state.workspace,
      leftWidth: leftWidth === undefined ? state.workspace.leftWidth : clampProjectNavigatorWidth(leftWidth),
      aiWidth: aiWidth === undefined ? state.workspace.aiWidth : clampAiPanelWidth(aiWidth)
    }
  })),

  restoreWorkspace: (persisted, options) => set({ workspace: restoreWorkspaceState(persisted, options) }),
  serializeWorkspace: () => serializeWorkspaceState(get().workspace),

  loadDocument: (result, force = false) => set((state) => {
    const key = normalizedKey(result.path)
    const current = state.documents[key]
    if (current?.dirty && !force && current.savedContent !== result.content) {
      return {
        documents: {
          ...state.documents,
          [key]: {
            ...current,
            externalVersion: {
              content: result.content,
              modifiedAt: result.modifiedAt,
              size: result.size,
              url: result.url
            }
          }
        }
      }
    }
    if (current?.dirty && !force && current.savedContent === result.content) {
      return {
        documents: {
          ...state.documents,
          [key]: { ...current, modifiedAt: result.modifiedAt, size: result.size, url: result.url }
        }
      }
    }
    return {
      documents: {
        ...state.documents,
        [key]: {
          path: key,
          kind: result.kind,
          content: result.content,
          savedContent: result.content,
          modifiedAt: result.modifiedAt,
          size: result.size,
          url: result.url,
          dirty: false
        }
      }
    }
  }),

  updateDocument: (path, content) => set((state) => {
    const key = normalizedKey(path)
    const current = state.documents[key]
    if (!current) return state
    return {
      documents: {
        ...state.documents,
        [key]: { ...current, content, dirty: content !== current.savedContent }
      }
    }
  }),

  markDocumentSaved: (result) => set((state) => {
    const key = normalizedKey(result.path)
    const current = state.documents[key]
    const content = current && current.content !== current.savedContent && current.content !== result.content
      ? current.content
      : result.content
    return {
      documents: {
        ...state.documents,
        [key]: {
          path: key,
          kind: result.kind,
          content,
          savedContent: result.content,
          modifiedAt: result.modifiedAt,
          size: result.size,
          url: result.url,
          dirty: content !== result.content
        }
      }
    }
  }),

  discardDocumentChanges: (path) => set((state) => {
    const key = normalizedKey(path)
    const current = state.documents[key]
    if (!current) return state
    return {
      documents: {
        ...state.documents,
        [key]: { ...current, content: current.savedContent, dirty: false, externalVersion: undefined }
      }
    }
  }),

  resolveDocumentConflict: (path, resolution) => set((state) => {
    const key = normalizedKey(path)
    const current = state.documents[key]
    const external = current?.externalVersion
    if (!current || !external) return state
    const next: DocumentBuffer = resolution === 'reload'
      ? {
          ...current,
          content: external.content,
          savedContent: external.content,
          modifiedAt: external.modifiedAt,
          size: external.size,
          url: external.url,
          dirty: false,
          externalVersion: undefined
        }
      : {
          ...current,
          savedContent: external.content,
          modifiedAt: external.modifiedAt,
          size: external.size,
          url: external.url,
          dirty: current.content !== external.content,
          externalVersion: undefined
        }
    return { documents: { ...state.documents, [key]: next } }
  }),

  removeDocument: (path) => set((state) => {
    const key = normalizedKey(path)
    const documents = { ...state.documents }
    delete documents[key]
    return { documents }
  }),

  setDocumentContext: (path, patch, updatedAt = Date.now()) => set((state) => {
    const key = normalizedKey(path)
    const current = state.documentContexts[key] ?? { updatedAt }
    const next: DocumentContextState = { ...current, ...patch, updatedAt }
    if (Object.prototype.hasOwnProperty.call(patch, 'visiblePages')) {
      next.visiblePages = patch.visiblePages ? [...patch.visiblePages] : undefined
    }
    return {
      documentContexts: {
        ...state.documentContexts,
        [key]: next
      }
    }
  }),

  clearDocumentContext: (path) => set((state) => {
    const key = normalizedKey(path)
    const documentContexts = { ...state.documentContexts }
    delete documentContexts[key]
    return { documentContexts }
  }),

  setReferencedFiles: (paths) => set({ referencedFiles: [...new Set(paths.map(normalizedKey).filter(Boolean))] }),

  captureActiveContext: (scope, capturedAt) => {
    const state = get()
    if (!state.project) return null
    const tab = activeTabFor(state)
    const key = tab ? normalizedKey(tab.path) : undefined
    const context = key ? state.documentContexts[key] : undefined
    const document = key ? state.documents[key] : undefined
    const pdfState = key ? state.workspace.pdf[key] : undefined
    return captureContextSnapshot({
      projectName: state.project.name,
      projectPath: state.project.path,
      pane: state.workspace.activePane,
      documentPath: tab?.path,
      documentName: tab?.name,
      kind: tab?.kind,
      pdfPage: context?.pdfPage ?? pdfState?.page,
      visiblePages: context?.visiblePages ? [...context.visiblePages] : undefined,
      markdownHeading: context?.markdownHeading,
      selection: context?.selection,
      visibleText: context?.visibleText,
      sectionText: context?.sectionText,
      documentText: context?.documentText ?? document?.content,
      projectText: context?.projectText,
      referencedFiles: [...state.referencedFiles],
      capturedAt
    }, scope ?? state.settings.defaultContextScope)
  },

  setSessions: (sessions) => set((state) => {
    const next = sortedSessions(sessions.map(cloneSession))
    const current = state.workspace.currentSessionId
    return {
      sessions: next,
      workspace: {
        ...state.workspace,
        currentSessionId: current && next.some((session) => session.id === current)
          ? current
          : next[0]?.id ?? null
      }
    }
  }),

  createSession: (title = '新会话', id = uniqueId('session'), now = Date.now()) => {
    const safeId = get().sessions.some((session) => session.id === id) ? uniqueId('session') : id
    const session: ChatSession = {
      id: safeId,
      title: title.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    set((state) => ({
      sessions: sortedSessions([session, ...state.sessions.map(cloneSession)]),
      workspace: { ...state.workspace, currentSessionId: safeId }
    }))
    return safeId
  },

  setCurrentSession: (sessionId, now = Date.now()) => set((state) => {
    if (sessionId !== null && !state.sessions.some((session) => session.id === sessionId)) return state
    return {
      sessions: sessionId === null
        ? state.sessions
        : sortedSessions(state.sessions.map((session) => session.id === sessionId
            ? { ...cloneSession(session), updatedAt: Math.max(session.updatedAt, now) }
            : cloneSession(session))),
      workspace: { ...state.workspace, currentSessionId: sessionId }
    }
  }),

  renameSession: (sessionId, title, now = Date.now()) => set((state) => ({
    sessions: sortedSessions(state.sessions.map((session) => session.id === sessionId
      ? { ...cloneSession(session), title: title.trim() || session.title, updatedAt: now }
      : cloneSession(session)))
  })),

  deleteSession: (sessionId) => set((state) => {
    const sessions = state.sessions.filter((session) => session.id !== sessionId).map(cloneSession)
    return {
      sessions,
      workspace: {
        ...state.workspace,
        currentSessionId: state.workspace.currentSessionId === sessionId
          ? sessions[0]?.id ?? null
          : state.workspace.currentSessionId
      }
    }
  }),

  addMessage: (sessionId, message) => set((state) => ({
    sessions: sortedSessions(state.sessions.map((session) => session.id === sessionId
      ? {
          ...cloneSession(session),
          updatedAt: Math.max(session.updatedAt, message.createdAt),
          messages: [...session.messages.map(cloneMessage), cloneMessage(message)]
        }
      : cloneSession(session)))
  })),

  updateMessage: (sessionId, messageId, patch, now = Date.now()) => set((state) => ({
    sessions: sortedSessions(state.sessions.map((session) => session.id === sessionId
      ? {
          ...cloneSession(session),
          updatedAt: now,
          messages: session.messages.map((message) => {
            if (message.id !== messageId) return cloneMessage(message)
            const next = typeof patch === 'function'
              ? patch(cloneMessage(message))
              : { ...cloneMessage(message), ...patch }
            return cloneMessage(next)
          })
        }
      : cloneSession(session)))
  })),

  setAnnotations: (annotations) => set({
    annotations: annotations.map(cloneAnnotation).sort((left, right) => right.createdAt - left.createdAt)
  }),
  addAnnotation: (annotation) => set((state) => ({
    annotations: [cloneAnnotation(annotation), ...state.annotations.filter((item) => item.id !== annotation.id).map(cloneAnnotation)]
  })),
  updateAnnotation: (id, patch) => set((state) => ({
    annotations: state.annotations.map((annotation) => annotation.id === id
      ? { ...annotation, ...patch, id: annotation.id }
      : annotation)
  })),
  deleteAnnotation: (id) => set((state) => ({
    annotations: state.annotations.filter((annotation) => annotation.id !== id)
  })),

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchResults: (searchResults) => set({ searchResults: searchResults.map((result) => ({ ...result })) }),
  setSearchProgress: (searchProgress) => set({ searchProgress: searchProgress ? { ...searchProgress } : null }),
  resetSearch: () => set({ searchQuery: '', searchResults: [], searchProgress: null }),
  setSettings: (settings) => set((state) => ({ settings: { ...state.settings, ...settings } }))
})

export function createAppStore(): StoreApi<AppStore> {
  return createStore<AppStore>()(appStoreCreator)
}

export const appStore = createAppStore()

export function useAppStore(): AppStore
export function useAppStore<T>(selector: (state: AppStore) => T): T
export function useAppStore<T = AppStore>(selector?: (state: AppStore) => T): T {
  return useStore(appStore, selector ?? ((state) => state as unknown as T))
}

export function selectActiveTab(state: RendererStoreState): OpenTab | undefined {
  return activeTabFor(state)
}

export function selectActiveDocument(state: RendererStoreState): DocumentBuffer | undefined {
  const tab = activeTabFor(state)
  return tab ? state.documents[normalizedKey(tab.path)] : undefined
}

export function selectCurrentSession(state: RendererStoreState): ChatSession | undefined {
  return state.sessions.find((session) => session.id === state.workspace.currentSessionId)
}

export function selectDirtyDocuments(state: RendererStoreState): DocumentBuffer[] {
  return Object.values(state.documents).filter((document) => document.dirty)
}

export function selectAnnotationsForPath(state: RendererStoreState, path: string): Annotation[] {
  return state.annotations.filter((annotation) => samePortablePath(annotation.path, path))
}
