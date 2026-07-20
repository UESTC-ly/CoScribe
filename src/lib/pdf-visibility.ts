export interface PdfPageVisibility {
  page: number
  /** IntersectionObserver ratio in the range 0..1. */
  visibleRatio?: number
  /** Visible area in CSS pixels; preferred over ratio when available. */
  visiblePixels?: number
  /** Absolute distance between page and viewport centers in CSS pixels. */
  distanceToViewportCenter?: number
}

export interface PdfVisibilitySelection {
  primaryPage: number | null
  visiblePages: number[]
}

export interface PdfVisibilityOptions {
  previousPage?: number
  /** Retain the previous page when its visibility is within this ratio of the leader. */
  hysteresis?: number
}

interface RankedVisibility extends PdfPageVisibility {
  ratio: number
  pixels: number | null
  distance: number
}

function ranked(entry: PdfPageVisibility): RankedVisibility | null {
  if (!Number.isInteger(entry.page) || entry.page < 1) return null
  const ratio = Number.isFinite(entry.visibleRatio)
    ? Math.max(0, Math.min(1, entry.visibleRatio ?? 0))
    : 0
  const pixels = Number.isFinite(entry.visiblePixels)
    ? Math.max(0, entry.visiblePixels ?? 0)
    : null
  if (ratio <= 0 && (pixels === null || pixels <= 0)) return null
  return {
    ...entry,
    ratio,
    pixels,
    distance: Number.isFinite(entry.distanceToViewportCenter)
      ? Math.max(0, entry.distanceToViewportCenter ?? 0)
      : Number.POSITIVE_INFINITY
  }
}

function compareVisibility(left: RankedVisibility, right: RankedVisibility): number {
  if (left.pixels !== null || right.pixels !== null) {
    const pixelDifference = (right.pixels ?? 0) - (left.pixels ?? 0)
    if (pixelDifference !== 0) return pixelDifference
  }
  if (right.ratio !== left.ratio) return right.ratio - left.ratio
  if (left.distance !== right.distance) return left.distance - right.distance
  return left.page - right.page
}

function visibilityFraction(entry: RankedVisibility, leader: RankedVisibility): number {
  if (entry.pixels !== null && leader.pixels !== null && leader.pixels > 0) {
    return entry.pixels / leader.pixels
  }
  return leader.ratio > 0 ? entry.ratio / leader.ratio : 0
}

/**
 * Selects the page with the largest visible area. Center distance and page
 * number are deterministic tie breakers. The full visible page list is kept
 * so callers can fetch necessary adjacent context without treating it as the
 * primary page.
 */
export function choosePdfVisiblePages(
  entries: readonly PdfPageVisibility[],
  options: PdfVisibilityOptions = {}
): PdfVisibilitySelection {
  const byPage = new Map<number, RankedVisibility>()
  for (const value of entries) {
    const entry = ranked(value)
    if (!entry) continue
    const existing = byPage.get(entry.page)
    if (!existing || compareVisibility(entry, existing) < 0) byPage.set(entry.page, entry)
  }

  const visible = [...byPage.values()]
  if (visible.length === 0) return { primaryPage: null, visiblePages: [] }
  visible.sort(compareVisibility)
  let primary = visible[0]

  if (options.previousPage !== undefined && (options.hysteresis ?? 0) > 0) {
    const previous = byPage.get(options.previousPage)
    if (
      previous &&
      visibilityFraction(previous, primary) >= 1 - Math.max(0, Math.min(1, options.hysteresis ?? 0))
    ) {
      primary = previous
    }
  }

  return {
    primaryPage: primary.page,
    visiblePages: [...byPage.keys()].sort((left, right) => left - right)
  }
}

export function selectPrimaryVisiblePdfPage(entries: readonly PdfPageVisibility[]): number | null {
  return choosePdfVisiblePages(entries).primaryPage
}

export const selectPrimaryVisiblePage = selectPrimaryVisiblePdfPage
