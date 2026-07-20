import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat
} from 'node:fs/promises'
import path from 'node:path'

import chokidar, { type FSWatcher } from 'chokidar'
import { app, dialog, shell } from 'electron'

import {
  DEFAULT_WORKSPACE_STATE,
  type Annotation,
  type ChatMessage,
  type ChatSession,
  type ContextSnapshot,
  type FileChangeEvent,
  type FileKind,
  type FileNode,
  type FileOperationProposal,
  type FileReadResult,
  type ProjectInfo,
  type ProjectRef,
  type SourceRef,
  type WorkspaceState
} from '../../src/shared/types'
import { assertNotMetadataPath, assertSafeName, canonicalDirectory, isInside, ProjectPathGuard } from './security'
import { SettingsStore } from './settings'
import { atomicCreate, atomicWrite, atomicWriteJson, readJson } from './storage'

const METADATA_DIRECTORY = '.vibeknowledge'
const MAX_RECENT_PROJECTS = 20
const MAX_TEXT_FILE_SIZE = 32 * 1024 * 1024
const MAX_SESSIONS = 200
const MAX_MESSAGES_PER_SESSION = 2_000
const MAX_MESSAGE_CHARS = 2 * 1024 * 1024

const IGNORED_PROJECT_ENTRY_NAMES = new Set([
  METADATA_DIRECTORY,
  '.DS_Store',
  'Thumbs.db',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__'
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.go',
  '.rs',
  '.sh',
  '.sql'
])

export function fileKind(filePath: string, directory = false): FileKind {
  if (directory) return 'folder'
  const extension = path.extname(filePath).toLocaleLowerCase()
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'unsupported'
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isIgnoredProjectPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  return relative.split(path.sep).some((segment) => IGNORED_PROJECT_ENTRY_NAMES.has(segment))
}

async function assertAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath)
    throw new Error('目标已存在，请更换名称。')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function normalizedWorkspace(input: unknown, root: string): WorkspaceState {
  const fallback = structuredClone(DEFAULT_WORKSPACE_STATE)
  if (!input || typeof input !== 'object') return fallback
  const candidate = input as Partial<WorkspaceState>
  if (candidate.version !== 1 || !Array.isArray(candidate.tabs)) return fallback

  const tabs = candidate.tabs.filter((tab) => {
    if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string' || typeof tab.path !== 'string') return false
    const resolved = path.resolve(root, tab.path)
    return isInside(root, resolved) && !isInside(path.join(root, METADATA_DIRECTORY), resolved)
  })
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const pane = (name: 'primary' | 'secondary') => {
    const value = candidate.panes?.[name]
    const ids = Array.isArray(value?.tabIds) ? value.tabIds.filter((id) => typeof id === 'string' && tabIds.has(id)) : []
    return {
      tabIds: ids,
      activeTabId: typeof value?.activeTabId === 'string' && ids.includes(value.activeTabId) ? value.activeTabId : (ids[0] ?? null)
    }
  }

  return {
    ...fallback,
    ...candidate,
    version: 1,
    tabs,
    panes: { primary: pane('primary'), secondary: pane('secondary') },
    activePane: candidate.activePane === 'secondary' ? 'secondary' : 'primary',
    split: Boolean(candidate.split),
    pdf: candidate.pdf && typeof candidate.pdf === 'object' ? candidate.pdf : {},
    markdown: candidate.markdown && typeof candidate.markdown === 'object' ? candidate.markdown : {},
    navSection:
      candidate.navSection === 'sessions' || candidate.navSection === 'search' || candidate.navSection === 'annotations'
        ? candidate.navSection
        : 'files',
    aiVisible: candidate.aiVisible !== false,
    leftWidth: typeof candidate.leftWidth === 'number' ? candidate.leftWidth : fallback.leftWidth,
    aiWidth: typeof candidate.aiWidth === 'number' ? candidate.aiWidth : fallback.aiWidth,
    currentSessionId: typeof candidate.currentSessionId === 'string' ? candidate.currentSessionId : null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maximum) : undefined
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function metadataProjectPath(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const resolved = path.resolve(root, value)
  if (!isInside(root, resolved) || isInside(path.join(root, METADATA_DIRECTORY), resolved)) return undefined
  return resolved
}

function normalizedContext(value: unknown, root: string): ContextSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const scopes = new Set(['selection', 'visible', 'document', 'project', 'general'])
  const kinds = new Set(['folder', 'markdown', 'pdf', 'image', 'text', 'unsupported'])
  const scope = typeof value.scope === 'string' && scopes.has(value.scope) ? value.scope as ContextSnapshot['scope'] : undefined
  if (!scope) return undefined
  const documentPath = metadataProjectPath(value.documentPath, root)
  const referencedFiles = Array.isArray(value.referencedFiles)
    ? value.referencedFiles.map((candidate) => metadataProjectPath(candidate, root)).filter((candidate): candidate is string => Boolean(candidate)).slice(0, 20)
    : []
  return {
    projectName: text(value.projectName, 500) ?? path.basename(root),
    projectPath: root,
    pane: value.pane === 'secondary' ? 'secondary' : 'primary',
    ...(documentPath ? { documentPath } : {}),
    ...(text(value.documentName, 1_000) ? { documentName: text(value.documentName, 1_000) } : {}),
    ...(typeof value.kind === 'string' && kinds.has(value.kind) ? { kind: value.kind as ContextSnapshot['kind'] } : {}),
    ...(typeof value.pdfPage === 'number' && Number.isInteger(value.pdfPage) && value.pdfPage > 0 ? { pdfPage: value.pdfPage } : {}),
    ...(Array.isArray(value.visiblePages) ? { visiblePages: value.visiblePages.filter((page): page is number => typeof page === 'number' && Number.isInteger(page) && page > 0).slice(0, 20) } : {}),
    ...(text(value.markdownHeading, 2_000) ? { markdownHeading: text(value.markdownHeading, 2_000) } : {}),
    ...(text(value.selection, MAX_MESSAGE_CHARS) ? { selection: text(value.selection, MAX_MESSAGE_CHARS) } : {}),
    ...(text(value.visibleText, MAX_MESSAGE_CHARS) ? { visibleText: text(value.visibleText, MAX_MESSAGE_CHARS) } : {}),
    ...(text(value.sectionText, MAX_MESSAGE_CHARS) ? { sectionText: text(value.sectionText, MAX_MESSAGE_CHARS) } : {}),
    ...(text(value.documentText, MAX_MESSAGE_CHARS) ? { documentText: text(value.documentText, MAX_MESSAGE_CHARS) } : {}),
    scope,
    referencedFiles,
    capturedAt: timestamp(value.capturedAt, Date.now())
  }
}

