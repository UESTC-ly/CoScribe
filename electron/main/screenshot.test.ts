import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockOverlay {
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
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
    resolveSources: null as (() => void) | null
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
    readonly once = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => ({
        x: 100,
        y: 80,
        width: 500,
        height: 300,
        viewportWidth: 1_440,
        viewportHeight: 900
      }))
    }

    constructor(_options: unknown) {
      electronMock.overlays.push(this)
    }
  }

  return {
    BrowserWindow,
    desktopCapturer: { getSources: electronMock.getSources },
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
  it('keeps the focused selector alive until the first native screen capture finishes', async () => {
    const focus = vi.fn()
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus,
      webContents: { capturePage: vi.fn() }
    } as unknown as Electron.BrowserWindow
    const service = new ScreenshotService(() => mainWindow)

    const capture = service.capture()
    await vi.waitFor(() => expect(electronMock.getSources).toHaveBeenCalledOnce())
    const overlay = electronMock.overlays[0]
    expect(overlay).toBeDefined()
    expect(overlay.destroy).not.toHaveBeenCalled()

    electronMock.resolveSources?.()
    await expect(capture).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      size: Buffer.byteLength('mock-jpeg')
    })

    expect(overlay.destroy).toHaveBeenCalledOnce()
    expect(electronMock.getSources.mock.invocationCallOrder[0])
      .toBeLessThan(overlay.destroy.mock.invocationCallOrder[0])
    expect(focus).toHaveBeenCalledTimes(2)
    expect(focus.mock.invocationCallOrder[0])
      .toBeLessThan(overlay.destroy.mock.invocationCallOrder[0])
  })
})
