import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { app, BrowserWindow, globalShortcut, net, protocol, session, shell, type MediaAccessPermissionRequest } from 'electron'

import { IPC } from '../ipc-channels'
import { AiService } from './ai'
import { CalendarService } from './calendar'
import { DiagnosticsService } from './diagnostics'
import { KnowledgeIndexService } from './knowledge-index'
import { ResearchBrowserService } from './browser'
import { registerIpc } from './ipc'
import { PdfTextService } from './pdf'
import { ProjectService } from './project'
import { ProjectSearchService } from './search'
import { ScreenshotService } from './screenshot'
import { SettingsStore } from './settings'
import { SpeechRecognitionService } from './speech'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'coscribe-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'coscribe-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

app.setName('CoScribe')

const isolatedTestData = process.env.NODE_ENV === 'test'
  ? process.env.COSCRIBE_USER_DATA_DIR ?? process.env.VIBE_USER_DATA_DIR
  : undefined
if (isolatedTestData) {
  app.setPath('userData', path.resolve(isolatedTestData))
} else {
  // Keep the legacy data directory so an in-place rename does not lose recent
  // projects, encrypted API credentials, settings or other local state.
  app.setPath('userData', path.join(app.getPath('appData'), 'vibeknowledge'))
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const rendererDirectory = path.resolve(currentDirectory, '../renderer')
let mainWindow: BrowserWindow | null = null

function allowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function trustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) return url.origin === new URL(developmentUrl).origin
    return url.protocol === 'coscribe-app:' && url.hostname === 'app' && url.pathname === '/index.html'
  } catch {
    return false
  }
}

const settings = new SettingsStore()
let pdf: PdfTextService
let knowledge: KnowledgeIndexService
const projectLifecycle = {
  ai: null as AiService | null,
  browser: null as ResearchBrowserService | null,
  speech: null as SpeechRecognitionService | null
}
const project = new ProjectService(
  settings,
  (events) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.projectFilesChanged, events)
  },
  (filePath) => {
    pdf?.invalidate(filePath)
    knowledge?.invalidate(filePath)
  },
  () => {
    projectLifecycle.ai?.stopAll()
    projectLifecycle.browser?.close()
    projectLifecycle.speech?.stopAll()
    knowledge?.reset()
  }
)
pdf = new PdfTextService(() => project.guard)
knowledge = new KnowledgeIndexService(project, pdf)
const search = new ProjectSearchService(project, knowledge)
const ai = new AiService(settings, project, pdf, search)
projectLifecycle.ai = ai
const screenshot = new ScreenshotService(() => mainWindow)
const speech = new SpeechRecognitionService()
projectLifecycle.speech = speech
const browser = new ResearchBrowserService(() => mainWindow, project)
projectLifecycle.browser = browser
const calendar = new CalendarService()
const diagnostics = new DiagnosticsService(knowledge, settings, speech)

async function openExternalProject(projectPath: string): Promise<void> {
  await project.openPath(projectPath)
  mainWindow?.webContents.reload()
}

function directoryArgument(argv: string[]): string | null {
  const explicit: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--project' || value === '--open') {
      if (argv[index + 1]) explicit.push(argv[index + 1])
      index += 1
    } else if (value.startsWith('--project=') || value.startsWith('--open=')) {
      explicit.push(value.slice(value.indexOf('=') + 1))
    } else if (value === '--') {
      explicit.push(...argv.slice(index + 1))
      break
    } else if (app.isPackaged && !value.startsWith('-')) {
      explicit.push(value)
    }
  }
  for (const candidate of explicit) {
    try {
      const absolute = path.resolve(candidate)
      if (statSync(absolute).isDirectory()) return absolute
    } catch {
      // Ignore command line values that are not existing directories.
    }
  }
  return null
}

const startupDirectory = directoryArgument(process.argv.slice(1))
if (startupDirectory) project.setInitialPath(startupDirectory)

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'CoScribe',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (!current) return
    try {
      const currentUrl = new URL(current)
      const nextUrl = new URL(url)
      const sameHttpOrigin =
        (currentUrl.protocol === 'http:' || currentUrl.protocol === 'https:') && currentUrl.origin === nextUrl.origin
      const samePackagedPage =
        currentUrl.protocol === 'coscribe-app:' &&
        nextUrl.protocol === 'coscribe-app:' &&
        currentUrl.origin === nextUrl.origin
      if (sameHttpOrigin || samePackagedPage) return
    } catch {
      // Invalid navigation is denied below.
    }
    event.preventDefault()
    if (allowedExternalUrl(url)) void shell.openExternal(url)
  })
  window.on('closed', () => {
    browser.detachWindow(window)
    if (mainWindow === window) mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadURL('coscribe-app://app/index.html')
  return window
}

app.on('second-instance', (_event, argv) => {
  const candidate = directoryArgument(argv.slice(1))
  if (candidate) {
    void openExternalProject(candidate).catch(() => undefined)
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  try {
    if (!statSync(filePath).isDirectory()) return
  } catch {
    return
  }
  if (app.isReady()) {
    void openExternalProject(filePath).catch(() => undefined)
  } else {
    project.setInitialPath(filePath)
  }
})

void app.whenReady().then(() => {
  app.setAppUserModelId('com.coscribe.app')
  const defaultSession = session.defaultSession
  defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    permission === 'media' &&
    details.isMainFrame &&
    details.mediaType === 'audio' &&
    Boolean(webContents && webContents === mainWindow?.webContents && trustedRendererUrl(webContents.getURL()))
  ))
  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const media = details as MediaAccessPermissionRequest
    const audioOnly = Array.isArray(media.mediaTypes) && media.mediaTypes.length === 1 && media.mediaTypes[0] === 'audio'
    callback(
      permission === 'media' &&
      audioOnly &&
      webContents === mainWindow?.webContents &&
      trustedRendererUrl(webContents.getURL())
    )
  })
  registerIpc({ project, pdf, search, settings, ai, screenshot, browser, speech, knowledge, calendar, diagnostics })
  protocol.handle('coscribe-app', async (request) => {
    try {
      const parsed = new URL(request.url)
      if (parsed.hostname !== 'app') throw new Error('无效的应用资源地址。')
      const decoded = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html'
      const filePath = path.resolve(rendererDirectory, decoded)
      const relative = path.relative(rendererDirectory, filePath)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('应用资源路径越界。')
      }
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  protocol.handle('coscribe-file', async (request) => {
    try {
      const filePath = await project.pathFromProtocol(request.url)
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取项目文件。'
      return new Response(message, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
  })
  mainWindow = createWindow()
  const screenshotShortcutRegistered = globalShortcut.register('CommandOrControl+Shift+8', () => {
    void screenshot.capture().then(
      (attachment) => {
        if (attachment) mainWindow?.webContents.send(IPC.screenshotResult, { type: 'captured', attachment })
      },
      (error: unknown) => mainWindow?.webContents.send(IPC.screenshotResult, {
        type: 'error',
        message: error instanceof Error ? error.message : '截图失败。'
      })
    )
  })
  if (!screenshotShortcutRegistered && mainWindow) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.webContents.send(IPC.screenshotResult, {
        type: 'error',
        message: '截图快捷键 Cmd/Ctrl+Shift+8 已被其他应用占用；仍可点击聊天窗口中的截图按钮。'
      })
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', () => {
  ai.stopAll()
  speech.stopAll()
  browser.destroy()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
