import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import chokidar, { type FSWatcher } from 'chokidar'
import { app, dialog, shell } from 'electron'

import {
  DEFAULT_WORKSPACE_STATE,
  type AiOperationHistoryEntry,
  type AppliedMarkdownOperation,
  type Annotation,
  type ChatImageAttachment,
  type ChatMessage,
  type ChatSession,
  type ContextSnapshot,
  type FileChangeEvent,
  type FileKind,
  type FileNode,
  type FileOperationApplyResult,
  type FileOperationProposal,
  type FileReadResult,
  type FileOperationUndoResult,
  type MarkdownFileOperation,
  type OcrLine,
  type OcrResult,
  type ProjectInfo,
  type ProjectMemoryDocument,
  type ProjectRef,
  type SourceRef,
  type WorkspaceState
} from '../../src/shared/types'
import { normalizeChatImageAttachments } from '../../src/shared/chat-images'
import { DocxService } from './docx'
import { extractPptxText } from './pptx'
import { assertNotMetadataPath, assertSafeName, canonicalDirectory, isInside, ProjectPathGuard } from './security'
import { SettingsStore } from './settings'
import { atomicCreate, atomicWrite, atomicWriteJson, readJson } from './storage'
import {
  DEFAULT_PROJECT_MEMORY,
  normalizeProjectMemory,
  PROJECT_MEMORY_FILENAME
} from './project-memory'

const METADATA_DIRECTORY = '.vibeknowledge'
const MAX_RECENT_PROJECTS = 20
const MAX_TEXT_FILE_SIZE = 32 * 1024 * 1024
const MAX_POWERPOINT_FILE_SIZE = 128 * 1024 * 1024
const MAX_WEB_ARCHIVE_SIZE = 256 * 1024 * 1024
const MAX_WEB_CAPTURE_PDF_SIZE = 256 * 1024 * 1024
const MAX_AI_FILE_OPERATIONS = 50
const MAX_AI_OPERATION_CONTENT = 8 * 1024 * 1024
const MAX_AI_OPERATION_TOTAL_CONTENT = 32 * 1024 * 1024
const MAX_AI_OPERATION_HISTORY = 30
const MAX_AI_OPERATION_HISTORY_CONTENT = 32 * 1024 * 1024
const MAX_SESSIONS = 200
const MAX_MESSAGES_PER_SESSION = 2_000
const MAX_MESSAGE_CHARS = 2 * 1024 * 1024
const MAX_OCR_RESULTS = 2_000
const MAX_OCR_TEXT_CHARS = 4 * 1024 * 1024
const MAX_PLUGIN_DATA_BYTES = 4 * 1024 * 1024

type ProjectMetadataName =
  | 'workspace'
  | 'sessions'
  | 'annotations'
  | 'ocr'
  | 'knowledge-index'
  | 'ai-operations'
  | 'plugin-data'

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
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u
const UNC_PATH = /^(?:\\\\|\/\/)/u
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
  if (extension === '.docx') return 'docx'
  if (extension === '.ppt') return 'ppt'
  if (extension === '.pptx') return 'pptx'
  if (extension === '.mhtml' || extension === '.mht') return 'webarchive'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'unsupported'
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function officeCandidates(): string[] {
  const candidates = [process.env.COSCRIBE_SOFFICE_PATH]
  if (process.platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice')
  } else if (process.platform === 'win32') {
    candidates.push(
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'LibreOffice', 'program', 'soffice.exe') : undefined,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'LibreOffice', 'program', 'soffice.exe') : undefined,
      'soffice.exe'
    )
  } else {
    candidates.push('/usr/bin/soffice', '/usr/local/bin/soffice', 'soffice')
  }
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate?.trim())))]
}

function runOffice(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const detail = stderr.trim()
      reject(Object.assign(new Error(detail || error.message), { code: (error as NodeJS.ErrnoException).code }))
    })
  })
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

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

async function projectTargetAllowMissing(root: string, inputPath: string): Promise<string> {
  if (
    !inputPath ||
    inputPath.includes('\0') ||
    /[\u0001-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(inputPath) ||
    hasTraversalSegment(inputPath) ||
    (process.platform !== 'win32' && (WINDOWS_ABSOLUTE_PATH.test(inputPath) || UNC_PATH.test(inputPath)))
  ) {
    throw new Error('文件路径为空、包含越级目录或非法字符。')
  }
  const candidate = path.resolve(root, inputPath)
  if (candidate === root || !isInside(root, candidate)) throw new Error('文件路径不在当前项目内。')
  assertNotMetadataPath(root, candidate)
  const relative = path.relative(root, candidate)
  const segments = relative.split(path.sep).filter(Boolean)
  let cursor = root
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error('文件路径包含符号链接，操作已拒绝。')
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new Error('文件路径的父路径不是文件夹。')
      }
    } catch (error) {
      if (isMissing(error)) break
      throw error
    }
  }
  return candidate
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
      candidate.navSection === 'sessions' || candidate.navSection === 'search' || candidate.navSection === 'annotations' ||
      candidate.navSection === 'memory' || candidate.navSection === 'plugins'
      || candidate.navSection === 'operations'
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

function metadataWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8_000) return undefined
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function normalizedContext(value: unknown, root: string): ContextSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const scopes = new Set(['selection', 'visible', 'document', 'project', 'general'])
  const kinds = new Set(['folder', 'markdown', 'pdf', 'docx', 'ppt', 'pptx', 'webarchive', 'image', 'text', 'unsupported'])
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
    ...(metadataWebUrl(value.webUrl) ? { webUrl: metadataWebUrl(value.webUrl) } : {}),
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
  const kinds = new Set(['pdf', 'markdown', 'docx', 'ppt', 'pptx', 'image', 'text', 'session', 'web', 'general'])
  if (typeof value.kind !== 'string' || !kinds.has(value.kind)) return undefined
  const kind = value.kind as SourceRef['kind']
  const sourcePath = kind === 'web'
    ? metadataWebUrl(value.path)
    : kind === 'session' || kind === 'general'
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