function normalizedSource(value: unknown, root: string): SourceRef | undefined {
  if (!isRecord(value)) return undefined
  const kinds = new Set(['pdf', 'markdown', 'text', 'session', 'general'])
  if (typeof value.kind !== 'string' || !kinds.has(value.kind)) return undefined
  const kind = value.kind as SourceRef['kind']
  const sourcePath = kind === 'session' || kind === 'general'
    ? text(value.path, 4_000) ?? ''
    : metadataProjectPath(value.path, root)
  if (sourcePath === undefined) return undefined
  return {
    path: sourcePath,
    label: text(value.label, 1_000) ?? path.basename(sourcePath),
    kind,
    ...(typeof value.page === 'number' && Number.isInteger(value.page) && value.page > 0 ? { page: value.page } : {}),
    ...(text(value.heading, 2_000) ? { heading: text(value.heading, 2_000) } : {}),
    ...(typeof value.line === 'number' && Number.isInteger(value.line) && value.line > 0 ? { line: value.line } : {}),
    ...(text(value.excerpt, 20_000) ? { excerpt: text(value.excerpt, 20_000) } : {})
  }
}

function normalizedOperation(value: unknown, root: string): FileOperationProposal | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined
  if (value.kind !== 'create' && value.kind !== 'append' && value.kind !== 'replace') return undefined
  const targetPath = metadataProjectPath(value.targetPath, root)
  const proposedContent = text(value.proposedContent, 8 * 1024 * 1024)
  if (!targetPath || !/\.(?:md|markdown)$/iu.test(targetPath) || proposedContent === undefined) return undefined
  const savedStatus = value.status === 'accepted' || value.status === 'rejected' || value.status === 'failed'
    ? value.status
    : 'failed'
  return {
    id: value.id.slice(0, 500),
    kind: value.kind,
    targetPath,
    proposedContent,
    ...(text(value.originalContent, 8 * 1024 * 1024) !== undefined ? { originalContent: text(value.originalContent, 8 * 1024 * 1024) } : {}),
    ...(typeof value.expectedModifiedAt === 'number' && Number.isFinite(value.expectedModifiedAt) ? { expectedModifiedAt: value.expectedModifiedAt } : {}),
    summary: text(value.summary, 500) ?? `${value.kind} ${path.basename(targetPath)}`,
    status: savedStatus,
    ...(savedStatus === 'failed' ? { error: text(value.error, 20_000) ?? '应用已重新启动，请重新生成这项文件建议。' } : {})
  }
}

