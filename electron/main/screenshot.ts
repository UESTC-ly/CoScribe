import {
  BrowserWindow,
  desktopCapturer,
  screen,
  shell,
  systemPreferences,
  type Display,
  type NativeImage
} from 'electron'

import { MAX_CHAT_IMAGE_BYTES } from '../../src/shared/chat-images'
import type { ChatImageAttachment } from '../../src/shared/types'
import { screenshotCropBoundsFromOverlay, type ScreenshotRegion } from './screenshot-region'

const CAPTURE_RETRY_DELAYS_MS = [0, 140, 320] as const
const MAC_SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const MIN_SELECTION_SIZE = 8
const SELECTION_TIMEOUT_MS = 5 * 60 * 1_000

interface ScreenshotSelection extends ScreenshotRegion {
  viewportWidth: number
  viewportHeight: number
}

interface ScreenshotSelectionSession {
  selection: ScreenshotSelection
  contentBounds: ScreenshotRegion
  close: () => void
}

class ScreenshotPermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenshotPermissionError'
  }
}

const SELECTION_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; cursor: crosshair; user-select: none; -webkit-app-region: no-drag; }
    body { background: transparent; }
    #selection { position: fixed; display: none; border: 2px solid rgba(255, 255, 255, 0.98); background: rgba(255, 255, 255, 0.025); box-shadow: 0 0 0 100vmax rgba(8, 10, 14, 0.32); pointer-events: none; }
    #selection.active { display: block; }
    #size { position: absolute; left: 6px; top: 6px; padding: 3px 6px; color: white; background: rgba(20, 22, 27, 0.82); border-radius: 4px; font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; white-space: nowrap; }
  </style>
</head>
<body>
  <div id="selection"><span id="size"></span></div>