function normalizedMarkdownOperation(value: unknown, root: string): MarkdownFileOperation | undefined {
  if (!isRecord(value) || (value.kind !== 'create' && value.kind !== 'append' && value.kind !== 'replace')) return undefined
  const targetPath = metadataProjectPath(value.targetPath, root)
  const proposedContent = text(value.proposedContent, MAX_AI_OPERATION_CONTENT)
  if (!targetPath || !/\.(?:md|markdown)$/iu.test(targetPath) || proposedContent === undefined) return undefined
  return {
    kind: value.kind,
    targetPath,
    proposedContent,
    ...(text(value.originalContent, MAX_AI_OPERATION_CONTENT) !== undefined
      ? { originalContent: text(value.originalContent, MAX_AI_OPERATION_CONTENT) }
      : {}),
    ...(typeof value.expectedModifiedAt === 'number' && Number.isFinite(value.expectedModifiedAt)
      ? { expectedModifiedAt: value.expectedModifiedAt }
      : {})
  }
}

function normalizedOperation(value: unknown, root: string): FileOperationProposal | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined
  const single = normalizedMarkdownOperation(value, root)
  if (!single) return undefined
  let operations: MarkdownFileOperation[] | undefined
  if (Array.isArray(value.operations)) {
    if (value.operations.length < 1 || value.operations.length > MAX_AI_FILE_OPERATIONS) return undefined
    const normalized = value.operations.map((item) => normalizedMarkdownOperation(item, root))
    if (normalized.some((item) => !item)) return undefined
    operations = normalized as MarkdownFileOperation[]
  }
  const savedStatus = value.status === 'accepted' || value.status === 'rejected' || value.status === 'failed'
    ? value.status
    : 'failed'
  return {
    id: value.id.slice(0, 500),
    ...single,
    ...(operations ? { operations } : {}),
    summary: text(value.summary, 500) ?? `${single.kind} ${path.basename(single.targetPath)}`,
    status: savedStatus,
    ...(savedStatus === 'failed' ? { error: text(value.error, 20_000) ?? '应用已重新启动，请重新生成这项文件建议。' } : {})
  }
}

function normalizedAttachmentPaths(
  value: unknown,
  attachment: ChatImageAttachment,
  root: string
): ChatImageAttachment {
  if (!Array.isArray(value)) return attachment
  const raw = value.find((candidate) => isRecord(candidate) && candidate.id === attachment.id)
  if (!isRecord(raw)) return attachment
  const fromRelative = typeof raw.projectRelativePath === 'string'
    ? metadataProjectPath(raw.projectRelativePath, root)
    : undefined
  const fromAbsolute = typeof raw.absolutePath === 'string'
    ? metadataProjectPath(raw.absolutePath, root)
    : undefined
  // The relative path remains valid when a project folder is moved; a persisted absolute path may be stale.
  const canonical = fromRelative ?? fromAbsolute
  if (!canonical || fileKind(canonical) !== 'image') return attachment
  return {
    ...attachment,
    projectRelativePath: path.relative(root, canonical).split(path.sep).join('/'),
    absolutePath: canonical
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
  const attachments = value.role !== 'system'
    ? normalizeChatImageAttachments(value.attachments).map((attachment) => normalizedAttachmentPaths(value.attachments, attachment, root))
    : []
  return {
    id: value.id.slice(0, 500),
    role: value.role,
    content,
    createdAt: timestamp(value.createdAt, Date.now()),
    ...(attachments.length ? { attachments } : {}),
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
  kind?: unknown
  targetPath?: unknown
  proposedContent?: unknown
  operations?: unknown
  summary?: unknown
}

interface PendingOperation {
  proposal: FileOperationProposal
  createdAt: number
}

export interface ProjectWriteScope {
  root: string
  revision: number
}

function proposalOperations(proposal: FileOperationProposal): MarkdownFileOperation[] {
  return proposal.operations?.length
    ? proposal.operations
    : [{
        kind: proposal.kind,
        targetPath: proposal.targetPath,
        proposedContent: proposal.proposedContent,
        ...(proposal.originalContent !== undefined ? { originalContent: proposal.originalContent } : {}),
        ...(proposal.expectedModifiedAt !== undefined ? { expectedModifiedAt: proposal.expectedModifiedAt } : {})
      }]
}

function sameMarkdownOperation(left: MarkdownFileOperation, right: MarkdownFileOperation): boolean {
  return left.kind === right.kind &&
    left.targetPath === right.targetPath &&
    left.proposedContent === right.proposedContent &&
    left.originalContent === right.originalContent &&
    left.expectedModifiedAt === right.expectedModifiedAt
}

interface StoredOcrResult extends Omit<OcrResult, 'path'> {
  path: string
}

function normalizedOcrLines(value: unknown): OcrLine[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20_000).flatMap((candidate): OcrLine[] => {
    if (!isRecord(candidate) || typeof candidate.text !== 'string') return []
    const line: OcrLine = { text: candidate.text.slice(0, 100_000) }
    if (typeof candidate.score === 'number' && Number.isFinite(candidate.score)) {
      line.score = Math.max(0, Math.min(1, candidate.score))
    }
    if (Array.isArray(candidate.polygon)) {
      line.polygon = candidate.polygon.slice(0, 16).flatMap((point) => {
        if (!isRecord(point) || typeof point.x !== 'number' || typeof point.y !== 'number') return []
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return []
        return [{ x: point.x, y: point.y }]
      })
    }
    return [line]
  })
}

function normalizedOcrWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const warnings = value
    .flatMap((item) => typeof item === 'string' ? [item.slice(0, 2_000)] : [])
    .filter((item, index, values) => item && values.indexOf(item) === index)
    .slice(0, 20)
  return warnings.length ? warnings : undefined
}

