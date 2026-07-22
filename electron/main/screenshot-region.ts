export interface ScreenshotRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenshotSize {
  width: number
  height: number
}

function validSize(size: ScreenshotSize): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function screenshotCropBounds(
  selection: ScreenshotRegion,
  viewport: ScreenshotSize,
  image: ScreenshotSize
): ScreenshotRegion {
  if (!validSize(viewport) || !validSize(image) || !Object.values(selection).every(Number.isFinite)) {
    throw new Error('截图区域无效。')
  }

  const firstX = clamp(selection.x, 0, viewport.width)
  const secondX = clamp(selection.x + selection.width, 0, viewport.width)
  const firstY = clamp(selection.y, 0, viewport.height)
  const secondY = clamp(selection.y + selection.height, 0, viewport.height)
  const left = Math.min(firstX, secondX)
  const right = Math.max(firstX, secondX)
  const top = Math.min(firstY, secondY)
  const bottom = Math.max(firstY, secondY)
  if (right <= left || bottom <= top) throw new Error('截图区域无效。')

  const imageWidth = Math.max(1, Math.floor(image.width))
  const imageHeight = Math.max(1, Math.floor(image.height))
  const x = clamp(Math.floor(left * imageWidth / viewport.width), 0, imageWidth - 1)
  const y = clamp(Math.floor(top * imageHeight / viewport.height), 0, imageHeight - 1)
  const rightPixel = clamp(Math.ceil(right * imageWidth / viewport.width), x + 1, imageWidth)
  const bottomPixel = clamp(Math.ceil(bottom * imageHeight / viewport.height), y + 1, imageHeight)
  return { x, y, width: rightPixel - x, height: bottomPixel - y }
}
