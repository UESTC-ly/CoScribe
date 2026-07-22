import { desktopCapturer, screen, type BrowserWindow, type NativeImage } from 'electron'

import { MAX_CHAT_IMAGE_BYTES } from '../../src/shared/chat-images'
import type { ChatImageAttachment } from '../../src/shared/types'

const CAPTURE_SETTLE_MS = 180

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

export class ScreenshotService {
  private pendingCapture: Promise<ChatImageAttachment> | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  capture(): Promise<ChatImageAttachment> {
    if (this.pendingCapture) return Promise.reject(new Error('截图正在进行，请完成当前截图后再试。'))
    const capture = this.captureOnce()
    this.pendingCapture = capture
    void capture.then(
      () => { if (this.pendingCapture === capture) this.pendingCapture = null },
      () => { if (this.pendingCapture === capture) this.pendingCapture = null }
    )
    return capture
  }

  private async captureOnce(): Promise<ChatImageAttachment> {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('CoScribe 主窗口尚未就绪。')

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const captureSize = {
      width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
    }

    window.hide()
    try {
      await delay(CAPTURE_SETTLE_MS)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: captureSize,
        fetchWindowIcons: false
      })
      const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
      if (!source) throw new Error('没有找到可捕获的显示器。请检查系统的屏幕录制权限。')
      const bytes = encodeScreenshot(source.thumbnail)
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
        window.show()
        window.focus()
      }
    }
  }
}