function normalizedMessage(value: unknown, root: string): ChatMessage | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system') return undefined
  const content = text(value.content, MAX_MESSAGE_CHARS)
  if (content === undefined) return undefined
  const context = normalizedContext(value.context, root)
  const sources = Array.isArray(value.sources)
    ? value.sources.map((source) => normalizedSource(source, root)).filter((source): source is SourceRef => Boolean(source)).slice(0, 100)
    : undefined
  const operation = normalizedOperation(value.operation, root)
  return {
    id: value.id.slice(0, 500),
    role: value.role,
    content,
    createdAt: timestamp(value.createdAt, Date.now()),
    ...(context ? { context } : {}),
    ...(sources?.length ? { sources } : {}),
    ...(operation ? { operation } : {}),
    ...(value.stopped === true ? { stopped: true } : {}),
    ...(text(value.error, 20_000) ? { error: text(value.error, 20_000) } : {})
  }
}

export function normalizeSessionsForProject(value: unknown, root: string): ChatSession[] {
  if (!Array.isArray(value)) return []
  const sessions: ChatSession[] = []
  for (const candidate of value.slice(0, MAX_SESSIONS)) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim()) continue
    const createdAt = timestamp(candidate.createdAt, Date.now())
    const messages = Array.isArray(candidate.messages)
      ? candidate.messages.slice(0, MAX_MESSAGES_PER_SESSION).map((message) => normalizedMessage(message, root)).filter((message): message is ChatMessage => Boolean(message))
      : []
    sessions.push({
      id: candidate.id.slice(0, 500),
      title: text(candidate.title, 500)?.trim() || '未命名会话',
      createdAt,
      updatedAt: timestamp(candidate.updatedAt, createdAt),
      messages
    })
  }
  return sessions
}

export function normalizeAnnotationsForProject(value: unknown, root: string): Annotation[] {
  if (!Array.isArray(value)) return []
  const kinds = new Set(['highlight', 'comment', 'bookmark'])
  const colors = new Set(['amber', 'mint', 'blue', 'rose'])
  return value.slice(0, 20_000).flatMap((candidate): Annotation[] => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim()) return []
    const annotationPath = metadataProjectPath(candidate.path, root)
    if (!annotationPath || typeof candidate.page !== 'number' || !Number.isInteger(candidate.page) || candidate.page < 1) return []
    if (typeof candidate.kind !== 'string' || !kinds.has(candidate.kind)) return []
    return [{
      id: candidate.id.slice(0, 500),
      path: annotationPath,
      page: candidate.page,
      kind: candidate.kind as Annotation['kind'],
      ...(text(candidate.quote, 100_000) ? { quote: text(candidate.quote, 100_000) } : {}),
      ...(text(candidate.comment, 100_000) ? { comment: text(candidate.comment, 100_000) } : {}),
      ...(typeof candidate.color === 'string' && colors.has(candidate.color) ? { color: candidate.color as Annotation['color'] } : {}),
      createdAt: timestamp(candidate.createdAt, Date.now())
    }]
  })
}

interface OperationInput {
  kind: unknown
  targetPath: unknown
  proposedContent: unknown
  summary?: unknown
}

interface PendingOperation {
  proposal: FileOperationProposal
  createdAt: number
}

export class ProjectService {
  private guardValue: ProjectPathGuard | null = null
  private currentInfo: ProjectInfo | null = null
  private watcher: FSWatcher | null = null
  private watcherTimer: NodeJS.Timeout | null = null
  private readonly queuedEvents = new Map<string, FileChangeEvent>()
  private readonly pendingOperations = new Map<string, PendingOperation>()
  private initialPath: string | null = null

