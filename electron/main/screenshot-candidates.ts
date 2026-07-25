import type { ScreenshotRegion, ScreenshotSize } from './screenshot-region'

export interface ScreenshotPixelSource extends ScreenshotSize {
  pixels: Uint8Array
}

export interface ScreenshotPoint {
  x: number
  y: number
}

export interface ScreenshotPredictionGrid {
  columns: number
  rows: number
  regions: Array<ScreenshotRegion | null>
}

export interface ScreenshotCandidateGuides {
  vertical: number[]
  horizontal: number[]
  regions: ScreenshotRegion[]
  predictionGrid: ScreenshotPredictionGrid
}

interface ScreenshotEdgeMap extends ScreenshotSize {
  vertical: Uint8Array
  horizontal: Uint8Array
  verticalColumnPrefix: Float32Array
  horizontalRowPrefix: Float32Array
}

const MAX_CONTENT_GUIDES = 16
const MIN_EDGE_SCORE = 18
const MIN_LOCAL_EDGE_SCORE = 7
const MIN_REGION_WIDTH = 16
const MIN_REGION_HEIGHT = 12
const LOCAL_BAND_CSS = 6
const LOCAL_MAX_SPAN_CSS = 720
const PREDICTION_CELL_CSS = 10
const MAX_PREDICTION_CELLS = 12_000

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validSource(source: ScreenshotPixelSource, viewport: ScreenshotSize): boolean {
  return (
    source.width > 0 &&
    source.height > 0 &&
    source.pixels.length >= source.width * source.height * 4 &&
    viewport.width > 0 &&
    viewport.height > 0
  )
}

function pixelDifference(source: ScreenshotPixelSource, offset: number, previousOffset: number): number {
  return Math.round((
    Math.abs((source.pixels[offset] ?? 0) - (source.pixels[previousOffset] ?? 0)) +
    Math.abs((source.pixels[offset + 1] ?? 0) - (source.pixels[previousOffset + 1] ?? 0)) +
    Math.abs((source.pixels[offset + 2] ?? 0) - (source.pixels[previousOffset + 2] ?? 0))
  ) / 3)
}

function createEdgeMap(source: ScreenshotPixelSource): ScreenshotEdgeMap {
  const vertical = new Uint8Array(source.width * source.height)
  const horizontal = new Uint8Array(source.width * source.height)
  const verticalColumnPrefix = new Float32Array(source.width * (source.height + 1))
  const horizontalRowPrefix = new Float32Array(source.height * (source.width + 1))

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const pixel = y * source.width + x
      const offset = pixel * 4
      if (x > 0) vertical[pixel] = pixelDifference(source, offset, offset - 4)
      if (y > 0) horizontal[pixel] = pixelDifference(source, offset, offset - source.width * 4)
      const columnOffset = x * (source.height + 1)
      verticalColumnPrefix[columnOffset + y + 1] = verticalColumnPrefix[columnOffset + y] + vertical[pixel]
      const rowOffset = y * (source.width + 1)
      horizontalRowPrefix[rowOffset + x + 1] = horizontalRowPrefix[rowOffset + x] + horizontal[pixel]
    }
  }

  return {
    width: source.width,
    height: source.height,
    vertical,
    horizontal,
    verticalColumnPrefix,
    horizontalRowPrefix
  }
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
      score += pixelDifference(source, offset, previousOffset)
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
  const minimumGap = Math.max(2, Math.round(sourceLength * 32 / Math.max(viewportLength, 1)))
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
  if (right - left < MIN_REGION_WIDTH || bottom - top < MIN_REGION_HEIGHT) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function regionKey(region: ScreenshotRegion): string {
  return [region.x, region.y, region.width, region.height].map(Math.round).join(':')
}

function localLineScore(
  map: ScreenshotEdgeMap,
  axis: number,
  cross: number,
  bandRadius: number,
  vertical: boolean
): number {
  if (vertical) {
    const top = clamp(cross - bandRadius, 0, map.height)
    const bottom = clamp(cross + bandRadius + 1, top + 1, map.height)
    const offset = axis * (map.height + 1)
    return (map.verticalColumnPrefix[offset + bottom] - map.verticalColumnPrefix[offset + top]) / (bottom - top)
  }
  const left = clamp(cross - bandRadius, 0, map.width)
  const right = clamp(cross + bandRadius + 1, left + 1, map.width)
  const offset = axis * (map.width + 1)
  return (map.horizontalRowPrefix[offset + right] - map.horizontalRowPrefix[offset + left]) / (right - left)
}

