import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Session } from 'electron'
import { BrowserWindow, shell, WebContentsView } from 'electron'

import type {
  FileReadResult,
  ResearchBrowserBounds,
  ResearchBrowserExtractMode,
  ResearchBrowserExtractResult,
  ResearchBrowserState
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { ProjectService, type ProjectWriteScope } from './project'
import {
  buildWebClipMarkdown,
  normalizeBrowserInput,
  safeCaptureFileBase,
  shouldUseSystemBrowser,
  validatedHttpUrl
} from './web-clip'
import { PAGE_CAPTURE_SCRIPT, PAGE_PRINT_BUDGET_SCRIPT } from './web-page-capture'

const BROWSER_PARTITION = 'coscribe-research-browser'
const CAPTURE_WORLD_ID = 13_337
const MAX_CAPTURE_CHARS = 200_000
const MAX_WEB_ARCHIVE_BYTES = 256 * 1024 * 1024
const EXTERNAL_LAUNCH_LIMIT = 4
const EXTERNAL_LAUNCH_WINDOW_MS = 10_000

interface RawPageCapture {
  title?: unknown
  url?: unknown
  selection?: unknown
  text?: unknown
  markdown?: unknown
}

function boundedString(value: unknown, maximum = MAX_CAPTURE_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function emptyState(): ResearchBrowserState {
  return {
    url: '',
    title: '新资料页',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    secure: false
  }
}

function safeExternalUrl(value: string): string | null {
  try {
    return validatedHttpUrl(value).toString()
  } catch {
    return null
  }
}

function safeSystemUrl(value: string): string | null {
  const http = safeExternalUrl(value)
  if (http) return http
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'mailto:' || value.length > 8_000 || /[\r\n]|%0[ad]/iu.test(value)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export class ResearchBrowserService {
  private view: WebContentsView | null = null
  private parentWindow: BrowserWindow | null = null
  private browserSession: Session | null = null
  private bounds: ResearchBrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private stateValue = emptyState()
  private externalLaunches: number[] = []
  private pageRevision = 0

  private readonly handleDownload = (event: Electron.Event, item: Electron.DownloadItem): void => {
    event.preventDefault()
    item.cancel()
    const url = safeExternalUrl(item.getURL())
    if (url) {
      void this.launchExternal(url, {
        successNotice: '已在系统浏览器打开下载地址；若下载依赖登录态，请在系统浏览器打开当前页面后重试。'
      })
      return
    }
    this.mergeState({ notice: '此下载使用登录态或临时 blob 数据。请在系统浏览器打开当前页面并重新下载。' })
  }

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly project: ProjectService
  ) {}

  private async launchExternal(
    value: string,
    options: { successNotice: string; rateLimited?: boolean }
  ): Promise<boolean> {
    const target = safeSystemUrl(value)
    if (!target) {
      this.mergeState({ error: '外部地址无效，已阻止打开。', notice: undefined })
      return false
    }
    if (options.rateLimited !== false) {
      const now = Date.now()
      this.externalLaunches = this.externalLaunches.filter((timestamp) => now - timestamp < EXTERNAL_LAUNCH_WINDOW_MS)
      if (this.externalLaunches.length >= EXTERNAL_LAUNCH_LIMIT) {
        this.mergeState({ notice: '网页连续请求打开过多外部窗口，后续请求已拦截。', error: undefined })
        return false
      }
      this.externalLaunches.push(now)
    }
    try {
      await shell.openExternal(target)
      this.mergeState({ notice: options.successNotice, error: undefined })
      return true
    } catch (error) {
      const detail = error instanceof Error ? boundedString(error.message, 300) : ''
      this.mergeState({
        error: `无法在系统浏览器中打开外部内容${detail ? `：${detail}` : '。'}`,
        notice: undefined
      })
      return false
    }
  }

  private mergeState(patch: Partial<ResearchBrowserState> = {}): ResearchBrowserState {
    const contents = this.view?.webContents
    const url = contents && !contents.isDestroyed() ? contents.getURL() : this.stateValue.url
    let secure = false
    try { secure = new URL(url).protocol === 'https:' } catch { secure = false }
    this.stateValue = {
      ...this.stateValue,
      ...(contents && !contents.isDestroyed()
        ? {
            url: url === 'about:blank' ? '' : url,
            title: contents.getTitle() || this.stateValue.title,
            loading: contents.isLoading(),
            canGoBack: contents.navigationHistory.canGoBack(),
            canGoForward: contents.navigationHistory.canGoForward(),
            secure
          }
        : {}),
      ...patch
    }
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.browserState, { ...this.stateValue })
    return { ...this.stateValue }
  }

  private attachToWindow(): BrowserWindow {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('主窗口尚未准备好。')
    if (this.view && this.parentWindow !== window) {
      if (this.parentWindow && !this.parentWindow.isDestroyed()) this.parentWindow.contentView.removeChildView(this.view)
      window.contentView.addChildView(this.view)
      this.parentWindow = window
    }
    return window
  }

  private configureSession(browserSession: Session): void {
    if (this.browserSession === browserSession) return
    this.browserSession?.removeListener('will-download', this.handleDownload)
    this.browserSession = browserSession
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    browserSession.on('will-download', this.handleDownload)
    browserSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const headers = details.responseHeaders ?? {}
      const contentType = Object.entries(headers).find(([name]) => name.toLocaleLowerCase() === 'content-type')?.[1]?.[0] ?? ''
      const disposition = Object.entries(headers).find(([name]) => name.toLocaleLowerCase() === 'content-disposition')?.[1]?.[0] ?? ''
      const externalOnly = details.resourceType === 'mainFrame' && (/^(?:video|audio)\//iu.test(contentType) || /\battachment\b/iu.test(disposition))
      if (externalOnly) {
        callback({ cancel: true })
        const directUrl = details.method === 'GET' ? safeExternalUrl(details.url) : null
        const currentPage = safeExternalUrl(this.stateValue.url)
        const target = directUrl ?? currentPage
        if (target) {
          void this.launchExternal(target, {
            successNotice: directUrl
              ? '媒体或下载地址已在系统浏览器打开。'
              : '该下载不能保留 POST 数据或登录态；已打开当前页面，请在系统浏览器中重新下载。'
          })
        } else {
          this.mergeState({ notice: '该下载不能保留 POST 数据、登录态或临时内容。请在系统浏览器中重新打开来源页。' })
        }
        return
      }
      callback({})
    })
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.attachToWindow()
      return this.view
    }

    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('主窗口尚未准备好。')
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableDialogs: true,
        safeDialogs: true,
        spellcheck: true,
        autoplayPolicy: 'document-user-activation-required'
      }
    })
    this.view = view
    this.parentWindow = window
    view.setBackgroundColor('#ffffff')
    view.setBounds(this.bounds)
    view.setVisible(this.visible)
    window.contentView.addChildView(view)
    this.configureSession(view.webContents.session)

    const contents = view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      const external = safeSystemUrl(url)
      if (external) void this.launchExternal(external, { successNotice: '弹出页面已在系统浏览器打开。' })
      else this.mergeState({ notice: '已拦截不受信任的弹出页面。' })
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.pageRevision += 1
    })
    contents.on('will-navigate', (event, url) => {
      const target = safeExternalUrl(url)
      if (!target) {
        event.preventDefault()
        const systemTarget = safeSystemUrl(url)
        if (systemTarget) void this.launchExternal(systemTarget, { successNotice: '外部协议已交给系统应用。' })
        else this.mergeState({ error: '已阻止非 HTTP(S) 导航。' })
        return
      }
      if (shouldUseSystemBrowser(target)) {
        event.preventDefault()
        void this.launchExternal(target, { successNotice: '视频或媒体页面已在系统浏览器打开。' })
      }
    })
    contents.on('will-redirect', (event, url) => {
      const target = safeExternalUrl(url)
      if (!target || shouldUseSystemBrowser(target)) {
        event.preventDefault()
        const systemTarget = target ?? safeSystemUrl(url)
        if (systemTarget) void this.launchExternal(systemTarget, { successNotice: '外部内容已交给系统应用。' })
        else this.mergeState({ error: '已阻止不安全的重定向。' })
      }
    })
    contents.on('did-start-loading', () => this.mergeState({ error: undefined, notice: undefined }))
    contents.on('did-stop-loading', () => this.mergeState())
    contents.on('did-navigate', () => this.mergeState({ error: undefined }))
    contents.on('did-navigate-in-page', () => this.mergeState())
    contents.on('page-title-updated', (_event, title) => this.mergeState({ title: boundedString(title, 500) || '网页资料' }))
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.mergeState({
        url: safeExternalUrl(validatedURL) ?? this.stateValue.url,
        error: `网页加载失败：${boundedString(errorDescription, 500) || errorCode}`
      })
    })
    contents.on('render-process-gone', (_event, details) => {
      this.mergeState({ loading: false, error: `网页进程已停止：${details.reason}` })
    })
    contents.on('before-input-event', (event, input) => {
      if (!input.shift || !(input.meta || input.control) || input.key.toLocaleLowerCase() !== 'k') return
      event.preventDefault()
      void this.extract('selection').then(
        (result) => {
          const mainWindow = this.getWindow()
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserSelection, { type: 'captured', result })
        },
        (error: unknown) => {
          const mainWindow = this.getWindow()
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.browserSelection, {
            type: 'error',
            message: error instanceof Error ? error.message : '无法读取网页选区。'
          })
        }
      )
    })
    return view
  }

  state(): ResearchBrowserState {
    return this.mergeState()
  }

  async open(url?: string): Promise<ResearchBrowserState> {
    this.visible = true
    if (url?.trim()) return this.navigate(url)
    if (this.view) {
      this.attachToWindow()
      this.view.setBounds(this.bounds)
      this.view.setVisible(true)
    }
    return this.mergeState()
  }

  async navigate(input: string): Promise<ResearchBrowserState> {
    const target = normalizeBrowserInput(input)
    if (shouldUseSystemBrowser(target)) {
      const opened = await this.launchExternal(target, {
        successNotice: '视频或媒体页面已在系统浏览器打开。',
        rateLimited: false
      })
      if (!opened) throw new Error(this.stateValue.error || '无法打开系统浏览器。')
      return this.mergeState()
    }
    this.visible = true
    const view = this.ensureView()
    view.setBounds(this.bounds)
    view.setVisible(true)
    await view.webContents.loadURL(target, { userAgent: view.webContents.getUserAgent() })
    return this.mergeState({ error: undefined, notice: undefined })
  }

  back(): ResearchBrowserState {
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    return this.mergeState()
  }

  forward(): ResearchBrowserState {
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    return this.mergeState()
  }

  reload(): ResearchBrowserState {
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed() && this.stateValue.url) contents.reload()
    return this.mergeState()
  }

  stop(): ResearchBrowserState {
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed()) contents.stop()
    return this.mergeState({ loading: false })
  }

  setBounds(input: ResearchBrowserBounds): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    const content = window.getContentBounds()
    const x = Math.max(0, Math.min(content.width, Math.round(Number(input.x) || 0)))
    const y = Math.max(0, Math.min(content.height, Math.round(Number(input.y) || 0)))
    const width = Math.max(0, Math.min(content.width - x, Math.round(Number(input.width) || 0)))
    const height = Math.max(0, Math.min(content.height - y, Math.round(Number(input.height) || 0)))
    this.bounds = { x, y, width, height }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setBounds(this.bounds)
  }

  setVisible(visible: boolean): void {
    this.visible = Boolean(visible)
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (visible) this.attachToWindow()
    this.view.setVisible(this.visible)
  }

  async extract(mode: ResearchBrowserExtractMode): Promise<ResearchBrowserExtractResult> {
    if (mode !== 'selection' && mode !== 'article') throw new Error('不支持的网页提取模式。')
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !this.stateValue.url) throw new Error('请先打开一个网页。')
    const raw = await contents.executeJavaScriptInIsolatedWorld(
      CAPTURE_WORLD_ID,
      [{ code: PAGE_CAPTURE_SCRIPT }]
    ) as RawPageCapture
    this.mergeState()
    const title = boundedString(raw?.title, 500) || new URL(this.stateValue.url).hostname
    const url = validatedHttpUrl(boundedString(raw?.url, 8_000) || this.stateValue.url).toString()
    const selection = boundedString(raw?.selection)
    const articleText = boundedString(raw?.text)
    const text = mode === 'selection' ? selection : articleText
    if (!text) throw new Error(mode === 'selection' ? '请先在网页中选中文字。' : '当前网页没有可提取的正文。')
    return {
      mode,
      title,
      url,
      text,
      markdown: mode === 'selection' ? text : boundedString(raw?.markdown) || articleText
    }
  }

  private async createUnique(
    title: string,
    extension: '.md' | '.mhtml' | '.pdf',
    create: (path: string) => Promise<FileReadResult>
  ): Promise<FileReadResult> {
    const base = safeCaptureFileBase(title)
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? '' : ` ${index + 1}`
      const target = `资料剪藏/${base}${suffix}${extension}`
      try {
        return await create(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !/目标已存在/u.test(String(error))) throw error
      }
    }
    throw new Error('同名网页剪藏过多，请先整理资料剪藏文件夹。')
  }

  private assertSaveStillCurrent(
    contents: Electron.WebContents,
    pageRevision: number,
    projectScope: ProjectWriteScope
  ): void {
    if (
      this.view?.webContents !== contents ||
      contents.isDestroyed() ||
      pageRevision !== this.pageRevision
    ) {
      throw new Error('网页已关闭或发生导航，本次保存已取消。')
    }
    const currentScope = this.project.captureWriteScope()
    if (currentScope.revision !== projectScope.revision || currentScope.root !== projectScope.root) {
      throw new Error('项目已切换，本次网页保存已取消。')
    }
  }

  async saveArchive(): Promise<FileReadResult> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !this.stateValue.url) throw new Error('请先打开一个网页。')
    if (contents.isLoading()) throw new Error('网页仍在加载，请等待完成后再保存完整归档。')
    const pageRevision = this.pageRevision
    const projectScope = this.project.captureWriteScope()
    const title = contents.getTitle() || new URL(this.stateValue.url).hostname

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'coscribe-web-archive-'))
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.mhtml`)
    try {
      await contents.savePage(temporaryPath, 'MHTML')
      const archiveInfo = await stat(temporaryPath)
      if (!archiveInfo.isFile() || archiveInfo.size < 64 || archiveInfo.size > MAX_WEB_ARCHIVE_BYTES) {
        throw new Error('完整网页归档为空或超过 256 MB 限制。')
      }
      const archive = await readFile(temporaryPath)
      this.assertSaveStillCurrent(contents, pageRevision, projectScope)
      const result = await this.createUnique(title, '.mhtml', (target) => this.project.createWebArchive(target, archive, projectScope))
      this.mergeState({ notice: `已保存完整网页归档：${result.path}` })
      return result
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async saveMarkdown(): Promise<FileReadResult> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !this.stateValue.url) throw new Error('请先打开一个网页。')
    const pageRevision = this.pageRevision
    const projectScope = this.project.captureWriteScope()
    const capture = await this.extract('article')
    this.assertSaveStillCurrent(contents, pageRevision, projectScope)
    const markdown = buildWebClipMarkdown({ ...capture, capturedAt: new Date() })
    const result = await this.createUnique(capture.title, '.md', (target) => this.project.createMarkdown(target, markdown, projectScope))
    this.mergeState({ notice: `已保存 Markdown：${result.path}` })
    return result
  }

  async savePdf(): Promise<FileReadResult> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !this.stateValue.url) throw new Error('请先打开一个网页。')
    const pageRevision = this.pageRevision
    const projectScope = this.project.captureWriteScope()
    const title = contents.getTitle() || new URL(this.stateValue.url).hostname
    const rawMetrics = await contents.executeJavaScriptInIsolatedWorld(
      CAPTURE_WORLD_ID,
      [{ code: PAGE_PRINT_BUDGET_SCRIPT }]
    ) as { nodes?: unknown; width?: unknown; height?: unknown }
    const nodes = Number(rawMetrics?.nodes)
    const width = Number(rawMetrics?.width)
    const height = Number(rawMetrics?.height)
    if (
      !Number.isFinite(nodes) || !Number.isFinite(width) || !Number.isFinite(height) ||
      nodes > 50_000 || width > 50_000 || height > 1_000_000 || width * height > 10_000_000_000
    ) {
      throw new Error('网页打印尺寸或结构异常，已停止生成 PDF；请改用完整 MHTML 归档。')
    }
    const data = await contents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      generateDocumentOutline: true
    })
    this.assertSaveStillCurrent(contents, pageRevision, projectScope)
    const result = await this.createUnique(title, '.pdf', (target) => this.project.createWebPdf(target, data, projectScope))
    this.mergeState({ notice: `已保存 PDF：${result.path}` })
    return result
  }

  async openExternal(input?: string): Promise<void> {
    const target = validatedHttpUrl(input?.trim() || this.stateValue.url).toString()
    const opened = await this.launchExternal(target, {
      successNotice: '当前网页已在系统浏览器打开。',
      rateLimited: false
    })
    if (!opened) throw new Error(this.stateValue.error || '无法打开系统浏览器。')
  }

  close(): void {
    this.pageRevision += 1
    const view = this.view
    if (view) {
      if (this.parentWindow && !this.parentWindow.isDestroyed()) this.parentWindow.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    }
    this.browserSession?.removeListener('will-download', this.handleDownload)
    this.browserSession?.webRequest.onHeadersReceived(null)
    this.browserSession = null
    this.view = null
    this.parentWindow = null
    this.visible = false
    this.externalLaunches = []
    this.stateValue = emptyState()
    this.mergeState()
  }

  detachWindow(window: BrowserWindow): void {
    if (this.parentWindow !== window) return
    this.close()
  }

  destroy(): void {
    this.close()
  }
}