</body>
</html>`

function selectionScript(): string {
  return `(() => new Promise((resolve) => {
  const box = document.getElementById('selection')
  const size = document.getElementById('size')
  let start = null
  let current = null
  let dragging = false
  let settled = false

  const clamp = (value, maximum) => Math.min(maximum, Math.max(0, value))
  const cleanup = () => {
    window.removeEventListener('pointerdown', pointerDown, true)
    window.removeEventListener('pointermove', pointerMove, true)
    window.removeEventListener('pointerup', pointerUp, true)
    window.removeEventListener('pointercancel', pointerCancel, true)
    window.removeEventListener('keydown', keyDown, true)
    window.removeEventListener('blur', cancel, true)
    window.removeEventListener('contextmenu', preventMenu, true)
  }
  const finish = (value) => {
    if (settled) return
    settled = true
    cleanup()
    box.classList.remove('active')
    size.textContent = ''
    resolve(value)
  }
  const renderRegion = (region) => {
    if (!region) {
      box.classList.remove('active')
      return
    }
    current = region
    box.style.left = region.x + 'px'
    box.style.top = region.y + 'px'
    box.style.width = region.width + 'px'
    box.style.height = region.height + 'px'
    size.textContent = Math.round(region.width) + ' × ' + Math.round(region.height) + ' · 松开确认'
    box.classList.add('active')
  }
  const renderDrag = (clientX, clientY) => {
    if (!start) return
    const endX = clamp(clientX, window.innerWidth)
    const endY = clamp(clientY, window.innerHeight)
    const x = Math.min(start.x, endX)
    const y = Math.min(start.y, endY)
    const width = Math.abs(endX - start.x)
    const height = Math.abs(endY - start.y)
    renderRegion({ x, y, width, height })
  }
  const reset = () => {
    start = null
    current = null
    dragging = false
    box.classList.remove('active')
  }
  function pointerDown(event) {
    if (event.button !== 0) return
    event.preventDefault()
    start = {
      x: clamp(event.clientX, window.innerWidth),
      y: clamp(event.clientY, window.innerHeight),
      pointerId: event.pointerId
    }
    dragging = false
    try { document.body.setPointerCapture?.(event.pointerId) } catch {}
    renderRegion({ x: start.x, y: start.y, width: 0, height: 0 })
  }
  function pointerMove(event) {
    if (!start || event.pointerId !== start.pointerId) return
    event.preventDefault()
    if (Math.abs(event.clientX - start.x) >= 4 || Math.abs(event.clientY - start.y) >= 4) dragging = true
    if (dragging) renderDrag(event.clientX, event.clientY)
  }
  function pointerUp(event) {
    if (!start || event.pointerId !== start.pointerId) return
    event.preventDefault()
    renderDrag(event.clientX, event.clientY)
    const selection = current
    try { document.body.releasePointerCapture?.(event.pointerId) } catch {}
    if (!dragging || !selection || selection.width < ${MIN_SELECTION_SIZE} || selection.height < ${MIN_SELECTION_SIZE}) {
      reset()
      return
    }
    finish({ ...selection, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })
  }
  function pointerCancel(event) {
    if (!start || event.pointerId !== start.pointerId) return
    finish(null)
  }
  function keyDown(event) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    finish(null)
  }
  function cancel() { finish(null) }
  function preventMenu(event) { event.preventDefault(); finish(null) }

  window.addEventListener('pointerdown', pointerDown, true)
  window.addEventListener('pointermove', pointerMove, true)
  window.addEventListener('pointerup', pointerUp, true)
  window.addEventListener('pointercancel', pointerCancel, true)
  window.addEventListener('keydown', keyDown, true)
  window.addEventListener('blur', cancel, true)
  window.addEventListener('contextmenu', preventMenu, true)
}))()`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function screenshotName(now: number): string {
  const timestamp = new Date(now).toISOString().replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
  return `CoScribe-screenshot-${timestamp}.jpg`
}

function encodeScreenshot(image: NativeImage): Buffer {
  if (image.isEmpty()) throw new Error('没有获取到屏幕图像。请检查系统的屏幕录制权限。')

  const attempts = [
    { maximumWidth: 5_120, quality: 92 },
    { maximumWidth: 3_840, quality: 88 },
    { maximumWidth: 2_560, quality: 82 },
    { maximumWidth: 1_920, quality: 76 }
  ]
  for (const attempt of attempts) {
    const size = image.getSize()
    const candidate = size.width > attempt.maximumWidth
      ? image.resize({ width: attempt.maximumWidth, quality: 'best' })
      : image
    const bytes = candidate.toJPEG(attempt.quality)
    if (bytes.length > 0 && bytes.length <= MAX_CHAT_IMAGE_BYTES) return bytes
  }
  throw new Error('截图文件过大，无法加入聊天。请降低显示器分辨率后重试。')
}

async function captureDisplayImage(display: Display, captureSize: { width: number; height: number }): Promise<NativeImage> {
  for (const retryDelay of CAPTURE_RETRY_DELAYS_MS) {
    if (retryDelay > 0) await delay(retryDelay)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: captureSize,
      fetchWindowIcons: false
    })
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
    if (source && !source.thumbnail.isEmpty()) return source.thumbnail
  }
  throw new Error('没有获取到可捕获的显示器图像。请检查系统的屏幕录制权限。')
}

interface ScreenshotServiceOptions {
  platform?: NodeJS.Platform
}

export class ScreenshotService {
  private pendingCapture: Promise<ChatImageAttachment | null> | null = null
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    options: ScreenshotServiceOptions = {}
  ) {
    this.platform = options.platform ?? process.platform
  }

  capture(): Promise<ChatImageAttachment | null> {
    if (this.pendingCapture) return Promise.reject(new Error('截图正在进行，请完成当前截图后再试。'))
    const capture = this.captureOnce()
    this.pendingCapture = capture
    void capture.then(
      () => { if (this.pendingCapture === capture) this.pendingCapture = null },
      () => { if (this.pendingCapture === capture) this.pendingCapture = null }
    )
    return capture
  }

  private screenPermissionStatus(): string {
    if (this.platform !== 'darwin') return 'granted'
    try {
      return systemPreferences.getMediaAccessStatus('screen')
    } catch {
      return 'unknown'
    }
  }

  private async openMacScreenRecordingSettings(): Promise<boolean> {
    try {
      await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL)
      return true
    } catch {
      return false
    }
  }

  private macPermissionError(
    status = this.screenPermissionStatus(),
    settingsOpened = false
  ): ScreenshotPermissionError {
    const statusText = status === 'restricted'
      ? 'macOS 已限制当前 App 的屏幕录制权限。'
      : status === 'denied'
        ? 'macOS 没有把屏幕录制权限授予当前 App。'
        : status === 'not-determined'
          ? 'macOS 尚未授予当前 App 屏幕录制权限。'
          : status === 'granted'
            ? 'macOS 显示已授权，但没有向当前版本返回可用的屏幕图像。'
            : 'macOS 没有向当前版本返回可用的屏幕图像。'
    const settingsText = settingsOpened
      ? '已自动打开“系统设置 > 隐私与安全性 > 屏幕录制”，请允许 CoScribe；如果系统要求退出并重新打开，请按提示操作。'
      : '未能自动打开系统授权设置，请手动进入“系统设置 > 隐私与安全性 > 屏幕录制”并允许 CoScribe。'
    return new ScreenshotPermissionError([
      statusText,
      settingsText,
      '若列表中已有 CoScribe 但仍失败，请删除旧的 CoScribe 条目，完全退出应用，再从 Finder 打开当前 App 并重新授权。'
    ].join(' '))
  }

  private async openMacPermissionSettingsAndCreateError(
    status = this.screenPermissionStatus()
  ): Promise<ScreenshotPermissionError> {
    const settingsOpened = await this.openMacScreenRecordingSettings()
    return this.macPermissionError(status, settingsOpened)
  }

  private restoreWindowFocus(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }

  private async selectRegion(display: Display): Promise<ScreenshotSelectionSession | null> {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    overlay.setMenuBarVisibility(false)
    overlay.setAlwaysOnTop(true, 'pop-up-menu')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    let timeout: NodeJS.Timeout | null = null
    let keepOverlayOpen = false
    const closeOverlay = (): void => {
      if (!overlay.isDestroyed()) overlay.destroy()
    }
    try {
      await overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SELECTION_HTML)}`)
      overlay.webContents.on('will-navigate', (event) => event.preventDefault())
      const closed = new Promise<null>((resolve) => overlay.once('closed', () => resolve(null)))
      const selected = overlay.webContents.executeJavaScript(selectionScript(), true).catch(() => null)
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SELECTION_TIMEOUT_MS)
        timeout.unref()
      })
      overlay.show()
      overlay.focus()
      const value = await Promise.race([selected, closed, timedOut])
      if (value === null) return null
      if (!value || typeof value !== 'object') throw new Error('截图区域无效。')
      const candidate = value as Record<string, unknown>
      const fields = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'] as const
      if (!fields.every((field) => typeof candidate[field] === 'number' && Number.isFinite(candidate[field]))) {
        throw new Error('截图区域无效。')
      }
      keepOverlayOpen = true
      return {
        selection: candidate as unknown as ScreenshotSelection,
        contentBounds: overlay.getContentBounds(),
        close: closeOverlay
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (!keepOverlayOpen) closeOverlay()
    }
  }

  private async captureOnce(): Promise<ChatImageAttachment | null> {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('CoScribe 主窗口尚未就绪。')
    const windowWasFocused = window.isFocused()
    const usesAppWindowSource = process.env.COSCRIBE_E2E_SCREENSHOT_SOURCE === 'app-window'
    const initialPermissionStatus = usesAppWindowSource ? 'granted' : this.screenPermissionStatus()
    if (!usesAppWindowSource && this.platform === 'darwin' && (initialPermissionStatus === 'denied' || initialPermissionStatus === 'restricted')) {
      throw await this.openMacPermissionSettingsAndCreateError(initialPermissionStatus)
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const captureSize = {
      width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
    }
    const captureVisibleDisplay = (): Promise<NativeImage> => (
      usesAppWindowSource
        ? window.webContents.capturePage()
        : captureDisplayImage(display, captureSize)
    )

    let selectionSession: ScreenshotSelectionSession | null = null
    try {
      // Capture before showing the selector so confirming a region only crops
      // an already available image instead of waiting on desktop capture.
      let displayImage: NativeImage
      try {
        // On the first macOS request, desktopCapturer triggers the native
        // screen-recording consent prompt because askForMediaAccess does not
        // support the "screen" media type.
        displayImage = await captureVisibleDisplay()
      } catch (error) {
        if (!usesAppWindowSource && this.platform === 'darwin') {
          throw await this.openMacPermissionSettingsAndCreateError()
        }
        throw error
      }
      if (windowWasFocused && !window.isFocused()) {
        this.restoreWindowFocus(window)
        await delay(80)
        try {
          displayImage = await captureVisibleDisplay()
        } catch (error) {
          if (!usesAppWindowSource && this.platform === 'darwin') {
            throw await this.openMacPermissionSettingsAndCreateError()
          }
          throw error
        }
        if (!window.isFocused()) {
          this.restoreWindowFocus(window)
          await delay(40)
        }
      }
      if (!usesAppWindowSource && this.platform === 'darwin' && displayImage.isEmpty()) {
        throw await this.openMacPermissionSettingsAndCreateError()
      }
      selectionSession = await this.selectRegion(display)
      if (!selectionSession) return null
      const { selection } = selectionSession
      const crop = screenshotCropBoundsFromOverlay(
        selection,
        { width: selection.viewportWidth, height: selection.viewportHeight },
        selectionSession.contentBounds,
        display.bounds,
        displayImage.getSize()
      )
      const bytes = encodeScreenshot(displayImage.crop(crop))
      const now = Date.now()
      return {
        id: `screenshot-${now}-${Math.random().toString(36).slice(2, 10)}`,
        name: screenshotName(now),
        mimeType: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        size: bytes.length
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '截图失败。'
      if (error instanceof ScreenshotPermissionError) {
        throw error
      }
      const hint = this.platform === 'darwin'
        ? this.macPermissionError().message
        : this.platform === 'win32'
          ? 'Windows 用户请检查系统屏幕捕获权限、远程桌面策略或安全软件设置。'
          : '请检查桌面环境的屏幕捕获权限。'
      throw new Error(`${message} ${hint}`)
    } finally {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        if (!window.isVisible()) window.show()
        // Transfer focus back before destroying the selector so the operating
        // system never has to choose another application's window.
        if (selectionSession) window.focus()
      }
      selectionSession?.close()
      if (!window.isDestroyed()) window.focus()
    }
  }
}
