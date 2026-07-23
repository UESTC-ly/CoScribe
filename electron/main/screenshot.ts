import { BrowserWindow, desktopCapturer, screen, type Display, type NativeImage } from 'electron'

import { MAX_CHAT_IMAGE_BYTES } from '../../src/shared/chat-images'
import type { ChatImageAttachment } from '../../src/shared/types'
import { screenshotCropBounds, type ScreenshotRegion } from './screenshot-region'

const CAPTURE_RETRY_DELAYS_MS = [0, 140, 320] as const
const MIN_SELECTION_SIZE = 8
const SELECTION_TIMEOUT_MS = 5 * 60 * 1_000

interface ScreenshotSelection extends ScreenshotRegion {
  viewportWidth: number
  viewportHeight: number
}

const SELECTION_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; cursor: crosshair; user-select: none; -webkit-app-region: no-drag; }
    body { background: #111318; }
    #screen { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
    #shade { position: fixed; inset: 0; background: rgba(8, 10, 14, 0.34); }
    #selection { position: fixed; display: none; border: 2px solid rgba(255, 255, 255, 0.96); background: rgba(255, 255, 255, 0.04); box-shadow: 0 0 0 100vmax rgba(8, 10, 14, 0.42); }
    #selection.active { display: block; }
    #size { position: absolute; left: 6px; top: 6px; padding: 3px 6px; color: white; background: rgba(20, 22, 27, 0.82); border-radius: 4px; font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; white-space: nowrap; }
  </style>
</head>
<body>
  <img id="screen" alt="" draggable="false">
  <div id="shade"></div>
  <div id="selection"><span id="size"></span></div>
</body>
</html>`

const SELECTION_SCRIPT = `(() => new Promise((resolve) => {
  const shade = document.getElementById('shade')
  const box = document.getElementById('selection')
  const size = document.getElementById('size')
  let start = null
  let current = null
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
    resolve(value)
  }
  const render = (clientX, clientY) => {
    if (!start) return
    const endX = clamp(clientX, window.innerWidth)
    const endY = clamp(clientY, window.innerHeight)
    const x = Math.min(start.x, endX)
    const y = Math.min(start.y, endY)
    const width = Math.abs(endX - start.x)
    const height = Math.abs(endY - start.y)
    current = { x, y, width, height }
    box.style.left = x + 'px'
    box.style.top = y + 'px'
    box.style.width = width + 'px'
    box.style.height = height + 'px'
    size.textContent = Math.round(width) + ' × ' + Math.round(height)
  }
  const reset = () => {
    start = null
    current = null
    box.classList.remove('active')
    shade.style.display = 'block'
  }
  function pointerDown(event) {
    if (event.button !== 0) return
    event.preventDefault()
    start = {
      x: clamp(event.clientX, window.innerWidth),
      y: clamp(event.clientY, window.innerHeight),
      pointerId: event.pointerId
    }
    try { document.body.setPointerCapture?.(event.pointerId) } catch {}
    shade.style.display = 'none'
    box.classList.add('active')
    render(event.clientX, event.clientY)
  }
  function pointerMove(event) {
    if (!start || event.pointerId !== start.pointerId) return
    event.preventDefault()
    render(event.clientX, event.clientY)
  }
  function pointerUp(event) {
    if (!start || event.pointerId !== start.pointerId) return
    event.preventDefault()
    render(event.clientX, event.clientY)
    try { document.body.releasePointerCapture?.(event.pointerId) } catch {}
    if (!current || current.width < ${MIN_SELECTION_SIZE} || current.height < ${MIN_SELECTION_SIZE}) {
      reset()
      return
    }
    finish({ ...current, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })
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
  function preventMenu(event) { event.preventDefault() }

  window.addEventListener('pointerdown', pointerDown, true)
  window.addEventListener('pointermove', pointerMove, true)
  window.addEventListener('pointerup', pointerUp, true)
  window.addEventListener('pointercancel', pointerCancel, true)
  window.addEventListener('keydown', keyDown, true)
  window.addEventListener('blur', cancel, true)
  window.addEventListener('contextmenu', preventMenu, true)
}))()`

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

function screenshotPreviewDataUrl(image: NativeImage, display: Display): string {
  if (image.isEmpty()) throw new Error('没有获取到屏幕预览。请检查系统的屏幕录制权限。')
  const width = Math.max(1, Math.round(display.bounds.width))
  const height = Math.max(1, Math.round(display.bounds.height))
  const preview = image.resize({ width, height, quality: 'good' })
  const bytes = preview.toJPEG(86)
  if (!bytes.length) throw new Error('无法生成截图选区预览。')
  return `data:image/jpeg;base64,${bytes.toString('base64')}`
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

export class ScreenshotService {
  private pendingCapture: Promise<ChatImageAttachment | null> | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

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

  private async selectRegion(display: Display, previewDataUrl: string): Promise<ScreenshotSelection | null> {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#111318',
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
    try {
      await overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SELECTION_HTML)}`)
      overlay.webContents.on('will-navigate', (event) => event.preventDefault())
      await overlay.webContents.executeJavaScript(`(() => {
        const image = document.getElementById('screen')
        image.src = ${JSON.stringify(previewDataUrl)}
        return image.decode()
      })()`, true)
      const closed = new Promise<null>((resolve) => overlay.once('closed', () => resolve(null)))
      const selected = overlay.webContents.executeJavaScript(SELECTION_SCRIPT, true).catch(() => null)
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
      return candidate as unknown as ScreenshotSelection
    } finally {
      if (timeout) clearTimeout(timeout)
      if (!overlay.isDestroyed()) overlay.destroy()
    }
  }

  private async captureOnce(): Promise<ChatImageAttachment | null> {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('CoScribe 主窗口尚未就绪。')

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const captureSize = {
      width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
    }
    // Capture the visible display before opening the selector. This preserves
    // the current note in the screenshot and prevents the selector itself from
    // appearing in the captured pixels.
    const displayImage = process.env.COSCRIBE_E2E_SCREENSHOT_SOURCE === 'app-window'
      ? await window.webContents.capturePage()
      : await captureDisplayImage(display, captureSize)

    try {
      const selection = await this.selectRegion(display, screenshotPreviewDataUrl(displayImage, display))
      if (!selection) return null
      const crop = screenshotCropBounds(
        selection,
        { width: selection.viewportWidth, height: selection.viewportHeight },
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
      const hint = process.platform === 'darwin'
        ? 'macOS 用户请在“系统设置 > 隐私与安全性 > 屏幕录制”中允许 CoScribe。'
        : process.platform === 'win32'
          ? 'Windows 用户请检查系统屏幕捕获权限、远程桌面策略或安全软件设置。'
          : '请检查桌面环境的屏幕捕获权限。'
      throw new Error(`${message} ${hint}`)
    } finally {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        if (!window.isVisible()) window.show()
        window.focus()
      }
    }
  }
}
