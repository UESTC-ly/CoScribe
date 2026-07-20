import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { app, BrowserWindow, net, protocol, shell } from 'electron'

import { IPC } from '../ipc-channels'
import { AiService } from './ai'
import { registerIpc } from './ipc'
import { PdfTextService } from './pdf'
import { ProjectService } from './project'
import { ProjectSearchService } from './search'
import { SettingsStore } from './settings'

protocol.registerSchemesAsPrivileged([
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
let mainWindow: BrowserWindow | null = null

function allowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

const settings = new SettingsStore()
let pdf: PdfTextService
const project = new ProjectService(
  settings,
  (events) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.projectFilesChanged, events)
  },
  (filePath) => pdf?.invalidate(filePath)
)
pdf = new PdfTextService(() => project.guard)
const search = new ProjectSearchService(project, pdf)
const ai = new AiService(settings, project, pdf, search)

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
        currentUrl.protocol === 'file:' && nextUrl.protocol === 'file:' && currentUrl.pathname === nextUrl.pathname
      if (sameHttpOrigin || samePackagedPage) return
    } catch {
      // Invalid navigation is denied below.
    }
    event.preventDefault()
    if (allowedExternalUrl(url)) void shell.openExternal(url)
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadFile(path.join(currentDirectory, '../renderer/index.html'))
  return window
}

app.on('second-instance', (_event, argv) => {
  const candidate = directoryArgument(argv.slice(1))
  if (candidate) {
    void project
      .openPath(candidate)
      .then(() => mainWindow?.webContents.reload())
      .catch(() => undefined)
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
    void project
      .openPath(filePath)
      .then(() => mainWindow?.webContents.reload())
      .catch(() => undefined)
  } else {
    project.setInitialPath(filePath)
  }
})

void app.whenReady().then(() => {
  app.setAppUserModelId('com.coscribe.app')
  registerIpc({ project, pdf, search, settings, ai })
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', () => {
  ai.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
