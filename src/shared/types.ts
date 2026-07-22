export type FileKind = 'folder' | 'markdown' | 'pdf' | 'docx' | 'ppt' | 'pptx' | 'webarchive' | 'image' | 'text' | 'unsupported'

export interface FileNode {
  name: string
  path: string
  kind: FileKind
  size: number
  modifiedAt: number
  children?: FileNode[]
}

export interface ProjectRef {
  name: string
  path: string
  openedAt: number
  exists: boolean
}

export interface ProjectInfo extends ProjectRef {
  createdAt?: number
}

export interface OpenTab {
  id: string
  path: string
  name: string
  kind: Exclude<FileKind, 'folder'>
  missing?: boolean
}

export type PaneId = 'primary' | 'secondary'

export interface PaneState {
  tabIds: string[]
  activeTabId: string | null
}

export interface PdfReadingState {
  page: number
  scale: number
  fit: 'width' | 'page' | 'custom'
  scrollTop: number
}

export interface MarkdownReadingState {
  scrollTop: number
  cursor: number
  mode: 'edit' | 'preview' | 'both'
}

export interface WorkspaceState {
  version: 1
  tabs: OpenTab[]
  panes: Record<PaneId, PaneState>
  activePane: PaneId
  split: boolean
  pdf: Record<string, PdfReadingState>
  markdown: Record<string, MarkdownReadingState>
  navSection: 'files' | 'sessions' | 'search' | 'annotations'
  aiVisible: boolean
  leftWidth: number
  aiWidth: number
  currentSessionId: string | null
}

export type ContextScope = 'selection' | 'visible' | 'document' | 'project' | 'general'

export interface ContextSnapshot {
  projectName: string
  projectPath: string
  pane: PaneId
  documentPath?: string
  documentName?: string
  /** Verified http(s) URL captured by the isolated research browser. */
  webUrl?: string
  kind?: FileKind
  pdfPage?: number
  visiblePages?: number[]
  markdownHeading?: string
  selection?: string
  visibleText?: string
  sectionText?: string
  documentText?: string
  scope: ContextScope
  referencedFiles: string[]
  capturedAt: number
}

export interface SourceRef {
  path: string
  label: string
  kind: 'pdf' | 'markdown' | 'docx' | 'ppt' | 'pptx' | 'image' | 'text' | 'session' | 'web' | 'general'
  page?: number
  heading?: string
  line?: number
  excerpt?: string
}

export type FileOperationKind = 'create' | 'append' | 'replace'

export interface MarkdownFileOperation {
  kind: FileOperationKind
  targetPath: string
  proposedContent: string
  originalContent?: string
  expectedModifiedAt?: number
}

export interface FileOperationProposal extends MarkdownFileOperation {
  id: string
  /** Present for a multi-file proposal; legacy single-file fields above mirror the first item. */
  operations?: MarkdownFileOperation[]
  summary: string
  status: 'pending' | 'accepted' | 'rejected' | 'failed'
  error?: string
}

export interface ChatImageAttachment {
  id: string
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  dataUrl: string
  size: number
  /** Slash-separated path relative to the current project root. */
  projectRelativePath?: string
  /** Canonical local path. Main-process validation is required before this is trusted. */
  absolutePath?: string
}

export type ScreenshotCaptureEvent =
  | { type: 'captured'; attachment: ChatImageAttachment }
  | { type: 'error'; message: string }

export interface ResearchBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ResearchBrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  secure: boolean
  error?: string
  notice?: string
}

export type ResearchBrowserExtractMode = 'selection' | 'article'

export interface ResearchBrowserExtractResult {
  mode: ResearchBrowserExtractMode
  title: string
  url: string
  text: string
  markdown: string
}