function nearbyPeaks(
  map: ScreenshotEdgeMap,
  axisPoint: number,
  crossPoint: number,
  direction: -1 | 1,
  vertical: boolean,
  bandRadius: number,
  maximumDistance: number
): number[] {
  const length = vertical ? map.width : map.height
  const peaks: number[] = []
  for (let distance = 1; distance <= maximumDistance; distance += 1) {
    const axis = axisPoint + distance * direction
    if (axis <= 0 || axis >= length) break
    const score = localLineScore(map, axis, crossPoint, bandRadius, vertical)
    if (score < MIN_LOCAL_EDGE_SCORE) continue
    const before = localLineScore(map, axis - 1, crossPoint, bandRadius, vertical)
    const after = localLineScore(map, axis + 1, crossPoint, bandRadius, vertical)
    if (score < before || score < after) continue
    peaks.push(axis)
    if (peaks.length >= 12) break
  }
  return peaks
}

function localBounds(
  map: ScreenshotEdgeMap,
  axisPoint: number,
  crossPoint: number,
  sourceLength: number,
  viewportLength: number,
  vertical: boolean
): [number, number] | null {
  const crossLength = vertical ? map.height : map.width
  const crossViewportLength = vertical ? viewportLength * map.height / map.width : viewportLength * map.width / map.height
  const bandRadius = Math.max(1, Math.round(crossLength * LOCAL_BAND_CSS / Math.max(crossViewportLength, 1)))
  const maximumDistance = Math.min(
    sourceLength - 1,
    Math.max(2, Math.round(sourceLength * LOCAL_MAX_SPAN_CSS / Math.max(viewportLength, 1)))
  )
  const minimumSize = Math.max(
    2,
    Math.round(sourceLength * (vertical ? MIN_REGION_WIDTH : MIN_REGION_HEIGHT) / Math.max(viewportLength, 1))
  )
  const left = nearbyPeaks(map, axisPoint, crossPoint, -1, vertical, bandRadius, maximumDistance)
  const right = nearbyPeaks(map, axisPoint, crossPoint, 1, vertical, bandRadius, maximumDistance)
  let best: [number, number] | null = null
  for (const start of left) {
    for (const end of right) {
      if (end - start < minimumSize) continue
      if (!best || end - start < best[1] - best[0]) best = [start, end]
    }
  }
  return best
}

function predictFromEdgeMap(
  map: ScreenshotEdgeMap,
  viewport: ScreenshotSize,
  point: ScreenshotPoint
): ScreenshotRegion | null {
  const sourceX = clamp(Math.floor(point.x * map.width / viewport.width), 0, map.width - 1)
  const sourceY = clamp(Math.floor(point.y * map.height / viewport.height), 0, map.height - 1)
  const horizontalBounds = localBounds(map, sourceX, sourceY, map.width, viewport.width, true)
  const verticalBounds = localBounds(map, sourceY, sourceX, map.height, viewport.height, false)
  if (!horizontalBounds || !verticalBounds) return null
  return normalizedRegion({
    x: Math.round(horizontalBounds[0] * viewport.width / map.width),
    y: Math.round(verticalBounds[0] * viewport.height / map.height),
    width: Math.round((horizontalBounds[1] - horizontalBounds[0]) * viewport.width / map.width),
    height: Math.round((verticalBounds[1] - verticalBounds[0]) * viewport.height / map.height)
  }, viewport)
}

export function predictScreenshotRegion(
  source: ScreenshotPixelSource,
  viewport: ScreenshotSize,
  point: ScreenshotPoint
): ScreenshotRegion | null {
  if (!validSource(source, viewport) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return predictFromEdgeMap(createEdgeMap(source), viewport, point)
}

function predictionGrid(map: ScreenshotEdgeMap, viewport: ScreenshotSize): ScreenshotPredictionGrid {
  let columns = Math.min(map.width, Math.max(1, Math.ceil(viewport.width / PREDICTION_CELL_CSS)))
  let rows = Math.min(map.height, Math.max(1, Math.ceil(viewport.height / PREDICTION_CELL_CSS)))
  const scale = Math.max(1, Math.sqrt(columns * rows / MAX_PREDICTION_CELLS))
  columns = Math.max(1, Math.floor(columns / scale))
  rows = Math.max(1, Math.floor(rows / scale))
  const regions: Array<ScreenshotRegion | null> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      regions.push(predictFromEdgeMap(map, viewport, {
        x: (column + 0.5) * viewport.width / columns,
        y: (row + 0.5) * viewport.height / rows
      }))
    }
  }
  return { columns, rows, regions }
}

export function screenshotCandidateGuides(
  source: ScreenshotPixelSource,
  viewport: ScreenshotSize,
  fixedRegions: ScreenshotRegion[] = []
): ScreenshotCandidateGuides {
  if (!validSource(source, viewport)) {
    return {
      vertical: [0, Math.max(0, viewport.width)],
      horizontal: [0, Math.max(0, viewport.height)],
      regions: [],
      predictionGrid: { columns: 0, rows: 0, regions: [] }
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
  return {
    vertical,
    horizontal,
    regions: regions.slice(0, 300),
    predictionGrid: predictionGrid(createEdgeMap(source), viewport)
  }
}
