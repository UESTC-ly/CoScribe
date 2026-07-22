import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  AiRequest,
  AiOcrRequest,
  Annotation,
  AppSettings,
  ChatSession,
  FileOperationProposal,
  OcrResult,
  WorkspaceState
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { AiService } from './ai'
import { PdfTextService } from './pdf'
import { ProjectService } from './project'
import { ProjectSearchService } from './search'
import { SettingsStore } from './settings'

interface Services {
  project: ProjectService
  pdf: PdfTextService
  search: ProjectSearchService
  settings: SettingsStore
  ai: AiService
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
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
  const { project, pdf, search, settings, ai } = services

  handle(IPC.appVersion, () => app.getVersion())

  handle(IPC.projectRecent, () => project.recent())
  handle(IPC.projectChooseLocation, () => project.chooseLocation())
  handle(IPC.projectCreate, (_event, name: string, parentPath: string) => project.create(name, parentPath))
  handle(IPC.projectOpenDialog, () => project.openDialog())
  handle(IPC.projectOpenPath, (_event, projectPath: string) => project.openPath(projectPath))
  handle(IPC.projectInitial, () => project.initial())
  handle(IPC.projectClose, async () => {
    ai.stopAll()
    await project.close()
  })
  handle(IPC.projectTree, () => project.tree())
  handle(IPC.projectGetState, () => project.getState())
  handle(IPC.projectSaveState, (_event, state: WorkspaceState) => project.saveState(state))

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
  handle(IPC.fileUrl, (_event, filePath: string) => project.url(filePath))
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

  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSave, (_event, value: AppSettings) => settings.save(value))

  handle(IPC.aiStart, (event, request: AiRequest) => ai.start(event.sender, request))
  handle(IPC.aiStop, (_event, requestId: string) => ai.stop(requestId))
}
