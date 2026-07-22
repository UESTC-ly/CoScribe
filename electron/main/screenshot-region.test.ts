import { describe, expect, it } from 'vitest'

import { screenshotCropBounds } from './screenshot-region'

describe('screenshot ROI pixel mapping', () => {
  it('maps a display-space ROI to high-DPI screenshot pixels', () => {
    expect(screenshotCropBounds(
      { x: 100, y: 50, width: 400, height: 300 },
      { width: 1_440, height: 900 },
      { width: 2_880, height: 1_800 }
    )).toEqual({ x: 200, y: 100, width: 800, height: 600 })
  })

  it('normalizes reverse drags and clamps them to the selected display', () => {
    expect(screenshotCropBounds(
      { x: 500, y: 350, width: -600, height: -400 },
      { width: 800, height: 600 },
      { width: 1_600, height: 1_200 }
    )).toEqual({ x: 0, y: 0, width: 1_000, height: 700 })
  })

  it('rejects a selection with no pixels inside the display', () => {
    expect(() => screenshotCropBounds(
      { x: 900, y: 100, width: 20, height: 20 },
      { width: 800, height: 600 },
      { width: 1_600, height: 1_200 }
    )).toThrow('截图区域无效')
  })
})
