import { describe, expect, it } from 'vitest'

import { predictScreenshotRegion, screenshotCandidateGuides } from './screenshot-candidates'

function blockedPixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const shade = x < 30 ? 20 : x < 90 ? 150 : 235
      const rowShade = y < 20 ? 0 : y < 60 ? 20 : -20
      pixels[offset] = shade + rowShade
      pixels[offset + 1] = shade + rowShade
      pixels[offset + 2] = shade + rowShade
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

function nestedPixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const shade = x >= 42 && x < 78 && y >= 28 && y < 52
        ? 220
        : x >= 10 && x < 110 && y >= 8 && y < 72
          ? 78
          : 20
      pixels[offset] = shade
      pixels[offset + 1] = shade
      pixels[offset + 2] = shade
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

function subtleNestedPixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const shade = x >= 72 && x < 88 && y >= 38 && y < 52
        ? 88
        : x >= 20 && x < 140 && y >= 10 && y < 80
          ? 80
          : 20
      pixels[offset] = shade
      pixels[offset + 1] = shade
      pixels[offset + 2] = shade
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

function fragmentedControlPixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const shade = x >= 55 && x < 105 && y >= 45 && y < 55
        ? 145
        : x >= 45 && x < 115 && y >= 35 && y < 70
          ? 130
          : x >= 35 && x < 125 && y >= 25 && y < 80
            ? 70
            : 20
      pixels[offset] = shade
      pixels[offset + 1] = shade
      pixels[offset + 2] = shade
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

describe('screenshot candidate guides', () => {
  it('detects strong content boundaries and keeps fixed window regions', () => {
    const result = screenshotCandidateGuides(
      { width: 120, height: 80, pixels: blockedPixels(120, 80) },
      { width: 1_200, height: 800 },
      [{ x: 100, y: 80, width: 900, height: 600 }]
    )

    expect(result.vertical).toEqual(expect.arrayContaining([0, 300, 900, 1_200]))
    expect(result.horizontal).toEqual(expect.arrayContaining([0, 200, 600, 800]))
    expect(result.regions).toContainEqual({ x: 100, y: 80, width: 900, height: 600 })
    expect(result.regions).toContainEqual({ x: 300, y: 200, width: 600, height: 400 })
  })

  it('falls back to display boundaries when pixel data is unavailable', () => {
    expect(screenshotCandidateGuides(
      { width: 20, height: 10, pixels: new Uint8Array() },
      { width: 1_440, height: 900 }
    )).toMatchObject({
      vertical: [0, 1_440],
      horizontal: [0, 900],
      regions: []
    })
  })

  it('predicts the smallest local content rectangle around the pointer', () => {
    const source = { width: 120, height: 80, pixels: nestedPixels(120, 80) }
    const viewport = { width: 1_200, height: 800 }

    expect(predictScreenshotRegion(source, viewport, { x: 600, y: 400 })).toEqual({
      x: 420,
      y: 280,
      width: 360,
      height: 240
    })

    const guides = screenshotCandidateGuides(source, viewport)
    expect(guides.predictionGrid.regions.some((region) => (
      region?.x === 420 && region.y === 280 && region.width === 360 && region.height === 240
    ))).toBe(true)
  })

  it('keeps low-contrast compact controls available as pointer-local candidates', () => {
    expect(predictScreenshotRegion(
      { width: 160, height: 90, pixels: subtleNestedPixels(160, 90) },
      { width: 1_600, height: 900 },
      { x: 800, y: 450 }
    )).toEqual({
      x: 720,
      y: 380,
      width: 160,
      height: 140
    })
  })

  it('prefers a coherent content container over a thin fragment at the pointer', () => {
    expect(predictScreenshotRegion(
      { width: 160, height: 100, pixels: fragmentedControlPixels(160, 100) },
      { width: 1_600, height: 1_000 },
      { x: 800, y: 500 }
    )).toEqual({
      x: 450,
      y: 350,
      width: 700,
      height: 350
    })
  })
})