function normalizedOperationHistory(value: unknown, root: string): AiOperationHistoryEntry[] {
  if (!Array.isArray(value)) return []
  let retainedContent = 0
  return value.slice(0, MAX_AI_OPERATION_HISTORY).flatMap((candidate): AiOperationHistoryEntry[] => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.proposalId !== 'string') return []
    if (!Array.isArray(candidate.operations) || !candidate.operations.length || candidate.operations.length > MAX_AI_FILE_OPERATIONS) return []
    const operations = candidate.operations.flatMap((raw): AppliedMarkdownOperation[] => {
      if (!isRecord(raw) || (raw.kind !== 'create' && raw.kind !== 'append' && raw.kind !== 'replace')) return []
      const targetPath = metadataProjectPath(raw.targetPath, root)
      const beforeContent = raw.beforeContent === null ? null : text(raw.beforeContent, MAX_AI_OPERATION_CONTENT)
      const afterContent = text(raw.afterContent, MAX_AI_OPERATION_CONTENT)
      if (!targetPath || !/\.(?:md|markdown)$/iu.test(targetPath) || beforeContent === undefined || afterContent === undefined) return []
      return [{ kind: raw.kind, targetPath, beforeContent, afterContent }]
    })
    if (operations.length !== candidate.operations.length) return []
    const contentSize = operations.reduce(
      (total, operation) => total + Buffer.byteLength(operation.beforeContent ?? '') + Buffer.byteLength(operation.afterContent),
      0
    )
    if (retainedContent + contentSize > MAX_AI_OPERATION_HISTORY_CONTENT) return []
    retainedContent += contentSize
    const status = candidate.status === 'undone' ? 'undone' : 'applied'
    return [{
      id: candidate.id,
      proposalId: candidate.proposalId,
      summary: text(candidate.summary, 500) ?? 'AI 文件操作',
      appliedAt: timestamp(candidate.appliedAt, Date.now()),
      status,
      ...(status === 'undone' ? { undoneAt: timestamp(candidate.undoneAt, Date.now()) } : {}),
      operations
    }]
  })
}

export class ProjectService {
  private guardValue: ProjectPathGuard | null = null
  private projectRevision = 0
  private currentInfo: ProjectInfo | null = null
  private watcher: FSWatcher | null = null
  private watcherTimer: NodeJS.Timeout | null = null
  private readonly queuedEvents = new Map<string, FileChangeEvent>()
  private readonly pendingOperations = new Map<string, PendingOperation>()
  private readonly docx = new DocxService()
  private initialPath: string | null = null

  constructor(
    private readonly settings: SettingsStore,
    private readonly emitFilesChanged: (events: FileChangeEvent[]) => void,
    private readonly onFileChanged: (filePath?: string) => void,
    private readonly beforeProjectChange: () => void | Promise<void> = () => undefined
  ) {}

  get guard(): ProjectPathGuard {
    if (!this.guardValue) throw new Error('请先打开一个项目。')
    return this.guardValue
  }

  captureWriteScope(): ProjectWriteScope {
    const guard = this.guard
    return { root: guard.root, revision: this.projectRevision }
  }

