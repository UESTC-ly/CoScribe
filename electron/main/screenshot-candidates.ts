import type { ScreenshotRegion, ScreenshotSize } from './screenshot-region'

export interface ScreenshotPixelSource extends ScreenshotSize {
  pixels: Uint8Array
}

export interface ScreenshotCandidateGuides {
  vertical: number[]
  horizontal: number[]
  regions: ScreenshotRegion[]
}

const MAX_CONTENT_GUIDES = 8
const MIN_EDGE_SCORE = 18

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function edgeScores(source: ScreenshotPixelSource, vertical: boolean): number[] {
  const length = vertical ? source.width : source.height
  const crossLength = vertical ? source.height : source.width
  const scores = Array.from({ length }, () => 0)
  const crossStep = Math.max(1, Math.floor(crossLength / 180))
  for (let axis = 1; axis < length; axis += 1) {
    let score = 0
    let samples = 0
    for (let cross = 0; cross < crossLength; cross += crossStep) {
      const x = vertical ? axis : cross
      const y = vertical ? cross : axis
      const previousX = vertical ? axis - 1 : cross
      const previousY = vertical ? cross : axis - 1
      const offset = (y * source.width + x) * 4
      const previousOffset = (previousY * source.width + previousX) * 4
      score += (
        Math.abs((source.pixels[offset] ?? 0) - (source.pixels[previousOffset] ?? 0)) +
        Math.abs((source.pixels[offset + 1] ?? 0) - (source.pixels[previousOffset + 1] ?? 0)) +
        Math.abs((source.pixels[offset + 2] ?? 0) - (source.pixels[previousOffset + 2] ?? 0))
      ) / 3
      samples += 1
    }
    scores[axis] = samples ? score / samples : 0
  }
  return scores
}

function strongestGuides(scores: number[], sourceLength: number, viewportLength: number): number[] {
  const sortedScores = scores.slice(1).sort((left, right) => left - right)
  const percentile = sortedScores[Math.floor(sortedScores.length * 0.86)] ?? 0
  const threshold = Math.max(MIN_EDGE_SCORE, percentile)
  const minimumGap = Math.max(2, Math.round(sourceLength * 48 / Math.max(viewportLength, 1)))
  const peaks = scores
    .map((score, index) => ({ score, index }))
    .filter(({ score, index }) => index > 0 && index < sourceLength - 1 && score >= threshold)
    .sort((left, right) => right.score - left.score)
  const selected: number[] = []
  for (const peak of peaks) {
    if (selected.some((value) => Math.abs(value - peak.index) < minimumGap)) continue
    selected.push(peak.index)
    if (selected.length >= MAX_CONTENT_GUIDES) break
  }
  return selected
    .map((value) => Math.round(value * viewportLength / sourceLength))
    .sort((left, right) => left - right)
}

function normalizedRegion(region: ScreenshotRegion, viewport: ScreenshotSize): ScreenshotRegion | null {
  const left = clamp(Math.min(region.x, region.x + region.width), 0, viewport.width)
  const right = clamp(Math.max(region.x, region.x + region.width), 0, viewport.width)
  const top = clamp(Math.min(region.y, region.y + region.height), 0, viewport.height)
  const bottom = clamp(Math.max(region.y, region.y + region.height), 0, viewport.height)
  if (right - left < 40 || bottom - top < 30) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function regionKey(region: ScreenshotRegion): string {
  return [region.x, region.y, region.width, region.height].map(Math.round).join(':')
}

export function screenshotCandidateGuides(
  source: ScreenshotPixelSource,
  viewport: ScreenshotSize,
  fixedRegions: ScreenshotRegion[] = []
): ScreenshotCandidateGuides {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    source.pixels.length < source.width * source.height * 4 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      vertical: [0, Math.max(0, viewport.width)],
      horizontal: [0, Math.max(0, viewport.height)],
      regions: []
    }
  }

  const vertical = [...new Set([
    0,
    ...strongestGuides(edgeScores(source, true), source.width, viewport.width),
    Math.round(viewport.width)
  ])].sort((left, right) => left - right)
  const horizontal = [...new Set([
    0,
    ...strongestGuides(edgeScores(source, false), source.height, viewport.height),
    Math.round(viewport.height)
  ])].sort((left, right) => left - right)
  const regions: ScreenshotRegion[] = []
  const keys = new Set<string>()
  const add = (candidate: ScreenshotRegion): void => {
    const region = normalizedRegion(candidate, viewport)
    if (!region) return
    const key = regionKey(region)
    if (keys.has(key)) return
    keys.add(key)
    regions.push(region)
  }

  for (const region of fixedRegions) add(region)
  for (let x = 0; x < vertical.length - 1; x += 1) {
    for (let y = 0; y < horizontal.length - 1; y += 1) {
      add({
        x: vertical[x],
        y: horizontal[y],
        width: vertical[x + 1] - vertical[x],
        height: horizontal[y + 1] - horizontal[y]
      })
    }
  }
  add({ x: 0, y: 0, width: viewport.width, height: viewport.height })
  regions.sort((left, right) => left.width * left.height - right.width * right.height)
  return { vertical, horizontal, regions: regions.slice(0, 100) }
}
