import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockOverlay {
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  loadURL: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}

const electronMock = vi.hoisted(() => {
  const image: Record<string, unknown> = {}
  Object.assign(image, {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1_440, height: 900 })),
    crop: vi.fn(() => image),
    resize: vi.fn(() => image),
    toJPEG: vi.fn(() => Buffer.from('mock-jpeg'))
  })
  return {
    image,
    overlays: [] as MockOverlay[],
    getSources: vi.fn(),
    getMediaAccessStatus: vi.fn(),
    openExternal: vi.fn(),
    permissionStatus: 'granted',
    resolveSources: null as (() => void) | null,
    resolveSelection: null as ((value: unknown) => void) | null
  }
})

vi.mock('electron', () => {
  class BrowserWindow {
    private destroyed = false
    readonly destroy = vi.fn(() => { this.destroyed = true })
    readonly isDestroyed = (): boolean => this.destroyed
    readonly loadURL = vi.fn(async () => undefined)
    readonly setMenuBarVisibility = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly setVisibleOnAllWorkspaces = vi.fn()
    readonly getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 1_440, height: 900 }))
    readonly once = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(() => new Promise((resolve) => {
        electronMock.resolveSelection = resolve
      }))
    }

    constructor(_options: unknown) {
      electronMock.overlays.push(this)
    }
  }

  return {
    BrowserWindow,
    desktopCapturer: { getSources: electronMock.getSources },
    shell: { openExternal: electronMock.openExternal },
    systemPreferences: { getMediaAccessStatus: electronMock.getMediaAccessStatus },
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 200, y: 160 })),
      getDisplayNearestPoint: vi.fn(() => ({
        id: 7,
        bounds: { x: 0, y: 0, width: 1_440, height: 900 },
        size: { width: 1_440, height: 900 },
        scaleFactor: 1
      }))
    }
  }
})

import { ScreenshotService } from './screenshot'

beforeEach(() => {
  electronMock.overlays.length = 0
  electronMock.resolveSources = null
  electronMock.resolveSelection = null
  electronMock.permissionStatus = 'granted'
  electronMock.getMediaAccessStatus.mockReset()
  electronMock.getMediaAccessStatus.mockImplementation(() => electronMock.permissionStatus)
  electronMock.openExternal.mockReset()
  electronMock.openExternal.mockResolvedValue(undefined)
  electronMock.getSources.mockReset()
  electronMock.getSources.mockImplementation(() => new Promise((resolve) => {
    electronMock.resolveSources = () => resolve([{
      display_id: '7',
      thumbnail: electronMock.image
    }])
  }))
  delete process.env.COSCRIBE_E2E_SCREENSHOT_SOURCE
})

describe('ScreenshotService window lifecycle', () => {
  it('captures the display before showing the selector and returns without a post-selection wait', async () => {
    const focus = vi.fn()
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus,
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow)

    const capture = service.capture()
    await vi.waitFor(() => expect(electronMock.getSources).toHaveBeenCalledOnce())
    expect(electronMock.overlays).toHaveLength(0)

    electronMock.resolveSources?.()
    await vi.waitFor(() => expect(electronMock.overlays).toHaveLength(1))
    const overlay = electronMock.overlays[0]
    expect(overlay).toBeDefined()
    expect(overlay.destroy).not.toHaveBeenCalled()
    const loadedUrl = String(overlay.loadURL.mock.calls[0]?.[0] ?? '')
    const overlayHtml = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(',') + 1))
    expect(overlayHtml).not.toContain('id="screen"')
    expect(overlayHtml).toContain('body { background: transparent; }')
    await vi.waitFor(() => expect(overlay.show).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(electronMock.resolveSelection).not.toBeNull())
    expect(electronMock.getSources.mock.invocationCallOrder[0])
      .toBeLessThan(overlay.show.mock.invocationCallOrder[0])
    expect(electronMock.getSources).toHaveBeenCalledOnce()

    let resolved = false
    void capture.then(() => { resolved = true })
    electronMock.resolveSelection?.({
      x: 100,
      y: 80,
      width: 500,
      height: 300,
      viewportWidth: 1_440,
      viewportHeight: 900
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBe(true)

    await expect(capture).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      size: Buffer.byteLength('mock-jpeg')
    })

    expect(overlay.destroy).toHaveBeenCalledOnce()
    expect(electronMock.getSources).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledTimes(2)
    expect(focus.mock.invocationCallOrder[0])
      .toBeLessThan(overlay.destroy.mock.invocationCallOrder[0])
  })

  it('cleans up a cancelled selector without starting another display capture', async () => {
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow)

    const capture = service.capture()
    await vi.waitFor(() => expect(electronMock.getSources).toHaveBeenCalledOnce())
    electronMock.resolveSources?.()
    await vi.waitFor(() => expect(electronMock.overlays).toHaveLength(1))
    const overlay = electronMock.overlays[0]
    await vi.waitFor(() => expect(electronMock.resolveSelection).not.toBeNull())
    electronMock.resolveSelection?.(null)

    await expect(capture).resolves.toBeNull()
    expect(electronMock.getSources).toHaveBeenCalledOnce()
    expect(overlay.destroy).toHaveBeenCalledOnce()
  })

  it('opens macOS screen recording settings when permission was denied', async () => {
    electronMock.permissionStatus = 'denied'
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow, { platform: 'darwin' })

    await expect(service.capture()).rejects.toThrow(/已自动打开.*删除旧的.*完全退出.*重新授权/u)
    expect(electronMock.openExternal).toHaveBeenCalledOnce()
    expect(electronMock.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    expect(electronMock.getSources).not.toHaveBeenCalled()
    expect(electronMock.overlays).toHaveLength(0)
  })

  it('opens macOS screen recording settings when a stale grant cannot capture the display', async () => {
    electronMock.getSources.mockRejectedValueOnce(new Error('screen capture failed'))
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow, { platform: 'darwin' })

    await expect(service.capture()).rejects.toThrow(/显示已授权.*已自动打开/u)
    expect(electronMock.openExternal).toHaveBeenCalledOnce()
    expect(electronMock.overlays).toHaveLength(0)
  })

  it('restores and recaptures the original CoScribe window if macOS steals focus', async () => {
    let focused = true
    electronMock.getSources.mockImplementation(async () => {
      focused = false
      return [{ display_id: '7', thumbnail: electronMock.image }]
    })
    const focus = vi.fn(() => { focused = true })
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => focused),
      restore: vi.fn(),
      show: vi.fn(),
      focus,
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow, { platform: 'darwin' })

    const capture = service.capture()
    await vi.waitFor(() => expect(electronMock.overlays).toHaveLength(1))
    await vi.waitFor(() => expect(electronMock.resolveSelection).not.toBeNull())
    electronMock.resolveSelection?.({
      x: 100,
      y: 80,
      width: 500,
      height: 300,
      viewportWidth: 1_440,
      viewportHeight: 900
    })

    await expect(capture).resolves.toMatchObject({ mimeType: 'image/jpeg' })
    expect(electronMock.getSources).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenCalled()
    expect(focus.mock.invocationCallOrder[0])
      .toBeLessThan(electronMock.overlays[0].show.mock.invocationCallOrder[0])
  })
})