  private guardForWriteScope(scope: ProjectWriteScope): ProjectPathGuard {
    const guard = this.guardValue
    if (!guard || scope.revision !== this.projectRevision || scope.root !== guard.root) {
      throw new Error('项目已切换，本次文件写入已取消。')
    }
    return guard
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

  private async metadataFile(name: ProjectMetadataName): Promise<string> {
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

  async readMetadata<T>(name: ProjectMetadataName, fallback: T): Promise<T> {
    return readJson<T>(await this.metadataFile(name), fallback)
  }

  async writeMetadata(name: ProjectMetadataName, value: unknown): Promise<void> {
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
    this.projectRevision += 1
    await this.beforeProjectChange()
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
    this.projectRevision += 1
    await this.beforeProjectChange()
    await this.stopWatcher()
    this.guardValue = null
    this.currentInfo = null
    this.pendingOperations.clear()
    this.docx.invalidate()
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
      this.docx.invalidate(absolute)
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

  async memory(): Promise<ProjectMemoryDocument> {
    const memoryPath = path.join(this.guard.root, PROJECT_MEMORY_FILENAME)
    try {
      const canonical = await this.guard.existing(memoryPath, 'file')
      const info = await stat(canonical)
      if (info.size > 256 * 1024) throw new Error('COSCRIBE.md 超过安全读取上限。')
      const content = normalizeProjectMemory(await readFile(canonical, 'utf8'))
      return { path: canonical, content, exists: true, modifiedAt: info.mtimeMs, size: info.size }
    } catch (error) {
      if (!isMissing(error)) throw error
      return {
        path: memoryPath,
        content: DEFAULT_PROJECT_MEMORY,
        exists: false,
        modifiedAt: 0,
        size: 0
      }
    }
  }

  async saveMemory(value: string): Promise<ProjectMemoryDocument> {
    const content = normalizeProjectMemory(value)
    const target = await this.guard.assertMarkdown(path.join(this.guard.root, PROJECT_MEMORY_FILENAME), false)
    const rootIdentity = await this.guard.identity(this.guard.root, 'directory')
    await atomicWrite(target, content, 0o600, () => this.guard.verifyIdentity(rootIdentity))
    return this.memory()
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

  async pluginData(pluginId: string): Promise<unknown> {
    if (typeof pluginId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(pluginId)) throw new Error('插件 ID 无效。')
    const data = await this.readMetadata<Record<string, unknown>>('plugin-data', {})
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return Object.prototype.hasOwnProperty.call(data, pluginId) ? data[pluginId] : null
  }

  async savePluginData(pluginId: string, value: unknown): Promise<void> {
    if (typeof pluginId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(pluginId)) throw new Error('插件 ID 无效。')
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch {
      throw new Error('插件数据必须可以安全序列化为 JSON。')
    }
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PLUGIN_DATA_BYTES) throw new Error('插件数据超过 4 MB 上限。')
    const existing = await this.readMetadata<Record<string, unknown>>('plugin-data', {})
    const next = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
    next[pluginId] = JSON.parse(serialized) as unknown
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_PLUGIN_DATA_BYTES) throw new Error('项目插件数据总量超过 4 MB 上限。')
    await this.writeMetadata('plugin-data', next)
  }

  async operationHistory(): Promise<AiOperationHistoryEntry[]> {
    return normalizedOperationHistory(await this.readMetadata<unknown>('ai-operations', []), this.guard.root)
  }

  private async recordOperationHistory(
    proposal: FileOperationProposal,
    applied: Array<{ operation: MarkdownFileOperation; result: FileReadResult }>
  ): Promise<AiOperationHistoryEntry> {
    const entry: AiOperationHistoryEntry = {
      id: randomUUID(),
      proposalId: proposal.id,
      summary: proposal.summary,
      appliedAt: Date.now(),
      status: 'applied',
      operations: applied.map(({ operation, result }) => ({
        kind: operation.kind,
        targetPath: result.path,
        beforeContent: operation.kind === 'create' ? null : (operation.originalContent ?? ''),
        afterContent: result.content
      }))
    }
    const history = normalizedOperationHistory([entry, ...await this.operationHistory()], this.guard.root)
    if (!history.some((item) => item.id === entry.id)) throw new Error('本次操作过大，无法建立安全撤销记录。')
    await this.writeMetadata('ai-operations', history)
    return entry
  }

  async undoOperation(historyId: string): Promise<FileOperationUndoResult> {
    if (typeof historyId !== 'string' || !historyId.trim()) throw new Error('撤销记录 ID 无效。')
    const history = await this.operationHistory()
    const entry = history.find((item) => item.id === historyId)
    if (!entry) throw new Error('找不到这条 AI 操作记录。')
    if (entry.status !== 'applied') throw new Error('这条 AI 操作已经撤销。')

    const currentFiles = new Map<string, FileReadResult>()
    for (const operation of entry.operations) {
      const current = await this.read(operation.targetPath)
      if (current.content !== operation.afterContent) {
        throw new Error(`${path.basename(operation.targetPath)} 在 AI 写入后又被修改，不能安全撤销。`)
      }
      currentFiles.set(operation.targetPath, current)
    }

    const restoredFiles: FileReadResult[] = []
    const deletedPaths: string[] = []
    const completed: AppliedMarkdownOperation[] = []
    try {
      for (const operation of [...entry.operations].reverse()) {
        const current = currentFiles.get(operation.targetPath)
        if (!current) throw new Error('撤销预检结果丢失。')
        if (operation.kind === 'create') {
          await unlink(await this.guard.existing(operation.targetPath, 'file'))
          deletedPaths.push(operation.targetPath)
        } else {
          restoredFiles.push(await this.saveMarkdown(operation.targetPath, operation.beforeContent ?? '', current.modifiedAt))
        }
        completed.push(operation)
      }

      const updated: AiOperationHistoryEntry = { ...entry, status: 'undone', undoneAt: Date.now() }
      await this.writeMetadata('ai-operations', history.map((item) => item.id === entry.id ? updated : item))
      return { entry: updated, files: restoredFiles, deletedPaths }
    } catch (error) {
      const rollbackFailures: string[] = []
      for (const operation of [...completed].reverse()) {
        try {
          if (operation.kind === 'create') {
            await this.createMarkdown(operation.targetPath, operation.afterContent)
          } else {
            const current = await this.read(operation.targetPath)
            await this.saveMarkdown(operation.targetPath, operation.afterContent, current.modifiedAt)
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${path.basename(operation.targetPath)}：${rollbackError instanceof Error ? rollbackError.message : '未知错误'}`)
        }
      }
      const reason = error instanceof Error ? error.message : '撤销失败。'
      if (rollbackFailures.length) throw new Error(`${reason} 恢复撤销前状态时仍有异常：${rollbackFailures.join('；')}`)
      throw new Error(`${reason} 已恢复撤销前状态。`)
    }
  }

  urlFor(canonicalPath: string): string {
    const relative = path.relative(this.guard.root, canonicalPath)
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
    return `coscribe-file://project/${encoded}`
  }

  private async ensureProjectDirectories(
    directory: string,
    guard = this.guard,
    verify?: () => void
  ): Promise<void> {
    verify?.()
    const root = guard.root
    const canonicalDirectory = path.resolve(directory)
    if (!isInside(root, canonicalDirectory)) throw new Error('目标文件夹不在当前项目内。')
    assertNotMetadataPath(root, canonicalDirectory)
    let cursor = root
    for (const segment of path.relative(root, canonicalDirectory).split(path.sep).filter(Boolean)) {
      const parent = cursor
      cursor = path.join(cursor, segment)
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('目标父路径不是普通文件夹。')
        continue
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      const parentIdentity = await guard.identity(parent, 'directory')
      verify?.()
      try {
        await mkdir(cursor, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      verify?.()
      await guard.verifyIdentity(parentIdentity)
      await guard.existing(cursor, 'directory')
      verify?.()
    }
  }

  async verifiedChatImageAttachments(value: unknown): Promise<ChatImageAttachment[]> {
    const normalized = normalizeChatImageAttachments(value, { strict: true })
    return Promise.all(normalized.map(async (attachment) => {
      const withPaths = normalizedAttachmentPaths(value, attachment, this.guard.root)
      const candidate = withPaths.absolutePath ?? withPaths.projectRelativePath
      if (!candidate) return attachment
      try {
        const canonical = await this.guard.existing(candidate, 'file')
        assertNotMetadataPath(this.guard.root, canonical)
        if (fileKind(canonical) !== 'image') return attachment
        return {
          ...attachment,
          projectRelativePath: path.relative(this.guard.root, canonical).split(path.sep).join('/'),
          absolutePath: canonical
        }
      } catch {
        return attachment
      }
    }))
  }

  async persistGeneratedImage(input: ChatImageAttachment): Promise<ChatImageAttachment> {
    const [attachment] = normalizeChatImageAttachments([input], { strict: true })
    if (!attachment) throw new Error('生成图片数据无效。')
    const extension = attachment.mimeType === 'image/jpeg' ? 'jpg' : attachment.mimeType.slice('image/'.length)
    const stem = path.parse(assertSafeName(attachment.name, '图片文件名')).name.slice(0, 180) || 'gpt-image-2'
    const fileName = `${stem}-${randomUUID().slice(0, 8)}.${extension}`
    const requested = path.join('assets', 'ai-images', fileName)
    const unchecked = await projectTargetAllowMissing(this.guard.root, requested)
    await this.ensureProjectDirectories(path.dirname(unchecked))
    const canonical = await this.guard.target(unchecked)
    assertNotMetadataPath(this.guard.root, canonical)
    await assertAbsent(canonical)
    const parentIdentity = await this.guard.identity(path.dirname(canonical), 'directory')
    await this.guard.verifyIdentity(parentIdentity)

    const prefix = `data:${attachment.mimeType};base64,`
    const bytes = Buffer.from(attachment.dataUrl.slice(prefix.length), 'base64')
    let created = false
    try {
      const descriptor = await open(
        canonical,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      created = true
      try {
        await descriptor.writeFile(bytes)
        await descriptor.sync()
      } finally {
        await descriptor.close()
      }
      await this.guard.verifyIdentity(parentIdentity)
      await this.guard.existing(canonical, 'file')
    } catch (error) {
      if (created) {
        const stillSafe = await this.guard.verifyIdentity(parentIdentity)
          .then(() => this.guard.existing(canonical, 'file'))
          .then((verified) => verified === canonical)
          .catch(() => false)
        if (stillSafe) await unlink(canonical).catch(() => undefined)
      }
      throw error
    }
    return {
      ...attachment,
      name: fileName,
      projectRelativePath: path.relative(this.guard.root, canonical).split(path.sep).join('/'),
      absolutePath: canonical
    }
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

  private async readOcrCache(): Promise<StoredOcrResult[]> {
    const value = await readJson<unknown>(await this.metadataFile('ocr'), [])
    if (!Array.isArray(value)) return []
    return value.slice(0, MAX_OCR_RESULTS).flatMap((candidate): StoredOcrResult[] => {
      if (!isRecord(candidate) || typeof candidate.path !== 'string' || typeof candidate.text !== 'string') return []
      if (candidate.engine !== 'paddleocr-v6' && candidate.engine !== 'ai-vision') return []
      if (typeof candidate.model !== 'string' || typeof candidate.createdAt !== 'number') return []
      if (typeof candidate.sourceModifiedAt !== 'number' || typeof candidate.sourceSize !== 'number') return []
      const page = typeof candidate.page === 'number' && Number.isInteger(candidate.page) && candidate.page > 0
        ? candidate.page
        : undefined
      return [{
        path: candidate.path,
        ...(page ? { page } : {}),
        text: candidate.text.slice(0, MAX_OCR_TEXT_CHARS),
        lines: normalizedOcrLines(candidate.lines),
        engine: candidate.engine,
        model: candidate.model.slice(0, 500),
        createdAt: candidate.createdAt,
        sourceModifiedAt: candidate.sourceModifiedAt,
        sourceSize: candidate.sourceSize,
        ...(normalizedOcrWarnings(candidate.warnings) ? { warnings: normalizedOcrWarnings(candidate.warnings) } : {})
      }]
    })
  }

  async ocrResults(inputPath: string, page?: number): Promise<OcrResult[]> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const relative = path.relative(this.guard.root, canonical)
    const info = await stat(canonical)
    const stored = await this.readOcrCache()
    return stored
      .filter((item) => item.path === relative && (page === undefined || item.page === page))
      .filter((item) => item.sourceSize === info.size && Math.abs(item.sourceModifiedAt - info.mtimeMs) <= 1)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((item) => ({ ...item, path: canonical, lines: item.lines.map((line) => ({ ...line, polygon: line.polygon?.map((point) => ({ ...point })) })) }))
  }

  async getOcr(inputPath: string, page?: number): Promise<OcrResult | null> {
    return (await this.ocrResults(inputPath, page))[0] ?? null
  }

  async saveOcr(input: OcrResult): Promise<OcrResult> {
    if (!input || typeof input !== 'object' || typeof input.path !== 'string') throw new Error('OCR 结果路径无效。')
    if (typeof input.text !== 'string') throw new Error('OCR 结果正文无效。')
    if (input.engine !== 'paddleocr-v6' && input.engine !== 'ai-vision') throw new Error('OCR 引擎类型无效。')
    const canonical = await this.guard.existing(input.path, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const kind = fileKind(canonical)
    if (kind !== 'image' && kind !== 'pdf') throw new Error('OCR 结果只能关联图片或 PDF。')
    const info = await stat(canonical)
    const page = typeof input.page === 'number' && Number.isInteger(input.page) && input.page > 0
      ? input.page
      : undefined
    if (kind === 'pdf' && !page) throw new Error('PDF OCR 结果必须包含页码。')
    const result: OcrResult = {
      path: canonical,
      ...(page ? { page } : {}),
      text: input.text.slice(0, MAX_OCR_TEXT_CHARS).trim(),
      lines: normalizedOcrLines(input.lines),
      engine: input.engine,
      model: typeof input.model === 'string' ? input.model.slice(0, 500) : '',
      createdAt: Date.now(),
      sourceModifiedAt: info.mtimeMs,
      sourceSize: info.size,
      ...(normalizedOcrWarnings(input.warnings) ? { warnings: normalizedOcrWarnings(input.warnings) } : {})
    }
    const relative = path.relative(this.guard.root, canonical)
    const cache = await this.readOcrCache()
    const next: StoredOcrResult[] = [
      { ...result, path: relative },
      ...cache.filter((item) => !(item.path === relative && item.page === page && item.engine === result.engine))
    ].slice(0, MAX_OCR_RESULTS)
    await this.writeMetadata('ocr', next)
    return result
  }

  async read(inputPath: string): Promise<FileReadResult> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const info = await stat(canonical)
    const kind = fileKind(canonical)
    let content = ''
    let html: string | undefined
    let warnings: string[] | undefined
    if (kind === 'markdown' || kind === 'text') {
      if (info.size > MAX_TEXT_FILE_SIZE) throw new Error('文本文件超过 32 MB，无法直接打开。')
      const descriptor = await this.guard.openReadOnly(canonical)
      try {
        content = await descriptor.readFile('utf8')
      } finally {
        await descriptor.close()
      }
    } else if (kind === 'docx') {
      const descriptor = await this.guard.openReadOnly(canonical)
      try {
        const extracted = await this.docx.extract(canonical, await descriptor.readFile(), info.mtimeMs)
        content = extracted.text
        html = extracted.html
        warnings = extracted.warnings
      } finally {
        await descriptor.close()
      }
    } else if (kind === 'pptx') {
      if (info.size > MAX_POWERPOINT_FILE_SIZE) throw new Error('PPTX 文件超过 128 MB，无法直接打开。')
      const descriptor = await this.guard.openReadOnly(canonical)
      try {
        const extracted = extractPptxText(await descriptor.readFile())
        content = extracted.text
        warnings = extracted.warnings
      } catch (error) {
        warnings = [error instanceof Error ? error.message : '无法提取 PPTX 中的文字。']
      } finally {
        await descriptor.close()
      }
    } else if (kind === 'ppt') {
      warnings = ['旧版 .ppt 是二进制格式；需要本机 LibreOffice 或 PowerPoint 转换为 PDF/PPTX 后才能完整预览和提取文字。']
    }
    const ocrResults = kind === 'image' || kind === 'pdf' ? await this.ocrResults(canonical) : []
    return {
      path: canonical,
      kind,
      content,
      modifiedAt: info.mtimeMs,
      size: info.size,
      ...(kind === 'pdf' || kind === 'image' || kind === 'ppt' || kind === 'pptx' ? { url: this.urlFor(canonical) } : {}),
      ...(html !== undefined ? { html } : {}),
      ...(warnings?.length ? { warnings } : {}),
      ...(ocrResults.length ? { ocrResults } : {})
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

  async createMarkdown(
    inputPath: string,
    content = '',
    scope: ProjectWriteScope = this.captureWriteScope()
  ): Promise<FileReadResult> {
    if (typeof content !== 'string') throw new Error('Markdown 内容格式无效。')
    const guard = this.guardForWriteScope(scope)
    const verifyScope = (): void => { this.guardForWriteScope(scope) }
    const unchecked = await projectTargetAllowMissing(guard.root, inputPath)
    verifyScope()
    if (!/\.(?:md|markdown)$/iu.test(unchecked)) throw new Error('只能创建 .md 或 .markdown 文件。')
    await assertAbsent(unchecked)
    verifyScope()
    await this.ensureProjectDirectories(path.dirname(unchecked), guard, verifyScope)
    const canonical = await guard.assertMarkdown(unchecked, false)
    verifyScope()
    assertNotMetadataPath(guard.root, canonical)
    await assertAbsent(canonical)
    verifyScope()
    const parentIdentity = await guard.identity(path.dirname(canonical), 'directory')
    const verify = async () => {
      verifyScope()
      await guard.verifyIdentity(parentIdentity)
      const checked = await guard.assertMarkdown(canonical, false)
      if (checked !== canonical) throw new Error('写入目标在校验后发生变化。')
      await assertAbsent(canonical)
      verifyScope()
    }
    await atomicCreate(canonical, content, verify)
    verifyScope()
    await guard.existing(canonical, 'file')
    const result = await this.read(canonical)
    verifyScope()
    return result
  }

  async createWebPdf(
    inputPath: string,
    content: Uint8Array,
    scope: ProjectWriteScope = this.captureWriteScope()
  ): Promise<FileReadResult> {
    if (!(content instanceof Uint8Array) || content.byteLength < 5 || content.byteLength > MAX_WEB_CAPTURE_PDF_SIZE) {
      throw new Error('网页 PDF 内容为空或超过 256 MB 限制。')
    }
    if (Buffer.from(content.subarray(0, 5)).toString('ascii') !== '%PDF-') {
      throw new Error('Chromium 没有生成有效的 PDF。')
    }
    const guard = this.guardForWriteScope(scope)
    const verifyScope = (): void => { this.guardForWriteScope(scope) }
    const unchecked = await projectTargetAllowMissing(guard.root, inputPath)
    verifyScope()
    if (path.extname(unchecked).toLocaleLowerCase() !== '.pdf') throw new Error('网页打印结果只能保存为 .pdf。')
    await assertAbsent(unchecked)
    verifyScope()
    await this.ensureProjectDirectories(path.dirname(unchecked), guard, verifyScope)
    const canonical = await guard.target(unchecked)
    verifyScope()
    assertNotMetadataPath(guard.root, canonical)
    await assertAbsent(canonical)
    verifyScope()
    const parentIdentity = await guard.identity(path.dirname(canonical), 'directory')
    const verify = async () => {
      verifyScope()
      await guard.verifyIdentity(parentIdentity)
      const checked = await guard.target(canonical)
      if (checked !== canonical) throw new Error('网页 PDF 目标在校验后发生变化。')
      await assertAbsent(canonical)
      verifyScope()
    }
    await atomicCreate(canonical, content, verify)
    verifyScope()
    await guard.existing(canonical, 'file')
    const result = await this.read(canonical)
    verifyScope()
    return result
  }

  async createWebArchive(
    inputPath: string,
    content: Uint8Array,
    scope: ProjectWriteScope = this.captureWriteScope()
  ): Promise<FileReadResult> {
    if (!(content instanceof Uint8Array) || content.byteLength < 64 || content.byteLength > MAX_WEB_ARCHIVE_SIZE) {
      throw new Error('完整网页归档为空或超过 256 MB 限制。')
    }
    const header = Buffer.from(content.subarray(0, Math.min(content.byteLength, 64 * 1024))).toString('latin1')
    if (!/^From: <Saved by Blink>/mu.test(header) || !/^MIME-Version: 1\.0\s*$/imu.test(header) || !/^Content-Type: multipart\/related;/imu.test(header)) {
      throw new Error('Chromium 没有生成有效的 MHTML 网页归档。')
    }
    const guard = this.guardForWriteScope(scope)
    const verifyScope = (): void => { this.guardForWriteScope(scope) }
    const unchecked = await projectTargetAllowMissing(guard.root, inputPath)
    verifyScope()
    if (!/\.mhtml?$/iu.test(unchecked)) throw new Error('完整网页归档只能保存为 .mhtml 或 .mht。')
    await assertAbsent(unchecked)
    verifyScope()
    await this.ensureProjectDirectories(path.dirname(unchecked), guard, verifyScope)
    const canonical = await guard.target(unchecked)
    verifyScope()
    assertNotMetadataPath(guard.root, canonical)
    await assertAbsent(canonical)
    verifyScope()
    const parentIdentity = await guard.identity(path.dirname(canonical), 'directory')
    const verify = async () => {
      verifyScope()
      await guard.verifyIdentity(parentIdentity)
      const checked = await guard.target(canonical)
      if (checked !== canonical) throw new Error('完整网页归档目标在校验后发生变化。')
      await assertAbsent(canonical)
      verifyScope()
    }
    await atomicCreate(canonical, content, verify)
    verifyScope()
    await guard.existing(canonical, 'file')
    const result = await this.read(canonical)
    verifyScope()
    return result
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

  async openExternal(inputPath: string): Promise<void> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const error = await shell.openPath(canonical)
    if (error) throw new Error(`系统无法打开这个文件：${error}`)
  }

  async url(inputPath: string): Promise<string> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    return this.urlFor(canonical)
  }

  async convertPowerPointToPdf(inputPath: string): Promise<FileReadResult> {
    const canonical = await this.guard.existing(inputPath, 'file')
    assertNotMetadataPath(this.guard.root, canonical)
    const kind = fileKind(canonical)
    if (kind !== 'ppt' && kind !== 'pptx') throw new Error('只能把 .ppt 或 .pptx 演示文稿转换为 PDF。')

    const temporary = await mkdtemp(path.join(app.getPath('temp'), 'coscribe-ppt-'))
    try {
      const profile = path.join(temporary, 'libreoffice-profile')
      const args = [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        temporary,
        canonical
      ]
      let conversionError: Error | null = null
      let converted = false
      for (const candidate of officeCandidates()) {
        try {
          await runOffice(candidate, args)
          converted = true
          break
        } catch (error) {
          conversionError = error instanceof Error ? error : new Error('PowerPoint 转换失败。')
        }
      }
      if (!converted) {
        throw new Error(`未找到可用的 LibreOffice。请先安装 LibreOffice 后重试。${conversionError?.message ? ` ${conversionError.message}` : ''}`)
      }

      const convertedName = (await readdir(temporary)).find((name) => path.extname(name).toLocaleLowerCase() === '.pdf')
      if (!convertedName) throw new Error('LibreOffice 没有生成 PDF 文件。演示文稿可能已损坏或受密码保护。')
      const convertedPath = path.join(temporary, convertedName)
      const convertedInfo = await lstat(convertedPath)
      if (!convertedInfo.isFile() || convertedInfo.isSymbolicLink()) throw new Error('转换结果不是普通 PDF 文件。')

      const parsed = path.parse(canonical)
      let counter = 0
      let target: string
      while (true) {
        const suffix = counter === 0 ? '' : ` (${counter})`
        target = await this.guard.target(path.join(parsed.dir, `${parsed.name}${suffix}.pdf`))
        const exists = await lstat(target).then(() => true).catch((error) => isMissing(error) ? false : Promise.reject(error))
        if (!exists) break
        counter += 1
      }
      const parentIdentity = await this.guard.identity(path.dirname(target), 'directory')
      await this.guard.verifyIdentity(parentIdentity)
      await copyFile(convertedPath, target, constants.COPYFILE_EXCL)
      await this.guard.verifyIdentity(parentIdentity)
      return this.read(await this.guard.existing(target, 'file'))
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async prepareAiOperation(input: OperationInput): Promise<FileOperationProposal> {
    const rawOperations = Array.isArray(input.operations) ? input.operations : [input]
    if (!rawOperations.length || rawOperations.length > MAX_AI_FILE_OPERATIONS) {
      throw new Error(`AI 每次只能建议 1-${MAX_AI_FILE_OPERATIONS} 个 Markdown 文件操作。`)
    }
    const prepared: MarkdownFileOperation[] = []
    let totalContent = 0
    for (const raw of rawOperations) {
      if (!isRecord(raw) || (raw.kind !== 'create' && raw.kind !== 'append' && raw.kind !== 'replace')) {
        throw new Error('AI 返回了不支持的文件操作。')
      }
      if (typeof raw.targetPath !== 'string' || typeof raw.proposedContent !== 'string') {
        throw new Error('AI 文件操作缺少目标路径或内容。')
      }
      if (raw.proposedContent.length > MAX_AI_OPERATION_CONTENT) throw new Error('单个 AI 建议内容过大，已拒绝。')
      totalContent += raw.proposedContent.length
      if (totalContent > MAX_AI_OPERATION_TOTAL_CONTENT) throw new Error('AI 批量建议总内容过大，已拒绝。')

      const mustExist = raw.kind !== 'create'
      const target = mustExist
        ? await this.guard.assertMarkdown(raw.targetPath, true)
        : await projectTargetAllowMissing(this.guard.root, raw.targetPath)
      if (!/\.(?:md|markdown)$/iu.test(target)) throw new Error('AI 只能写入 .md 或 .markdown 文件。')
      assertNotMetadataPath(this.guard.root, target)
      let originalContent: string | undefined
      let expectedModifiedAt: number | undefined
      if (mustExist) {
        const current = await this.read(target)
        totalContent += current.content.length
        if (totalContent > MAX_AI_OPERATION_TOTAL_CONTENT) throw new Error('AI 批量建议的预览内容过大，已拒绝。')
        originalContent = current.content
        expectedModifiedAt = current.modifiedAt
      } else {
        await assertAbsent(target)
      }
      prepared.push({
        kind: raw.kind,
        targetPath: target,
        proposedContent: raw.proposedContent,
        ...(originalContent !== undefined ? { originalContent } : {}),
        ...(expectedModifiedAt !== undefined ? { expectedModifiedAt } : {})
      })
    }

    const uniqueTargets = new Set(prepared.map((operation) => operation.targetPath))
    if (uniqueTargets.size !== prepared.length) throw new Error('AI 批量建议包含重复的目标文件。')
    for (const operation of prepared) {
      if (prepared.some((other) => other !== operation && isInside(operation.targetPath, other.targetPath))) {
        throw new Error('AI 批量建议把一个 Markdown 文件同时作为另一个文件的父目录。')
      }
    }
    const first = prepared[0]
    const proposal: FileOperationProposal = {
      id: randomUUID(),
      ...first,
      ...(prepared.length > 1 ? { operations: prepared } : {}),
      summary:
        typeof input.summary === 'string' && input.summary.trim()
          ? input.summary.trim().slice(0, 500)
          : prepared.length > 1
            ? `写入 ${prepared.length} 个 Markdown 文件`
            : first.kind === 'create'
              ? `创建 ${path.basename(first.targetPath)}`
              : first.kind === 'append'
                ? `追加到 ${path.basename(first.targetPath)}`
                : `修改 ${path.basename(first.targetPath)}`,
      status: 'pending'
    }
    this.pendingOperations.set(proposal.id, { proposal, createdAt: Date.now() })
    for (const [id, pending] of this.pendingOperations) {
      if (Date.now() - pending.createdAt > 60 * 60 * 1000) this.pendingOperations.delete(id)
    }
    return proposal
  }

  async applyAiOperation(input: FileOperationProposal): Promise<FileOperationApplyResult> {
    if (!input || input.status !== 'accepted') throw new Error('只有用户明确接受的 AI 文件建议才可以写入。')
    const pending = this.pendingOperations.get(input.id)
    if (!pending) throw new Error('AI 文件建议已失效，请重新生成预览。')
    const proposal = pending.proposal
    const expectedOperations = proposalOperations(proposal)
    const receivedOperations = proposalOperations(input)
    if (
      input.kind !== proposal.kind ||
      input.targetPath !== proposal.targetPath ||
      input.proposedContent !== proposal.proposedContent ||
      receivedOperations.length !== expectedOperations.length ||
      !receivedOperations.every((operation, index) => sameMarkdownOperation(operation, expectedOperations[index]))
    ) {
      throw new Error('AI 文件建议在确认前发生变化，操作已拒绝。')
    }

    for (const operation of expectedOperations) {
      if (operation.kind === 'create') {
        await assertAbsent(await projectTargetAllowMissing(this.guard.root, operation.targetPath))
        continue
      }
      const current = await this.read(operation.targetPath)
      if (
        current.modifiedAt !== operation.expectedModifiedAt ||
        current.content !== operation.originalContent
      ) {
        throw new Error('文件在预览后已被修改。请重新加载并生成新的修改建议。')
      }
    }

    const files: FileReadResult[] = []
    const applied: Array<{ operation: MarkdownFileOperation; result: FileReadResult }> = []
    try {
      for (const operation of expectedOperations) {
        let result: FileReadResult
        if (operation.kind === 'create') {
          result = await this.createMarkdown(operation.targetPath, operation.proposedContent)
        } else {
          const current = await this.read(operation.targetPath)
          if (current.modifiedAt !== operation.expectedModifiedAt || current.content !== operation.originalContent) {
            throw new Error('文件在批量写入期间发生变化，剩余操作已停止。')
          }
          const nextContent =
            operation.kind === 'append'
              ? `${current.content}${current.content && !current.content.endsWith('\n') ? '\n' : ''}${operation.proposedContent}`
              : operation.proposedContent
          result = await this.saveMarkdown(operation.targetPath, nextContent, operation.expectedModifiedAt)
        }
        files.push(result)
        applied.push({ operation, result })
      }
      const history = await this.recordOperationHistory(proposal, applied)
      const first = files[0]
      return { ...first, files, historyId: history.id }
    } catch (error) {
      const rollbackFailures: string[] = []
      for (const completed of [...applied].reverse()) {
        try {
          const current = await this.read(completed.result.path)
          if (
            Math.abs(current.modifiedAt - completed.result.modifiedAt) > 1 ||
            current.content !== completed.result.content
          ) {
            throw new Error('文件在回滚前又被外部修改')
          }
          if (completed.operation.kind === 'create') {
            await unlink(await this.guard.existing(completed.result.path, 'file'))
          } else {
            await this.saveMarkdown(
              completed.result.path,
              completed.operation.originalContent ?? '',
              completed.result.modifiedAt
            )
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${path.basename(completed.result.path)}：${rollbackError instanceof Error ? rollbackError.message : '未知错误'}`)
        }
      }
      const reason = error instanceof Error ? error.message : '批量写入失败。'
      if (rollbackFailures.length) {
        throw new Error(`${reason} 已尝试回滚，但以下文件需要人工检查：${rollbackFailures.join('；')}`)
      }
      throw new Error(`${reason} 已完成写入均已回滚。`)
    } finally {
      this.pendingOperations.delete(proposal.id)
    }
  }
}
