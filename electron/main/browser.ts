import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Session } from 'electron'
import { app, BrowserWindow, shell, WebContentsView } from 'electron'

import type {
  BrowserHistoryEntry,
  FileReadResult,
  ResearchBrowserBounds,
  ResearchBrowserExtractMode,
  ResearchBrowserExtractResult,
  ResearchBrowserState,
  ResearchBrowserTabState,
  WebSelectionCandidate
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { ProjectService, type ProjectWriteScope } from './project'
import { atomicWriteJson, readJson } from './storage'
import {
  buildWebClipMarkdown,
  normalizeBrowserInput,
  safeCaptureFileBase,
  shouldUseSystemBrowser,
  validatedHttpUrl
} from './web-clip'
import {
  PAGE_CAPTURE_SCRIPT,
  PAGE_PRINT_BUDGET_SCRIPT,
  parseSelectionConsoleMessage,
  selectionWatchScript
} from './web-page-capture'

// A `persist:` partition keeps cookies, localStorage and login state on disk
// under userData so research sessions survive a restart. Every tab shares this
// one session, so signing in once applies across tabs.
const BROWSER_PARTITION = 'persist:coscribe-research-browser'
const CAPTURE_WORLD_ID = 13_337
const MAX_CAPTURE_CHARS = 200_000
const MAX_WEB_ARCHIVE_BYTES = 256 * 1024 * 1024
export const MAX_BROWSER_TABS = 10
const EXTERNAL_LAUNCH_LIMIT = 4
const EXTERNAL_LAUNCH_WINDOW_MS = 10_000
const MAX_HISTORY_ENTRIES = 500
const MAX_SELECTION_CANDIDATE_CHARS = 20_000

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

function emptyTabState(id: string): ResearchBrowserTabState {
  return {
    id,
    url: '',
    title: '新资料页',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    secure: false
  }
}

interface BrowserTab {
  id: string
  view: WebContentsView | null
  state: ResearchBrowserTabState
  pageRevision: number
  selectionNonce: string
}

function safeExternalUrl(value: string): string | null {
  try {
    return validatedHttpUrl(value).toString()
  } catch {
    return null
  }
}

function sanitizedHistoryEntry(value: unknown): BrowserHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<BrowserHistoryEntry>
  const url = typeof entry.url === 'string' ? safeExternalUrl(entry.url) : null
  if (!url || typeof entry.visitedAt !== 'number' || !Number.isFinite(entry.visitedAt)) return null
  return {
    url,
    title: boundedString(entry.title, 500) || new URL(url).hostname,
    visitedAt: entry.visitedAt
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
  private tabs: BrowserTab[] = []
  private activeTabId: string | null = null
  private parentWindow: BrowserWindow | null = null
  private browserSession: Session | null = null
  private bounds: ResearchBrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private externalLaunches: number[] = []
  private history: BrowserHistoryEntry[] = []
  private historyLoaded = false
  private historyLoadPromise: Promise<void> | null = null
  private historyWriteQueue: Promise<void> = Promise.resolve()

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

  private get activeTab(): BrowserTab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null
  }

  private requireActiveTab(): BrowserTab {
    const tab = this.activeTab
    if (!tab) throw new Error('请先打开一个网页。')
    return tab
  }

  private browserState(): ResearchBrowserState {
    const active = this.activeTab
    const page = active?.state ?? emptyTabState('')
    return {
      url: page.url,
      title: page.title,
      loading: page.loading,
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
      secure: page.secure,
      ...(page.error ? { error: page.error } : {}),
      ...(page.notice ? { notice: page.notice } : {}),
      activeTabId: active?.id ?? null,
      tabs: this.tabs.map((tab) => ({ ...tab.state })),
      maxTabs: MAX_BROWSER_TABS
    }
  }

  private emitState(): ResearchBrowserState {
    const state = this.browserState()
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.browserState, state)
    return state
  }

  private mergeTabState(tab: BrowserTab, patch: Partial<ResearchBrowserTabState> = {}): ResearchBrowserState {
    const contents = tab.view?.webContents
    const url = contents && !contents.isDestroyed() ? contents.getURL() : tab.state.url
    let secure = false
    try { secure = new URL(url).protocol === 'https:' } catch { secure = false }
    tab.state = {
      ...tab.state,
      ...(contents && !contents.isDestroyed()
        ? {
            url: url === 'about:blank' ? '' : url,
            title: contents.getTitle() || tab.state.title,
            loading: contents.isLoading(),
            canGoBack: contents.navigationHistory.canGoBack(),
            canGoForward: contents.navigationHistory.canGoForward(),
            secure
          }
        : {}),
      ...patch,
      id: tab.id
    }
    return this.emitState()
  }

  private mergeState(patch: Partial<ResearchBrowserTabState> = {}): ResearchBrowserState {
    const tab = this.activeTab
    return tab ? this.mergeTabState(tab, patch) : this.emitState()
  }

  private historyFilePath(): string {
    return path.join(app.getPath('userData'), 'browser-history.json')
  }

  private async ensureHistoryLoaded(): Promise<void> {
    if (this.historyLoaded) return
    if (!this.historyLoadPromise) {
      this.historyLoadPromise = (async () => {
        const stored = await readJson<BrowserHistoryEntry[]>(this.historyFilePath(), []).catch(() => [])
        if (Array.isArray(stored)) {
          this.history = stored
            .map(sanitizedHistoryEntry)
            .filter((entry): entry is BrowserHistoryEntry => Boolean(entry))
            .slice(0, MAX_HISTORY_ENTRIES)
        }
        this.historyLoaded = true
      })()
    }
    await this.historyLoadPromise
  }

  private persistHistory(): Promise<void> {
    const snapshot = this.history.map((entry) => ({ ...entry }))
    const write = this.historyWriteQueue
      .catch(() => undefined)
      .then(() => atomicWriteJson(this.historyFilePath(), snapshot))
    this.historyWriteQueue = write
    return write
  }

  // Records a visit and lets late title changes update an existing entry
  // without recreating a page immediately after the user clears history.
  private recordHistory(url: string, title: string, create = true): void {
    if (!this.historyLoaded) return
    const safeUrl = safeExternalUrl(url)
    if (!safeUrl) return
    const cleanTitle = boundedString(title, 500) || new URL(safeUrl).hostname
    const existingIndex = this.history.findIndex((entry) => entry.url === safeUrl)
    if (!create) {
      if (existingIndex < 0) return
      this.history[existingIndex] = { ...this.history[existingIndex], title: cleanTitle }
    } else {
      if (existingIndex >= 0) this.history.splice(existingIndex, 1)
      this.history.unshift({ url: safeUrl, title: cleanTitle, visitedAt: Date.now() })
      if (this.history.length > MAX_HISTORY_ENTRIES) {
        this.history.length = MAX_HISTORY_ENTRIES
      }
    }
    void this.persistHistory().catch(() => undefined)
  }

  async listHistory(): Promise<BrowserHistoryEntry[]> {
    await this.ensureHistoryLoaded()
    return this.history.map((entry) => ({ ...entry }))
  }

  async clearHistory(): Promise<BrowserHistoryEntry[]> {
    await this.ensureHistoryLoaded()
    this.history = []
    await this.persistHistory()
    return []
  }

  private emitSelectionCandidate(candidate: WebSelectionCandidate): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.browserSelectionCandidate, candidate)
  }

  private syncViewVisibility(): void {
    for (const tab of this.tabs) {
      if (!tab.view || tab.view.webContents.isDestroyed()) continue
      tab.view.setBounds(this.bounds)
      tab.view.setVisible(this.visible && tab.id === this.activeTabId)
    }
  }

  private async launchExternal(
    value: string,
    options: { successNotice: string; rateLimited?: boolean },
    tab = this.activeTab
  ): Promise<boolean> {
    const target = safeSystemUrl(value)
    if (!target) {
      if (tab) this.mergeTabState(tab, { error: '外部地址无效，已阻止打开。', notice: undefined })
      return false
    }
    if (options.rateLimited !== false) {
      const now = Date.now()
      this.externalLaunches = this.externalLaunches.filter((timestamp) => now - timestamp < EXTERNAL_LAUNCH_WINDOW_MS)
      if (this.externalLaunches.length >= EXTERNAL_LAUNCH_LIMIT) {
        if (tab) this.mergeTabState(tab, { notice: '网页连续请求打开过多外部窗口，后续请求已拦截。', error: undefined })
        return false
      }
      this.externalLaunches.push(now)
    }
    try {
      await shell.openExternal(target)
      if (tab) this.mergeTabState(tab, { notice: options.successNotice, error: undefined })
      return true
    } catch (error) {
      const detail = error instanceof Error ? boundedString(error.message, 300) : ''
      if (tab) {
        this.mergeTabState(tab, {
          error: `无法在系统浏览器中打开外部内容${detail ? `：${detail}` : '。'}`,
          notice: undefined
        })
      }
      return false
    }
  }

  private attachToWindow(): BrowserWindow {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('主窗口尚未准备好。')
    if (this.parentWindow !== window) {
      for (const tab of this.tabs) {
        if (!tab.view || tab.view.webContents.isDestroyed()) continue
        if (this.parentWindow && !this.parentWindow.isDestroyed()) this.parentWindow.contentView.removeChildView(tab.view)
        window.contentView.addChildView(tab.view)
      }
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
        const tab = this.tabs.find((candidate) => candidate.view?.webContents.id === details.webContentsId) ?? this.activeTab
        const directUrl = details.method === 'GET' ? safeExternalUrl(details.url) : null
        const currentPage = tab ? safeExternalUrl(tab.state.url) : null
        const target = directUrl ?? currentPage
        if (target) {
          void this.launchExternal(target, {
            successNotice: directUrl
              ? '媒体或下载地址已在系统浏览器打开。'
              : '该下载不能保留 POST 数据或登录态；已打开当前页面，请在系统浏览器中重新下载。'
          }, tab)
        } else if (tab) {
          this.mergeTabState(tab, { notice: '该下载不能保留 POST 数据、登录态或临时内容。请在系统浏览器中重新打开来源页。' })
        }
        return
      }
      callback({})
    })
  }

  private ensureView(tab = this.requireActiveTab()): WebContentsView {
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      this.attachToWindow()
      return tab.view
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
    tab.view = view
    this.parentWindow = window
    view.setBackgroundColor('#ffffff')
    view.setBounds(this.bounds)
    view.setVisible(this.visible && tab.id === this.activeTabId)
    window.contentView.addChildView(view)
    this.configureSession(view.webContents.session)

    const contents = view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      const external = safeExternalUrl(url)
      if (external) {
        void this.newTab(external).catch((error: unknown) => {
          this.mergeTabState(tab, {
            notice: error instanceof Error ? error.message : '无法打开新的浏览器标签页。'
          })
        })
      } else {
        const systemTarget = safeSystemUrl(url)
        if (systemTarget) void this.launchExternal(systemTarget, { successNotice: '外部协议已交给系统应用。' }, tab)
        else this.mergeTabState(tab, { notice: '已拦截不受信任的弹出页面。' })
      }
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        tab.pageRevision += 1
        tab.selectionNonce = randomUUID()
      }
    })
    contents.on('will-navigate', (event, url) => {
      const target = safeExternalUrl(url)
      if (!target) {
        event.preventDefault()
        const systemTarget = safeSystemUrl(url)
        if (systemTarget) void this.launchExternal(systemTarget, { successNotice: '外部协议已交给系统应用。' }, tab)
        else this.mergeTabState(tab, { error: '已阻止非 HTTP(S) 导航。' })
        return
      }
      if (shouldUseSystemBrowser(target)) {
        event.preventDefault()
        void this.launchExternal(target, { successNotice: '视频或媒体页面已在系统浏览器打开。' }, tab)
      }
    })
    contents.on('will-redirect', (event, url) => {
      const target = safeExternalUrl(url)
      if (!target || shouldUseSystemBrowser(target)) {
        event.preventDefault()
        const systemTarget = target ?? safeSystemUrl(url)
        if (systemTarget) void this.launchExternal(systemTarget, { successNotice: '外部内容已交给系统应用。' }, tab)
        else this.mergeTabState(tab, { error: '已阻止不安全的重定向。' })
      }
    })
    contents.on('did-start-loading', () => this.mergeTabState(tab, { error: undefined, notice: undefined }))
    contents.on('did-stop-loading', () => this.mergeTabState(tab))
    contents.on('did-navigate', (_event, url) => {
      this.mergeTabState(tab, { error: undefined })
      this.recordHistory(url, contents.isDestroyed() ? '' : contents.getTitle())
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      this.mergeTabState(tab)
      if (isMainFrame) this.recordHistory(url, contents.isDestroyed() ? '' : contents.getTitle())
    })
    contents.on('page-title-updated', (_event, title) => {
      this.mergeTabState(tab, { title: boundedString(title, 500) || '网页资料' })
      if (!contents.isDestroyed()) this.recordHistory(contents.getURL(), title, false)
    })
    // Re-inject after each document loads: the isolated world is reset on
    // navigation, and the watcher self-guards against duplicate listeners.
    contents.on('dom-ready', () => {
      void contents.executeJavaScriptInIsolatedWorld(
        CAPTURE_WORLD_ID,
        [{ code: selectionWatchScript(tab.selectionNonce) }]
      ).catch(() => undefined)
    })
    contents.on('console-message', (details) => {
      const message = typeof details === 'object' && details && 'message' in details
        ? String((details as { message?: unknown }).message ?? '')
        : ''
      const text = parseSelectionConsoleMessage(message, tab.selectionNonce, MAX_SELECTION_CANDIDATE_CHARS)
      if (!text || this.activeTab !== tab || contents.isDestroyed()) return
      const url = safeExternalUrl(contents.getURL())
      if (!url) return
      this.emitSelectionCandidate({ text, title: tab.state.title || (url ? new URL(url).hostname : '网页资料'), url })
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.mergeTabState(tab, {
        url: safeExternalUrl(validatedURL) ?? tab.state.url,
        error: `网页加载失败：${boundedString(errorDescription, 500) || errorCode}`
      })
    })
    contents.on('render-process-gone', (_event, details) => {
      this.mergeTabState(tab, { loading: false, error: `网页进程已停止：${details.reason}` })
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
    await this.ensureHistoryLoaded()
    if (!this.activeTab) return this.newTab(url)
    if (url?.trim()) return this.navigate(url)
    this.attachToWindow()
    this.syncViewVisibility()
    return this.mergeState()
  }

  async newTab(url?: string): Promise<ResearchBrowserState> {
    await this.ensureHistoryLoaded()
    if (this.tabs.length >= MAX_BROWSER_TABS) {
      throw new Error(`最多同时打开 ${MAX_BROWSER_TABS} 个网页标签。`)
    }
    const id = randomUUID()
    const tab: BrowserTab = {
      id,
      view: null,
      state: emptyTabState(id),
      pageRevision: 0,
      selectionNonce: randomUUID()
    }
    this.tabs.push(tab)
    this.activeTabId = id
    this.visible = true
    this.syncViewVisibility()
    this.emitState()
    return url?.trim() ? this.navigate(url) : this.browserState()
  }

  activateTab(tabId: string): ResearchBrowserState {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new Error('浏览器标签页不存在或已经关闭。')
    this.activeTabId = tab.id
    if (this.visible) this.attachToWindow()
    this.syncViewVisibility()
    return this.mergeTabState(tab)
  }

  closeTab(tabId: string): ResearchBrowserState {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return this.emitState()
    const [tab] = this.tabs.splice(index, 1)
    tab.pageRevision += 1
    if (tab.view) {
      if (this.parentWindow && !this.parentWindow.isDestroyed()) this.parentWindow.contentView.removeChildView(tab.view)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    }
    this.syncViewVisibility()
    return this.emitState()
  }

  async navigate(input: string): Promise<ResearchBrowserState> {
    await this.ensureHistoryLoaded()
    if (!this.activeTab) return this.newTab(input)
    const tab = this.requireActiveTab()
    const target = normalizeBrowserInput(input)
    if (shouldUseSystemBrowser(target)) {
      const opened = await this.launchExternal(target, {
        successNotice: '视频或媒体页面已在系统浏览器打开。',
        rateLimited: false
      }, tab)
      if (!opened) throw new Error(tab.state.error || '无法打开系统浏览器。')
      return this.mergeTabState(tab)
    }
    this.visible = true
    const view = this.ensureView(tab)
    view.setBounds(this.bounds)
    view.setVisible(true)
    await view.webContents.loadURL(target, { userAgent: view.webContents.getUserAgent() })
    return this.mergeTabState(tab, { error: undefined, notice: undefined })
  }

  back(): ResearchBrowserState {
    const contents = this.activeTab?.view?.webContents
    if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    return this.mergeState()
  }

  forward(): ResearchBrowserState {
    const contents = this.activeTab?.view?.webContents
    if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    return this.mergeState()
  }

  reload(): ResearchBrowserState {
    const tab = this.activeTab
    const contents = tab?.view?.webContents
    if (contents && !contents.isDestroyed() && tab?.state.url) contents.reload()
    return this.mergeState()
  }

  stop(): ResearchBrowserState {
    const contents = this.activeTab?.view?.webContents
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
    this.syncViewVisibility()
  }

  setVisible(visible: boolean): void {
    this.visible = Boolean(visible)
    if (visible) this.attachToWindow()
    this.syncViewVisibility()
  }

  async extract(mode: ResearchBrowserExtractMode): Promise<ResearchBrowserExtractResult> {
    if (mode !== 'selection' && mode !== 'article') throw new Error('不支持的网页提取模式。')
    const tab = this.requireActiveTab()
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed() || !tab.state.url) throw new Error('请先打开一个网页。')
    const raw = await contents.executeJavaScriptInIsolatedWorld(
      CAPTURE_WORLD_ID,
      [{ code: PAGE_CAPTURE_SCRIPT }]
    ) as RawPageCapture
    this.mergeTabState(tab)
    const title = boundedString(raw?.title, 500) || new URL(tab.state.url).hostname
    const url = validatedHttpUrl(boundedString(raw?.url, 8_000) || tab.state.url).toString()
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
    tab: BrowserTab,
    contents: Electron.WebContents,
    pageRevision: number,
    projectScope: ProjectWriteScope
  ): void {
    if (
      this.activeTab !== tab ||
      tab.view?.webContents !== contents ||
      contents.isDestroyed() ||
      pageRevision !== tab.pageRevision
    ) {
      throw new Error('网页已关闭或发生导航，本次保存已取消。')
    }
    const currentScope = this.project.captureWriteScope()
    if (currentScope.revision !== projectScope.revision || currentScope.root !== projectScope.root) {
      throw new Error('项目已切换，本次网页保存已取消。')
    }
  }

  async saveArchive(): Promise<FileReadResult> {
    const tab = this.requireActiveTab()
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed() || !tab.state.url) throw new Error('请先打开一个网页。')
    if (contents.isLoading()) throw new Error('网页仍在加载，请等待完成后再保存完整归档。')
    const pageRevision = tab.pageRevision
    const projectScope = this.project.captureWriteScope()
    const title = contents.getTitle() || new URL(tab.state.url).hostname

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'coscribe-web-archive-'))
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.mhtml`)
    try {
      await contents.savePage(temporaryPath, 'MHTML')
      const archiveInfo = await stat(temporaryPath)
      if (!archiveInfo.isFile() || archiveInfo.size < 64 || archiveInfo.size > MAX_WEB_ARCHIVE_BYTES) {
        throw new Error('完整网页归档为空或超过 256 MB 限制。')
      }
      const archive = await readFile(temporaryPath)
      this.assertSaveStillCurrent(tab, contents, pageRevision, projectScope)
      const result = await this.createUnique(title, '.mhtml', (target) => this.project.createWebArchive(target, archive, projectScope))
      this.mergeTabState(tab, { notice: `已保存完整网页归档：${result.path}` })
      return result
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async saveMarkdown(): Promise<FileReadResult> {
    const tab = this.requireActiveTab()
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed() || !tab.state.url) throw new Error('请先打开一个网页。')
    const pageRevision = tab.pageRevision
    const projectScope = this.project.captureWriteScope()
    const capture = await this.extract('article')
    this.assertSaveStillCurrent(tab, contents, pageRevision, projectScope)
    const markdown = buildWebClipMarkdown({ ...capture, capturedAt: new Date() })
    const result = await this.createUnique(capture.title, '.md', (target) => this.project.createMarkdown(target, markdown, projectScope))
    this.mergeTabState(tab, { notice: `已保存 Markdown：${result.path}` })
    return result
  }

  async savePdf(): Promise<FileReadResult> {
    const tab = this.requireActiveTab()
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed() || !tab.state.url) throw new Error('请先打开一个网页。')
    const pageRevision = tab.pageRevision
    const projectScope = this.project.captureWriteScope()
    const title = contents.getTitle() || new URL(tab.state.url).hostname
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
    this.assertSaveStillCurrent(tab, contents, pageRevision, projectScope)
    const result = await this.createUnique(title, '.pdf', (target) => this.project.createWebPdf(target, data, projectScope))
    this.mergeTabState(tab, { notice: `已保存 PDF：${result.path}` })
    return result
  }

  async openExternal(input?: string): Promise<void> {
    const tab = this.requireActiveTab()
    const target = validatedHttpUrl(input?.trim() || tab.state.url).toString()
    const opened = await this.launchExternal(target, {
      successNotice: '当前网页已在系统浏览器打开。',
      rateLimited: false
    }, tab)
    if (!opened) throw new Error(tab.state.error || '无法打开系统浏览器。')
  }

  close(): void {
    for (const tab of this.tabs) {
      tab.pageRevision += 1
      if (!tab.view) continue
      if (this.parentWindow && !this.parentWindow.isDestroyed()) this.parentWindow.contentView.removeChildView(tab.view)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.browserSession?.removeListener('will-download', this.handleDownload)
    this.browserSession?.webRequest.onHeadersReceived(null)
    this.browserSession = null
    this.tabs = []
    this.activeTabId = null
    this.parentWindow = null
    this.visible = false
    this.externalLaunches = []
    this.emitState()
  }

  detachWindow(window: BrowserWindow): void {
    if (this.parentWindow !== window) return
    this.close()
  }

  destroy(): void {
    this.close()
  }
}
