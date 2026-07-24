import { describe, expect, it } from 'vitest'

import { screenshotCandidateGuides } from './screenshot-candidates'

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
    )).toEqual({
      vertical: [0, 1_440],
      horizontal: [0, 900],
      regions: []
    })
  })
})
