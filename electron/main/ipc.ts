import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

import type {
  AiRequest,
  AiOcrRequest,
  Annotation,
  AppSettings,
  ChatSession,
  FileOperationProposal,
  ImageGenerationRequest,
  OcrResult,
  ResearchBrowserBounds,
  ResearchBrowserExtractMode,
  WorkspaceState
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { AiService } from './ai'
import { ResearchBrowserService } from './browser'
import { PdfTextService } from './pdf'
import { ProjectService } from './project'
import { ProjectSearchService } from './search'
import { ScreenshotService } from './screenshot'
import { SettingsStore } from './settings'
import { SpeechRecognitionService } from './speech'

interface Services {
  project: ProjectService
  pdf: PdfTextService
  search: ProjectSearchService
  settings: SettingsStore
  ai: AiService
  screenshot: ScreenshotService
  browser: ResearchBrowserService
  speech: SpeechRecognitionService
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || frame.url !== event.sender.getURL()) {
    throw new Error('拒绝来自非主窗口页面的 IPC 请求。')
  }
  let senderUrl: URL
  try {
    senderUrl = new URL(frame.url)
  } catch {
    throw new Error('IPC 请求来源无效。')
  }
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    if (senderUrl.origin !== new URL(developmentUrl).origin) throw new Error('IPC 请求来源不受信任。')
    return
  }
  if (senderUrl.protocol !== 'coscribe-app:' || senderUrl.hostname !== 'app' || senderUrl.pathname !== '/index.html') {
    throw new Error('IPC 请求来源不受信任。')
  }
}

function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return listener(event, ...args)
  })
}

export function registerIpc(services: Services): void {
  const { project, pdf, search, settings, ai, screenshot, browser, speech } = services

  handle(IPC.appVersion, () => app.getVersion())

  handle(IPC.projectRecent, () => project.recent())
  handle(IPC.projectChooseLocation, () => project.chooseLocation())
  handle(IPC.projectCreate, (_event, name: string, parentPath: string) => project.create(name, parentPath))
  handle(IPC.projectOpenDialog, () => project.openDialog())
  handle(IPC.projectOpenPath, (_event, projectPath: string) => project.openPath(projectPath))
  handle(IPC.projectInitial, () => project.initial())
  handle(IPC.projectClose, async () => {
    await project.close()
  })
  handle(IPC.projectTree, () => project.tree())
  handle(IPC.projectGetState, () => project.getState())
  handle(IPC.projectSaveState, (_event, state: WorkspaceState) => project.saveState(state))
  handle(IPC.projectMemory, () => project.memory())
  handle(IPC.projectSaveMemory, (_event, content: string) => project.saveMemory(content))

  handle(IPC.fileRead, (_event, filePath: string) => project.read(filePath))
  handle(IPC.fileSaveMarkdown, (_event, filePath: string, content: string, expectedModifiedAt?: number) =>
    project.saveMarkdown(filePath, content, expectedModifiedAt)
  )
  handle(IPC.fileCreateMarkdown, (_event, filePath: string, content?: string) => project.createMarkdown(filePath, content))
  handle(IPC.fileCreateFolder, (_event, filePath: string) => project.createFolder(filePath))
  handle(IPC.fileRename, (_event, filePath: string, nextName: string) => project.rename(filePath, nextName))
  handle(IPC.fileMove, (_event, filePath: string, targetFolder: string) => project.move(filePath, targetFolder))
  handle(IPC.fileTrash, (_event, filePath: string) => project.trash(filePath))
  handle(IPC.fileImportFiles, (_event, sourcePaths: string[], targetFolder: string) => project.importFiles(sourcePaths, targetFolder))
  handle(IPC.fileReveal, (_event, filePath: string) => project.reveal(filePath))
  handle(IPC.fileOpenExternal, (_event, filePath: string) => project.openExternal(filePath))
  handle(IPC.fileUrl, (_event, filePath: string) => project.url(filePath))
  handle(IPC.fileConvertPowerPointToPdf, (_event, filePath: string) => project.convertPowerPointToPdf(filePath))
  handle(IPC.fileApplyAiOperation, (_event, operation: FileOperationProposal) => project.applyAiOperation(operation))

  handle(IPC.sessionsList, () => project.listSessions())
  handle(IPC.sessionsSave, (_event, sessions: ChatSession[]) => project.saveSessions(sessions))
  handle(IPC.annotationsList, () => project.listAnnotations())
  handle(IPC.annotationsSave, (_event, annotations: Annotation[]) => project.saveAnnotations(annotations))

  handle(IPC.searchQuery, (event, requestId: string, query: string) => search.query(event.sender, requestId, query))
  handle(IPC.searchCancel, (_event, requestId: string) => search.cancel(requestId))

  handle(IPC.pdfPageText, (_event, filePath: string, page: number) => pdf.pageText(filePath, page))
  handle(IPC.pdfSearch, (_event, filePath: string, query: string) => pdf.search(filePath, query))

  handle(IPC.ocrGet, (_event, filePath: string, page?: number) => project.getOcr(filePath, page))
  handle(IPC.ocrSave, (_event, result: OcrResult) => project.saveOcr(result))
  handle(IPC.ocrEnhance, (_event, request: AiOcrRequest) => ai.enhanceImage(request))
  handle(IPC.ocrStop, (_event, requestId: string) => ai.stopOcr(requestId))

  handle(IPC.screenshotCapture, () => screenshot.capture())

  handle(IPC.speechStatus, () => speech.status())
  handle(IPC.speechStart, (event, requestId: string, sampleRate: number) => speech.start(event.sender, requestId, sampleRate))
  handle(IPC.speechStop, (event, requestId: string) => speech.stop(event.sender, requestId))
  ipcMain.removeAllListeners(IPC.speechAudio)
  ipcMain.on(IPC.speechAudio, (event, requestId: string, samples: unknown) => {
    assertTrustedSender(event)
    speech.audio(event.sender, requestId, samples)
  })

  handle(IPC.browserOpen, (_event, url?: string) => browser.open(url))
  handle(IPC.browserNavigate, (_event, url: string) => browser.navigate(url))
  handle(IPC.browserBack, () => browser.back())
  handle(IPC.browserForward, () => browser.forward())
  handle(IPC.browserReload, () => browser.reload())
  handle(IPC.browserStop, () => browser.stop())
  handle(IPC.browserStateGet, () => browser.state())
  handle(IPC.browserSetBounds, (_event, bounds: ResearchBrowserBounds) => browser.setBounds(bounds))
  handle(IPC.browserSetVisible, (_event, visible: boolean) => browser.setVisible(visible))
  handle(IPC.browserExtract, (_event, mode: ResearchBrowserExtractMode) => browser.extract(mode))
  handle(IPC.browserSaveArchive, () => browser.saveArchive())
  handle(IPC.browserSaveMarkdown, () => browser.saveMarkdown())
  handle(IPC.browserSavePdf, () => browser.savePdf())
  handle(IPC.browserOpenExternal, (_event, url?: string) => browser.openExternal(url))
  handle(IPC.browserClose, () => browser.close())

  handle(IPC.imagesGenerate, (_event, request: ImageGenerationRequest) => ai.generateImage(request))
  handle(IPC.imagesStop, (_event, requestId: string) => ai.stopImage(requestId))

  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSave, (_event, value: AppSettings) => settings.save(value))

  handle(IPC.aiStart, (event, request: AiRequest) => ai.start(event.sender, request))
  handle(IPC.aiStop, (_event, requestId: string) => ai.stop(requestId))
}
