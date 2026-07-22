import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type {
  AiRequest,
  AiOcrRequest,
  AiStreamEvent,
  Annotation,
  AppSettings,
  ChatSession,
  FileChangeEvent,
  FileOperationProposal,
  ScreenshotCaptureEvent,
  SpeechRecognitionEvent,
  ResearchBrowserBounds,
  ResearchBrowserExtractMode,
  ResearchBrowserSelectionEvent,
  ResearchBrowserState,
  OcrResult,
  SearchProgress,
  CoScribeAPI,
  WorkspaceState
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: CoScribeAPI = {
  app: {
    platform: process.platform,
    version: () => ipcRenderer.invoke(IPC.appVersion)
  },
  project: {
    recent: () => ipcRenderer.invoke(IPC.projectRecent),
    chooseLocation: () => ipcRenderer.invoke(IPC.projectChooseLocation),
    create: (name: string, parentPath: string) => ipcRenderer.invoke(IPC.projectCreate, name, parentPath),
    openDialog: () => ipcRenderer.invoke(IPC.projectOpenDialog),
    openPath: (projectPath: string) => ipcRenderer.invoke(IPC.projectOpenPath, projectPath),
    initial: () => ipcRenderer.invoke(IPC.projectInitial),
    close: () => ipcRenderer.invoke(IPC.projectClose),
    tree: () => ipcRenderer.invoke(IPC.projectTree),
    getState: () => ipcRenderer.invoke(IPC.projectGetState),
    saveState: (state: WorkspaceState) => ipcRenderer.invoke(IPC.projectSaveState, state),
    memory: () => ipcRenderer.invoke(IPC.projectMemory),
    saveMemory: (content: string) => ipcRenderer.invoke(IPC.projectSaveMemory, content),
    operationHistory: () => ipcRenderer.invoke(IPC.projectOperationHistory),
    undoOperation: (historyId: string) => ipcRenderer.invoke(IPC.projectUndoOperation, historyId),
    onFilesChanged: (listener: (events: FileChangeEvent[]) => void) => subscribe(IPC.projectFilesChanged, listener)
  },
  file: {
    read: (filePath: string) => ipcRenderer.invoke(IPC.fileRead, filePath),
    saveMarkdown: (filePath: string, content: string, expectedModifiedAt?: number) =>
      ipcRenderer.invoke(IPC.fileSaveMarkdown, filePath, content, expectedModifiedAt),
    createMarkdown: (filePath: string, content?: string) => ipcRenderer.invoke(IPC.fileCreateMarkdown, filePath, content),
    createFolder: (filePath: string) => ipcRenderer.invoke(IPC.fileCreateFolder, filePath),
    rename: (filePath: string, nextName: string) => ipcRenderer.invoke(IPC.fileRename, filePath, nextName),
    move: (filePath: string, targetFolder: string) => ipcRenderer.invoke(IPC.fileMove, filePath, targetFolder),
    trash: (filePath: string) => ipcRenderer.invoke(IPC.fileTrash, filePath),
    importFiles: (sourcePaths: string[], targetFolder: string) => ipcRenderer.invoke(IPC.fileImportFiles, sourcePaths, targetFolder),
    reveal: (filePath: string) => ipcRenderer.invoke(IPC.fileReveal, filePath),
    openExternal: (filePath: string) => ipcRenderer.invoke(IPC.fileOpenExternal, filePath),
    url: (filePath: string) => ipcRenderer.invoke(IPC.fileUrl, filePath),
    convertPowerPointToPdf: (filePath: string) => ipcRenderer.invoke(IPC.fileConvertPowerPointToPdf, filePath),
    pathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
    applyAiOperation: (operation: FileOperationProposal) => ipcRenderer.invoke(IPC.fileApplyAiOperation, operation)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    save: (sessions: ChatSession[]) => ipcRenderer.invoke(IPC.sessionsSave, sessions)
  },
  annotations: {
    list: () => ipcRenderer.invoke(IPC.annotationsList),
    save: (annotations: Annotation[]) => ipcRenderer.invoke(IPC.annotationsSave, annotations)
  },
  search: {
    query: (requestId: string, query: string) => ipcRenderer.invoke(IPC.searchQuery, requestId, query),
    cancel: (requestId: string) => ipcRenderer.invoke(IPC.searchCancel, requestId),
    onProgress: (listener: (progress: SearchProgress) => void) => subscribe(IPC.searchProgress, listener)
  },
  knowledge: {
    status: () => ipcRenderer.invoke(IPC.knowledgeStatus),
    rebuild: () => ipcRenderer.invoke(IPC.knowledgeRebuild),
    backlinks: () => ipcRenderer.invoke(IPC.knowledgeBacklinks)
  },
  plugins: {
    data: (pluginId: string) => ipcRenderer.invoke(IPC.pluginData, pluginId),
    saveData: (pluginId: string, value: unknown) => ipcRenderer.invoke(IPC.pluginSaveData, pluginId, value)
  },
  calendar: {
    sync: (request) => ipcRenderer.invoke(IPC.calendarSync, request)
  },
  diagnostics: {
    snapshot: () => ipcRenderer.invoke(IPC.diagnosticsSnapshot)
  },
  references: {
    lookupDoi: (doi: string) => ipcRenderer.invoke(IPC.referencesLookupDoi, doi)
  },
  mcp: {
    listServers: () => ipcRenderer.invoke(IPC.mcpListServers),
    saveServer: (server) => ipcRenderer.invoke(IPC.mcpSaveServer, server),
    removeServer: (serverId: string) => ipcRenderer.invoke(IPC.mcpRemoveServer, serverId),
    inspect: (serverId: string) => ipcRenderer.invoke(IPC.mcpInspect, serverId),
    invoke: (request) => ipcRenderer.invoke(IPC.mcpInvoke, request)
  },
  gitSnapshots: {
    status: () => ipcRenderer.invoke(IPC.gitSnapshotStatus),
    create: (message: string) => ipcRenderer.invoke(IPC.gitSnapshotCreate, message),
    history: (limit?: number) => ipcRenderer.invoke(IPC.gitSnapshotHistory, limit)
  },
  webTracker: {
    list: () => ipcRenderer.invoke(IPC.webTrackerList),
    add: (input) => ipcRenderer.invoke(IPC.webTrackerAdd, input),
    update: (sourceId: string, input) => ipcRenderer.invoke(IPC.webTrackerUpdate, sourceId, input),
    remove: (sourceId: string) => ipcRenderer.invoke(IPC.webTrackerRemove, sourceId),
    check: (sourceId?: string) => ipcRenderer.invoke(IPC.webTrackerCheck, sourceId)
  },
  pdf: {
    pageText: (filePath: string, page: number) => ipcRenderer.invoke(IPC.pdfPageText, filePath, page),
    search: (filePath: string, query: string) => ipcRenderer.invoke(IPC.pdfSearch, filePath, query)
  },
  ocr: {
    get: (filePath: string, page?: number) => ipcRenderer.invoke(IPC.ocrGet, filePath, page),
    save: (result: OcrResult) => ipcRenderer.invoke(IPC.ocrSave, result),
    enhance: (request: AiOcrRequest) => ipcRenderer.invoke(IPC.ocrEnhance, request),
    stop: (requestId: string) => ipcRenderer.invoke(IPC.ocrStop, requestId)
  },
  screenshot: {
    capture: () => ipcRenderer.invoke(IPC.screenshotCapture),
    onResult: (listener: (event: ScreenshotCaptureEvent) => void) => subscribe(IPC.screenshotResult, listener)
  },
  speech: {
    status: () => ipcRenderer.invoke(IPC.speechStatus),
    start: (requestId: string, sampleRate: number) => ipcRenderer.invoke(IPC.speechStart, requestId, sampleRate),
    audio: (requestId: string, samples: Float32Array) => ipcRenderer.send(IPC.speechAudio, requestId, samples),
    stop: (requestId: string) => ipcRenderer.invoke(IPC.speechStop, requestId),
    onEvent: (listener: (event: SpeechRecognitionEvent) => void) => subscribe(IPC.speechEvent, listener)
  },
  browser: {
    open: (url?: string) => ipcRenderer.invoke(IPC.browserOpen, url),
    navigate: (url: string) => ipcRenderer.invoke(IPC.browserNavigate, url),
    back: () => ipcRenderer.invoke(IPC.browserBack),
    forward: () => ipcRenderer.invoke(IPC.browserForward),
    reload: () => ipcRenderer.invoke(IPC.browserReload),
    stop: () => ipcRenderer.invoke(IPC.browserStop),
    state: () => ipcRenderer.invoke(IPC.browserStateGet),
    setBounds: (bounds: ResearchBrowserBounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
    setVisible: (visible: boolean) => ipcRenderer.invoke(IPC.browserSetVisible, visible),
    extract: (mode: ResearchBrowserExtractMode) => ipcRenderer.invoke(IPC.browserExtract, mode),
    saveArchive: () => ipcRenderer.invoke(IPC.browserSaveArchive),
    saveMarkdown: () => ipcRenderer.invoke(IPC.browserSaveMarkdown),
    savePdf: () => ipcRenderer.invoke(IPC.browserSavePdf),
    openExternal: (url?: string) => ipcRenderer.invoke(IPC.browserOpenExternal, url),
    close: () => ipcRenderer.invoke(IPC.browserClose),
    onState: (listener: (state: ResearchBrowserState) => void) => subscribe(IPC.browserState, listener),
    onSelection: (listener: (event: ResearchBrowserSelectionEvent) => void) => subscribe(IPC.browserSelection, listener)
  },
  images: {
    generate: (request) => ipcRenderer.invoke(IPC.imagesGenerate, request),
    stop: (requestId: string) => ipcRenderer.invoke(IPC.imagesStop, requestId)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    save: (value: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, value)
  },
  ai: {
    start: (request: AiRequest) => ipcRenderer.invoke(IPC.aiStart, request),
    stop: (requestId: string) => ipcRenderer.invoke(IPC.aiStop, requestId),
    onStream: (listener: (event: AiStreamEvent) => void) => subscribe(IPC.aiStream, listener)
  }
}

contextBridge.exposeInMainWorld('coscribe', Object.freeze(api))