export type ResearchBrowserSelectionEvent =
  | { type: 'captured'; result: ResearchBrowserExtractResult }
  | { type: 'error'; message: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  attachments?: ChatImageAttachment[]
  context?: ContextSnapshot
  sources?: SourceRef[]
  operation?: FileOperationProposal
  stopped?: boolean
  error?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface Annotation {
  id: string
  path: string
  page: number
  kind: 'highlight' | 'comment' | 'bookmark'
  quote?: string
  comment?: string
  color?: 'amber' | 'mint' | 'blue' | 'rose'
  createdAt: number
}

export interface SearchResult {
  id: string
  type: 'file' | 'content' | 'session'
  path?: string
  sessionId?: string
  title: string
  excerpt: string
  kind?: FileKind
  page?: number
  line?: number
  heading?: string
  score: number
}

export interface SearchProgress {
  requestId: string
  scanned: number
  total?: number
  current?: string
  done: boolean
}

export interface FileReadResult {
  path: string
  kind: FileKind
  content: string
  modifiedAt: number
  size: number
  url?: string
  html?: string
  warnings?: string[]
  ocrResults?: OcrResult[]
}

export interface FileOperationApplyResult extends FileReadResult {
  /** All affected files. The inherited fields mirror the first file for compatibility. */
  files: FileReadResult[]
}

export type OcrEngine = 'paddleocr-v6' | 'ai-vision'

export interface OcrPoint {
  x: number
  y: number
}

export interface OcrLine {
  text: string
  score?: number
  polygon?: OcrPoint[]
}

export interface OcrResult {
  path: string
  page?: number
  text: string
  lines: OcrLine[]
  engine: OcrEngine
  model: string
  createdAt: number
  sourceModifiedAt: number
  sourceSize: number
  warnings?: string[]
}

export interface AiOcrRequest {
  requestId: string
  path: string
  page?: number
  imageDataUrl: string
}

export type ImageGenerationSize = '1024x1024' | '1536x1024' | '1024x1536'
export type ImageGenerationQuality = 'low' | 'medium' | 'high'

export interface ImageGenerationRequest {
  requestId: string
  prompt: string
  size: ImageGenerationSize
  quality: ImageGenerationQuality
}

export interface ImageGenerationResult {
  attachment: ChatImageAttachment
  model: 'gpt-image-2'
  size: ImageGenerationSize
  quality: ImageGenerationQuality
  createdAt: number
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export interface AiSettings {
  baseUrl: string
  model: string
  apiProtocol: AiProtocol
  reasoningEffort: ReasoningEffort
  hasApiKey: boolean
}

export type AiProtocol = 'auto' | 'responses' | 'chat-completions'
export const SELECTABLE_AI_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const
// The picker mirrors the six GPT-5.6 levels requested by the UI. The API also supports `none`, but this app keeps it out of the reasoning picker.
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const

export type SelectableAiModel = (typeof SELECTABLE_AI_MODELS)[number]
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface AppSettings extends AiSettings {
  apiKey?: string
  imageBaseUrl: string
  imageApiKey?: string
  hasImageApiKey: boolean
  theme: 'light' | 'dark' | 'system'
  fontSize: number
  defaultProjectPath: string
  autoSave: boolean
  autoSaveDelay: number
  defaultContextScope: ContextScope
  allowGeneralKnowledge: boolean
  autoTitle: boolean
}

export interface AiRequest {
  requestId: string
  sessionId: string
  messages: Pick<ChatMessage, 'role' | 'content' | 'attachments'>[]
  context: ContextSnapshot
  settings?: Partial<Pick<AppSettings, 'allowGeneralKnowledge'>>
}

export type AiStreamEvent =
  | { requestId: string; type: 'start' }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; sources: SourceRef[]; operation?: FileOperationProposal }
  | { requestId: string; type: 'stopped' }
  | { requestId: string; type: 'error'; message: string }

export interface PdfPageText {
  page: number
  text: string
  readable: boolean
}

export interface PdfSearchMatch {
  page: number
  excerpt: string
  count: number
}

export interface CoScribeAPI {
  app: {
    platform: string
    version: () => Promise<string>
  }
  project: {
    recent: () => Promise<ProjectRef[]>
    chooseLocation: () => Promise<string | null>
    create: (name: string, parentPath: string) => Promise<ProjectInfo>
    openDialog: () => Promise<ProjectInfo | null>
    openPath: (path: string) => Promise<ProjectInfo>
    initial: () => Promise<ProjectInfo | null>
    close: () => Promise<void>
    tree: () => Promise<FileNode[]>
    getState: () => Promise<WorkspaceState>
    saveState: (state: WorkspaceState) => Promise<void>
    onFilesChanged: (listener: (events: FileChangeEvent[]) => void) => () => void
  }
  file: {
    read: (path: string) => Promise<FileReadResult>
    saveMarkdown: (path: string, content: string, expectedModifiedAt?: number) => Promise<FileReadResult>
    createMarkdown: (path: string, content?: string) => Promise<FileReadResult>
    createFolder: (path: string) => Promise<void>
    rename: (path: string, nextName: string) => Promise<string>
    move: (path: string, targetFolder: string) => Promise<string>
    trash: (path: string) => Promise<void>
    importFiles: (sourcePaths: string[], targetFolder: string) => Promise<string[]>
    reveal: (path: string) => Promise<void>
    openExternal: (path: string) => Promise<void>
    url: (path: string) => Promise<string>
    convertPowerPointToPdf: (path: string) => Promise<FileReadResult>
    pathForDroppedFile: (file: File) => string
    applyAiOperation: (operation: FileOperationProposal) => Promise<FileOperationApplyResult>
  }
  sessions: {
    list: () => Promise<ChatSession[]>
    save: (sessions: ChatSession[]) => Promise<void>
  }
  annotations: {
    list: () => Promise<Annotation[]>
    save: (annotations: Annotation[]) => Promise<void>
  }
  search: {
    query: (requestId: string, query: string) => Promise<SearchResult[]>
    cancel: (requestId: string) => Promise<void>
    onProgress: (listener: (progress: SearchProgress) => void) => () => void
  }
  pdf: {
    pageText: (path: string, page: number) => Promise<PdfPageText>
    search: (path: string, query: string) => Promise<PdfSearchMatch[]>
  }
  ocr: {
    get: (path: string, page?: number) => Promise<OcrResult | null>
    save: (result: OcrResult) => Promise<OcrResult>
    enhance: (request: AiOcrRequest) => Promise<OcrResult>
    stop: (requestId: string) => Promise<void>
  }
  screenshot: {
    capture: () => Promise<ChatImageAttachment>
    onResult: (listener: (event: ScreenshotCaptureEvent) => void) => () => void
  }
  browser: {
    open: (url?: string) => Promise<ResearchBrowserState>
    navigate: (url: string) => Promise<ResearchBrowserState>
    back: () => Promise<ResearchBrowserState>
    forward: () => Promise<ResearchBrowserState>
    reload: () => Promise<ResearchBrowserState>
    stop: () => Promise<ResearchBrowserState>
    state: () => Promise<ResearchBrowserState>
    setBounds: (bounds: ResearchBrowserBounds) => Promise<void>
    setVisible: (visible: boolean) => Promise<void>
    extract: (mode: ResearchBrowserExtractMode) => Promise<ResearchBrowserExtractResult>
    saveArchive: () => Promise<FileReadResult>
    saveMarkdown: () => Promise<FileReadResult>
    savePdf: () => Promise<FileReadResult>
    openExternal: (url?: string) => Promise<void>
    close: () => Promise<void>
    onState: (listener: (state: ResearchBrowserState) => void) => () => void
    onSelection: (listener: (event: ResearchBrowserSelectionEvent) => void) => () => void
  }
  images: {
    generate: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>
    stop: (requestId: string) => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    save: (settings: AppSettings) => Promise<AppSettings>
  }
  ai: {
    start: (request: AiRequest) => Promise<void>
    stop: (requestId: string) => Promise<void>
    onStream: (listener: (event: AiStreamEvent) => void) => () => void
  }
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  version: 1,
  tabs: [],
  panes: {
    primary: { tabIds: [], activeTabId: null },
    secondary: { tabIds: [], activeTabId: null }
  },
  activePane: 'primary',
  split: false,
  pdf: {},
  markdown: {},
  navSection: 'files',
  aiVisible: true,
  leftWidth: 260,
  aiWidth: 360,
  currentSessionId: null
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6-terra',
  apiProtocol: 'auto',
  reasoningEffort: 'medium',
  hasApiKey: false,
  imageBaseUrl: 'https://api.openai.com/v1',
  hasImageApiKey: false,
  theme: 'system',
  fontSize: 15,
  defaultProjectPath: '',
  autoSave: true,
  autoSaveDelay: 900,
  defaultContextScope: 'visible',
  allowGeneralKnowledge: true,
  autoTitle: true
}