  constructor(
    private readonly settings: SettingsStore,
    private readonly emitFilesChanged: (events: FileChangeEvent[]) => void,
    private readonly onFileChanged: (filePath?: string) => void
  ) {}

  get guard(): ProjectPathGuard {
    if (!this.guardValue) throw new Error('请先打开一个项目。')
    return this.guardValue
  }

  get info(): ProjectInfo {
    if (!this.currentInfo) throw new Error('请先打开一个项目。')
    return this.currentInfo
  }

  setInitialPath(value: string): void {
    this.initialPath = value
  }

  private get recentFile(): string {
    return path.join(app.getPath('userData'), 'recent-projects.json')
  }

  private async metadataFile(name: 'workspace' | 'sessions' | 'annotations'): Promise<string> {
    await this.ensureMetadata(this.guard.root)
    const filePath = path.join(this.guard.root, METADATA_DIRECTORY, `${name}.json`)
    try {
      const info = await lstat(filePath)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('项目元数据文件不是普通文件。')
      const canonical = await realpath(filePath)
      if (!isInside(this.guard.root, canonical)) throw new Error('项目元数据文件越界。')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return filePath
  }

  private async writeMetadata(name: 'workspace' | 'sessions' | 'annotations', value: unknown): Promise<void> {
    const filePath = await this.metadataFile(name)
    const directoryIdentity = await this.guard.identity(path.dirname(filePath), 'directory')
    const verify = () => this.guard.verifyIdentity(directoryIdentity)
    await atomicWriteJson(filePath, value, verify)
  }

  private async ensureMetadata(root: string): Promise<void> {
    const metadataPath = path.join(root, METADATA_DIRECTORY)
    try {
      const info = await lstat(metadataPath)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`${METADATA_DIRECTORY} 必须是项目内的普通文件夹。`)
      }
      const canonical = await realpath(metadataPath)
      if (!isInside(root, canonical)) throw new Error('项目元数据目录越界。')
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(metadataPath, { mode: 0o700 })
    }
  }

  private async readRecentRaw(): Promise<ProjectRef[]> {
    const value = await readJson<unknown>(this.recentFile, [])
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is ProjectRef =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as ProjectRef).name === 'string' &&
        typeof (item as ProjectRef).path === 'string' &&
        typeof (item as ProjectRef).openedAt === 'number'
    )
  }

  async recent(): Promise<ProjectRef[]> {
    const entries = await this.readRecentRaw()
    return Promise.all(
      entries.map(async (entry) => {
        try {
          return { ...entry, exists: (await stat(entry.path)).isDirectory() }
        } catch {
          return { ...entry, exists: false }
        }
      })
    )
  }

  private async remember(info: ProjectInfo): Promise<void> {
    const entries = await this.readRecentRaw()
    const next: ProjectRef[] = [
      { name: info.name, path: info.path, openedAt: info.openedAt, exists: true },
      ...entries.filter((entry) => entry.path !== info.path)
    ].slice(0, MAX_RECENT_PROJECTS)
    await atomicWriteJson(this.recentFile, next)
  }

  async chooseLocation(): Promise<string | null> {
    const preferences = await this.settings.get()
    const result = await dialog.showOpenDialog({
      title: '选择项目保存位置',
      defaultPath: preferences.defaultProjectPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  async create(name: string, parentPath: string): Promise<ProjectInfo> {
    const safeName = assertSafeName(name, '项目名称')
    const parent = await canonicalDirectory(parentPath)
    const target = path.join(parent, safeName)
    await mkdir(target, { mode: 0o700 })
    return this.openPath(target, Date.now())
  }

  async openDialog(): Promise<ProjectInfo | null> {
    const result = await dialog.showOpenDialog({ title: '打开本地项目', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return this.openPath(result.filePaths[0])
  }

  async openPath(inputPath: string, createdAt?: number): Promise<ProjectInfo> {
    const root = await canonicalDirectory(inputPath)
    await this.ensureMetadata(root)
    await this.stopWatcher()
    this.guardValue = new ProjectPathGuard(root)
    const rootInfo = await stat(root)
    const info: ProjectInfo = {
      name: path.basename(root),
      path: root,
      openedAt: Date.now(),
      exists: true,
      createdAt: createdAt ?? rootInfo.birthtimeMs
    }
    this.currentInfo = info
    this.pendingOperations.clear()
    await this.remember(info)
    await this.startWatcher()
    return info
  }

  async initial(): Promise<ProjectInfo | null> {
    if (this.currentInfo) return this.currentInfo
    if (!this.initialPath) return null
    const candidate = this.initialPath
    this.initialPath = null
    try {
      return await this.openPath(candidate)
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    await this.stopWatcher()
    this.guardValue = null
    this.currentInfo = null
    this.pendingOperations.clear()
    this.onFileChanged()
  }

  private async startWatcher(): Promise<void> {
    const root = this.guard.root
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (watchedPath) => isIgnoredProjectPath(root, path.resolve(watchedPath)),
      awaitWriteFinish: { stabilityThreshold: 220, pollInterval: 50 }
    })
    const enqueue = (type: FileChangeEvent['type'], changedPath: string) => {
      const absolute = path.resolve(changedPath)
      if (!isInside(root, absolute) || isIgnoredProjectPath(root, absolute)) return
      const event = { type, path: absolute }
      this.queuedEvents.set(`${type}:${absolute}`, event)
      this.onFileChanged(absolute)
      if (this.watcherTimer) clearTimeout(this.watcherTimer)
      this.watcherTimer = setTimeout(() => {
        const events = [...this.queuedEvents.values()]
        this.queuedEvents.clear()
        this.watcherTimer = null
        if (events.length > 0) this.emitFilesChanged(events)
      }, 120)
    }
    this.watcher.on('add', (value) => enqueue('add', value))
    this.watcher.on('change', (value) => enqueue('change', value))
    this.watcher.on('unlink', (value) => enqueue('unlink', value))
    this.watcher.on('addDir', (value) => enqueue('addDir', value))
    this.watcher.on('unlinkDir', (value) => enqueue('unlinkDir', value))
    this.watcher.on('error', () => {
      // Individual unreadable or non-file entries must not crash an otherwise usable project.
    })
  }

  private async stopWatcher(): Promise<void> {
    if (this.watcherTimer) clearTimeout(this.watcherTimer)
    this.watcherTimer = null
    this.queuedEvents.clear()
    await this.watcher?.close()
    this.watcher = null
  }

  private async node(filePath: string): Promise<FileNode | null> {
    const info = await lstat(filePath)
    if (info.isSymbolicLink()) {
      return { name: path.basename(filePath), path: filePath, kind: 'unsupported', size: 0, modifiedAt: info.mtimeMs }
    }
    if (info.isDirectory()) {
      let names: string[] = []
      try {
        names = await readdir(filePath)
      } catch {
        return { name: path.basename(filePath), path: filePath, kind: 'folder', size: 0, modifiedAt: info.mtimeMs, children: [] }
      }
      const entries = (
        await Promise.all(
          names
            .filter((name) => !IGNORED_PROJECT_ENTRY_NAMES.has(name))
            .map((name) => this.node(path.join(filePath, name)).catch(() => null))
        )
      ).filter((entry): entry is FileNode => entry !== null)
      entries.sort((left, right) => {
        if (left.kind === 'folder' && right.kind !== 'folder') return -1
        if (left.kind !== 'folder' && right.kind === 'folder') return 1
        return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      })
      return { name: path.basename(filePath), path: filePath, kind: 'folder', size: 0, modifiedAt: info.mtimeMs, children: entries }
    }
    return {
      name: path.basename(filePath),
      path: filePath,
      kind: fileKind(filePath),
      size: info.size,
      modifiedAt: info.mtimeMs
    }
  }

  async tree(): Promise<FileNode[]> {
    const names = await readdir(this.guard.root)
    const nodes = (
      await Promise.all(
        names
          .filter((name) => !IGNORED_PROJECT_ENTRY_NAMES.has(name))
          .map((name) => this.node(path.join(this.guard.root, name)).catch(() => null))
      )
    ).filter((entry): entry is FileNode => entry !== null)
    nodes.sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1
      if (left.kind !== 'folder' && right.kind === 'folder') return 1
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
    })
    return nodes
  }

  async getState(): Promise<WorkspaceState> {
    const raw = await readJson<unknown>(await this.metadataFile('workspace'), DEFAULT_WORKSPACE_STATE)
    return normalizedWorkspace(raw, this.guard.root)
  }

  async saveState(state: WorkspaceState): Promise<void> {
    await this.writeMetadata('workspace', normalizedWorkspace(state, this.guard.root))
  }

  async listSessions(): Promise<ChatSession[]> {
    const value = await readJson<unknown>(await this.metadataFile('sessions'), [])
    return normalizeSessionsForProject(value, this.guard.root)
  }

  async saveSessions(sessions: ChatSession[]): Promise<void> {
    if (!Array.isArray(sessions)) throw new Error('会话数据格式无效。')
    await this.writeMetadata('sessions', normalizeSessionsForProject(sessions, this.guard.root))
  }

  async listAnnotations(): Promise<Annotation[]> {
    const value = await readJson<unknown>(await this.metadataFile('annotations'), [])
    return normalizeAnnotationsForProject(value, this.guard.root)
  }

  async saveAnnotations(annotations: Annotation[]): Promise<void> {
    if (!Array.isArray(annotations)) throw new Error('标注数据格式无效。')
    await this.writeMetadata('annotations', normalizeAnnotationsForProject(annotations, this.guard.root))
  }

  urlFor(canonicalPath: string): string {
    const relative = path.relative(this.guard.root, canonicalPath)
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
    return `coscribe-file://project/${encoded}`
  }

  async pathFromProtocol(url: string): Promise<string> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'coscribe-file:' || parsed.hostname !== 'project') throw new Error('无效的项目文件 URL。')
    let relative: string
    try {
      relative = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    } catch {
      throw new Error('项目文件 URL 编码无效。')
    }
    return this.guard.existing(relative, 'file')
  }

  async read(inputPath: string): Promise<FileReadResult> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const info = await stat(canonical)
    const kind = fileKind(canonical)
    let content = ''
    if (kind === 'markdown' || kind === 'text') {
      if (info.size > MAX_TEXT_FILE_SIZE) throw new Error('文本文件超过 32 MB，无法直接打开。')
      const descriptor = await this.guard.openReadOnly(canonical)
      try {
        content = await descriptor.readFile('utf8')
      } finally {
        await descriptor.close()
      }
    }
    return {
      path: canonical,
      kind,
      content,
      modifiedAt: info.mtimeMs,
      size: info.size,
      ...(kind === 'pdf' || kind === 'image' ? { url: this.urlFor(canonical) } : {})
    }
  }

  private async assertUnchanged(canonical: string, expectedModifiedAt?: number): Promise<{ mode: number; modifiedAt: number }> {
    const info = await stat(canonical)
    if (typeof expectedModifiedAt === 'number' && Math.abs(info.mtimeMs - expectedModifiedAt) > 1) {
      throw new Error('文件已被其他程序修改。请重新加载或查看差异后再保存。')
    }
    return { mode: info.mode & 0o777, modifiedAt: info.mtimeMs }
  }

  async saveMarkdown(inputPath: string, content: string, expectedModifiedAt?: number): Promise<FileReadResult> {
    if (typeof content !== 'string') throw new Error('Markdown 内容格式无效。')
    const canonical = await this.guard.assertMarkdown(inputPath, true)
    assertNotMetadataPath(this.guard.root, canonical)
    const { mode, modifiedAt } = await this.assertUnchanged(canonical, expectedModifiedAt)
    const parentIdentity = await this.guard.identity(path.dirname(canonical), 'directory')
    const targetIdentity = await this.guard.identity(canonical, 'file')
    const verify = async () => {
      await this.guard.verifyIdentity(parentIdentity)
      await this.guard.verifyIdentity(targetIdentity)
      await this.assertUnchanged(canonical, modifiedAt)
      const checked = await this.guard.assertMarkdown(canonical, true)
      if (checked !== canonical) throw new Error('写入目标在校验后发生变化。')
    }
    await atomicWrite(canonical, content, mode, verify)
    await this.guard.existing(canonical, 'file')
    return this.read(canonical)
  }

  async createMarkdown(inputPath: string, content = ''): Promise<FileReadResult> {
    if (typeof content !== 'string') throw new Error('Markdown 内容格式无效。')
    const canonical = await this.guard.assertMarkdown(inputPath, false)
    assertNotMetadataPath(this.guard.root, canonical)
    await assertAbsent(canonical)
    const parentIdentity = await this.guard.identity(path.dirname(canonical), 'directory')
    const verify = async () => {
      await this.guard.verifyIdentity(parentIdentity)
      const checked = await this.guard.assertMarkdown(canonical, false)
      if (checked !== canonical) throw new Error('写入目标在校验后发生变化。')
      await assertAbsent(canonical)
    }
    await atomicCreate(canonical, content, verify)
    await this.guard.existing(canonical, 'file')
    return this.read(canonical)
  }

  async createFolder(inputPath: string): Promise<void> {
    const canonical = await this.guard.target(inputPath)
    assertNotMetadataPath(this.guard.root, canonical)
    await assertAbsent(canonical)
    const parentIdentity = await this.guard.identity(path.dirname(canonical), 'directory')
    await this.guard.verifyIdentity(parentIdentity)
    const checked = await this.guard.target(canonical)
    if (checked !== canonical) throw new Error('文件夹目标在校验后发生变化。')
    await mkdir(canonical)
    await this.guard.existing(canonical, 'directory')
  }

  async rename(inputPath: string, nextName: string): Promise<string> {
    const source = await this.guard.existing(inputPath)
    if (source === this.guard.root) throw new Error('不能重命名项目根目录。')
    assertNotMetadataPath(this.guard.root, source)
    const name = assertSafeName(nextName, '新名称')
    const target = await this.guard.target(path.join(path.dirname(source), name))
    assertNotMetadataPath(this.guard.root, target)
    await assertAbsent(target)
    const sourceIdentity = await this.guard.identity(source, (await stat(source)).isDirectory() ? 'directory' : 'file')
    const parentIdentity = await this.guard.identity(path.dirname(source), 'directory')
    await this.guard.verifyIdentity(sourceIdentity)
    await this.guard.verifyIdentity(parentIdentity)
    if ((await this.guard.existing(source)) !== source || (await this.guard.target(target)) !== target) {
      throw new Error('重命名路径在校验后发生变化。')
    }
    await rename(source, target)
    return this.guard.existing(target)
  }

  async move(inputPath: string, targetFolder: string): Promise<string> {
    const source = await this.guard.existing(inputPath)
    const folder = await this.guard.existing(targetFolder, 'directory')
    if (source === this.guard.root) throw new Error('不能移动项目根目录。')
    assertNotMetadataPath(this.guard.root, source)
    assertNotMetadataPath(this.guard.root, folder)
    if (isInside(source, folder)) throw new Error('不能把文件夹移动到自身内部。')
    const target = await this.guard.target(path.join(folder, path.basename(source)))
    await assertAbsent(target)
    const sourceIdentity = await this.guard.identity(source, (await stat(source)).isDirectory() ? 'directory' : 'file')
    const sourceParentIdentity = await this.guard.identity(path.dirname(source), 'directory')
    const targetParentIdentity = await this.guard.identity(folder, 'directory')
    await this.guard.verifyIdentity(sourceIdentity)
    await this.guard.verifyIdentity(sourceParentIdentity)
    await this.guard.verifyIdentity(targetParentIdentity)
    if (
      (await this.guard.existing(source)) !== source ||
      (await this.guard.existing(folder, 'directory')) !== folder ||
      (await this.guard.target(target)) !== target
    ) {
      throw new Error('移动路径在校验后发生变化。')
    }
    await rename(source, target)
    return this.guard.existing(target)
  }

  async trash(inputPath: string): Promise<void> {
    const canonical = await this.guard.existing(inputPath)
    if (canonical === this.guard.root) throw new Error('不能将项目根目录移入回收站。')
    assertNotMetadataPath(this.guard.root, canonical)
    await shell.trashItem(canonical)
  }

  async importFiles(sourcePaths: string[], targetFolder: string): Promise<string[]> {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return []
    const folder = await this.guard.existing(targetFolder, 'directory')
    assertNotMetadataPath(this.guard.root, folder)
    const folderIdentity = await this.guard.identity(folder, 'directory')
    const imported: string[] = []
    for (const sourceInput of sourcePaths) {
      if (typeof sourceInput !== 'string' || sourceInput.includes('\0')) throw new Error('导入路径无效。')
      const source = path.resolve(sourceInput)
      const sourceInfo = await lstat(source)
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error('第一版仅支持导入普通文件，不支持文件夹或符号链接。')
      const parsed = path.parse(assertSafeName(path.basename(source), '文件名'))
      let counter = 0
      let target: string
      do {
        const suffix = counter === 0 ? '' : ` (${counter})`
        target = await this.guard.target(path.join(folder, `${parsed.name}${suffix}${parsed.ext}`))
        counter += 1
      } while (await lstat(target).then(() => true).catch((error) => (isMissing(error) ? false : Promise.reject(error))))
      await this.guard.verifyIdentity(folderIdentity)
      if ((await this.guard.existing(folder, 'directory')) !== folder || (await this.guard.target(target)) !== target) {
        throw new Error('导入目标在校验后发生变化。')
      }
      await copyFile(source, target, constants.COPYFILE_EXCL)
      imported.push(await this.guard.existing(target, 'file'))
    }
    return imported
  }

  async reveal(inputPath: string): Promise<void> {
    const canonical = await this.guard.existing(inputPath)
    assertNotMetadataPath(this.guard.root, canonical)
    shell.showItemInFolder(canonical)
  }

  async url(inputPath: string): Promise<string> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    return this.urlFor(canonical)
  }

  async prepareAiOperation(input: OperationInput): Promise<FileOperationProposal> {
    if (input.kind !== 'create' && input.kind !== 'append' && input.kind !== 'replace') {
      throw new Error('AI 返回了不支持的文件操作。')
    }
    if (typeof input.targetPath !== 'string' || typeof input.proposedContent !== 'string') {
      throw new Error('AI 文件操作缺少目标路径或内容。')
    }
    if (input.proposedContent.length > 8 * 1024 * 1024) throw new Error('AI 建议内容过大，已拒绝。')

    const mustExist = input.kind !== 'create'
    const target = await this.guard.assertMarkdown(input.targetPath, mustExist)
    assertNotMetadataPath(this.guard.root, target)
    let originalContent: string | undefined
    let expectedModifiedAt: number | undefined
    if (mustExist) {
      const current = await this.read(target)
      originalContent = current.content
      expectedModifiedAt = current.modifiedAt
    } else {
      await assertAbsent(target)
    }

    const proposal: FileOperationProposal = {
      id: randomUUID(),
      kind: input.kind,
      targetPath: target,
      proposedContent: input.proposedContent,
      ...(originalContent !== undefined ? { originalContent } : {}),
      ...(expectedModifiedAt !== undefined ? { expectedModifiedAt } : {}),
      summary:
        typeof input.summary === 'string' && input.summary.trim()
          ? input.summary.trim().slice(0, 500)
          : input.kind === 'create'
            ? `创建 ${path.basename(target)}`
            : input.kind === 'append'
              ? `追加到 ${path.basename(target)}`
              : `修改 ${path.basename(target)}`,
      status: 'pending'
    }
    this.pendingOperations.set(proposal.id, { proposal, createdAt: Date.now() })
    for (const [id, pending] of this.pendingOperations) {
      if (Date.now() - pending.createdAt > 60 * 60 * 1000) this.pendingOperations.delete(id)
    }
    return proposal
  }

  async applyAiOperation(input: FileOperationProposal): Promise<FileReadResult> {
    if (!input || input.status !== 'accepted') throw new Error('只有用户明确接受的 AI 文件建议才可以写入。')
    const pending = this.pendingOperations.get(input.id)
    if (!pending) throw new Error('AI 文件建议已失效，请重新生成预览。')
    const proposal = pending.proposal
    if (
      input.kind !== proposal.kind ||
      input.targetPath !== proposal.targetPath ||
      input.proposedContent !== proposal.proposedContent
    ) {
      throw new Error('AI 文件建议在确认前发生变化，操作已拒绝。')
    }

    let result: FileReadResult
    if (proposal.kind === 'create') {
      result = await this.createMarkdown(proposal.targetPath, proposal.proposedContent)
    } else {
      const current = await this.read(proposal.targetPath)
      if (
        current.modifiedAt !== proposal.expectedModifiedAt ||
        current.content !== proposal.originalContent
      ) {
        throw new Error('文件在预览后已被修改。请重新加载并生成新的修改建议。')
      }
      const nextContent =
        proposal.kind === 'append'
          ? `${current.content}${current.content && !current.content.endsWith('\n') ? '\n' : ''}${proposal.proposedContent}`
          : proposal.proposedContent
      result = await this.saveMarkdown(proposal.targetPath, nextContent, proposal.expectedModifiedAt)
    }
    this.pendingOperations.delete(proposal.id)
    return result
  }
}
